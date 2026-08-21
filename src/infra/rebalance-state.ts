/**
 * 自动再平衡计划的原子状态持久化与进程锁。
 * 核心功能：将 dock 前 API 快照和 dock 后钱包资金快照分阶段持久化，支持中断后确定性恢复同一份 ship。
 * 主要流程：取得独占锁 -> 读取并迁移严格状态 -> 原子替换写入 -> 退出时释放锁。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";

export type PlanStage = "PLAN_PERSISTED" | "DOCK_SENT" | "DOCK_VERIFIED" | "SHIP_PREPARED" | "SHIP_SENT" | "ACTIVE_LATEST" | "BLOCKED";
export type ShipFundingSource = "WALLET_SNAPSHOT" | "LEGACY_API_SNAPSHOT";

/** API 决策字段始终存在；新策略资金字段只有在 SHIP_PREPARED 后才允许写入。 */
export interface PersistedPlan {
  logicalPositionKey: string;
  sourceStrategyHash: string;
  sourceStrategyBytes: string;
  sourceApp: string;
  tokens: [string, string];
  sourceCurrentRaw: [string, string];
  targetMode: "upper" | "lower" | "two-sided";
  targetSqrtPriceMin: string;
  targetSqrtPriceMax: string;
  fee: string;
  decisionReason: string;
  createdAt: number;
  updatedAt: number;
  stage: PlanStage;
  walletBalancesRaw?: [string, string];
  targetAmountsRaw?: [string, string];
  walletSnapshotAt?: number;
  salt?: string;
  shipStrategyHash?: string;
  shipFundingSource?: ShipFundingSource;
  dockTransactionHash?: string;
  shipTransactionHash?: string;
  blockedReason?: string;
  /** 触发此计划的配置槽位；缺口补仓只使用该关联，不约束动态重挂模式。 */
  configuredPositionId?: string;
}

export interface RebalanceObservation { strategyHash: string; breachCount: number; lastShipAt?: number; }
export interface ConfiguredPositionSlot {
  /** 最近一次成功 ship 的 strategyHash；API 索引延迟期间仍保留该关联，避免重复补仓。 */
  strategyHash?: string;
  updatedAt: number;
}

export interface StateDocument { version: 4; plans: Record<string, PersistedPlan>; observations: Record<string, RebalanceObservation>; configuredSlots: Record<string, ConfiguredPositionSlot>; }

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function text(plan: Record<string, unknown>, key: string, field: string): string {
  if (typeof plan[key] !== "string" || plan[key] === "") throw new Error(`${field}.${key} 无效`);
  return plan[key] as string;
}

function rawPair(value: unknown, field: string): [string, string] {
  if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "string" || !/^(?:0|[1-9]\d*)$/.test(item))) {
    throw new Error(`${field} 必须是两个非负 raw 字符串`);
  }
  return value as [string, string];
}

function optionalRawPair(plan: Record<string, unknown>, key: string, field: string): [string, string] | undefined {
  return plan[key] === undefined ? undefined : rawPair(plan[key], `${field}.${key}`);
}

/** 读取计划的公共字段；后续由版本和阶段规则验证资金冻结字段是否可用。 */
function parsePlan(value: unknown, key: string): PersistedPlan {
  const plan = record(value, `状态计划 ${key}`);
  const tokens = plan.tokens;
  if (!Array.isArray(tokens) || tokens.length !== 2 || tokens.some((item) => typeof item !== "string" || item === "")) throw new Error(`状态计划 ${key}.tokens 无效`);
  const mode = text(plan, "targetMode", `状态计划 ${key}`);
  if (mode !== "upper" && mode !== "lower" && mode !== "two-sided") throw new Error(`状态计划 ${key}.targetMode 无效`);
  const stage = text(plan, "stage", `状态计划 ${key}`);
  if (!["PLAN_PERSISTED", "DOCK_SENT", "DOCK_VERIFIED", "SHIP_PREPARED", "SHIP_SENT", "ACTIVE_LATEST", "BLOCKED"].includes(stage)) throw new Error(`状态计划 ${key}.stage 无效`);
  const createdAt = plan.createdAt;
  const updatedAt = plan.updatedAt;
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(updatedAt)) throw new Error(`状态计划 ${key} 时间戳无效`);
  const targetSqrtPriceMin = text(plan, "targetSqrtPriceMin", `状态计划 ${key}`);
  const targetSqrtPriceMax = text(plan, "targetSqrtPriceMax", `状态计划 ${key}`);
  if (!/^(?:0|[1-9]\d*)$/.test(targetSqrtPriceMin) || !/^(?:0|[1-9]\d*)$/.test(targetSqrtPriceMax) || BigInt(targetSqrtPriceMin) <= 0n || BigInt(targetSqrtPriceMin) >= BigInt(targetSqrtPriceMax)) {
    throw new Error(`状态计划 ${key}.targetSqrtPrice 区间无效`);
  }
  const funding = plan.shipFundingSource;
  if (funding !== undefined && funding !== "WALLET_SNAPSHOT" && funding !== "LEGACY_API_SNAPSHOT") throw new Error(`状态计划 ${key}.shipFundingSource 无效`);
  const walletSnapshotAt = plan.walletSnapshotAt;
  if (walletSnapshotAt !== undefined && !Number.isSafeInteger(walletSnapshotAt)) throw new Error(`状态计划 ${key}.walletSnapshotAt 无效`);
  const salt = plan.salt === undefined ? undefined : text(plan, "salt", `状态计划 ${key}`);
  if (salt !== undefined && !/^(?:0|[1-9]\d*)$/.test(salt)) throw new Error(`状态计划 ${key}.salt 必须是非负整数字符串`);
  return {
    logicalPositionKey: text(plan, "logicalPositionKey", `状态计划 ${key}`),
    sourceStrategyHash: text(plan, "sourceStrategyHash", `状态计划 ${key}`),
    sourceStrategyBytes: text(plan, "sourceStrategyBytes", `状态计划 ${key}`),
    sourceApp: text(plan, "sourceApp", `状态计划 ${key}`),
    tokens: tokens as [string, string],
    sourceCurrentRaw: rawPair(plan.sourceCurrentRaw, `状态计划 ${key}.sourceCurrentRaw`),
    targetMode: mode,
    targetSqrtPriceMin,
    targetSqrtPriceMax,
    fee: text(plan, "fee", `状态计划 ${key}`),
    decisionReason: text(plan, "decisionReason", `状态计划 ${key}`),
    createdAt: createdAt as number,
    updatedAt: updatedAt as number,
    stage: stage as PlanStage,
    ...(optionalRawPair(plan, "walletBalancesRaw", `状态计划 ${key}`) ? { walletBalancesRaw: optionalRawPair(plan, "walletBalancesRaw", `状态计划 ${key}`) } : {}),
    ...(optionalRawPair(plan, "targetAmountsRaw", `状态计划 ${key}`) ? { targetAmountsRaw: optionalRawPair(plan, "targetAmountsRaw", `状态计划 ${key}`) } : {}),
    ...(walletSnapshotAt === undefined ? {} : { walletSnapshotAt: walletSnapshotAt as number }),
    ...(salt === undefined ? {} : { salt }),
    ...(typeof plan.shipStrategyHash === "string" ? { shipStrategyHash: plan.shipStrategyHash } : {}),
    ...(funding === undefined ? {} : { shipFundingSource: funding as ShipFundingSource }),
    ...(typeof plan.dockTransactionHash === "string" ? { dockTransactionHash: plan.dockTransactionHash } : {}),
    ...(typeof plan.shipTransactionHash === "string" ? { shipTransactionHash: plan.shipTransactionHash } : {}),
    ...(typeof plan.blockedReason === "string" ? { blockedReason: plan.blockedReason } : {}),
    ...(typeof plan.configuredPositionId === "string" ? { configuredPositionId: plan.configuredPositionId } : {}),
  };
}

/** 按模式验证 post-dock 钱包快照与最终 ship 金额的关系，避免状态文件被改写后扩大或切换资金方向。 */
function validateWalletFundedAmounts(plan: PersistedPlan, key: string): void {
  if (!plan.walletBalancesRaw || !plan.targetAmountsRaw || plan.walletSnapshotAt === undefined || plan.salt === undefined || !plan.shipStrategyHash || plan.shipFundingSource !== "WALLET_SNAPSHOT") {
    throw new Error(`状态计划 ${key} 缺少 post-dock 钱包资金冻结字段`);
  }
  const wallet = plan.walletBalancesRaw.map(BigInt) as [bigint, bigint];
  const target = plan.targetAmountsRaw.map(BigInt) as [bigint, bigint];
  if (plan.targetMode === "upper" && (target[0] <= 0n || target[0] !== wallet[0] || target[1] !== 0n)) throw new Error(`状态计划 ${key} upper 钱包资金快照与投入额不一致`);
  if (plan.targetMode === "lower" && (target[0] !== 0n || target[1] <= 0n || target[1] !== wallet[1])) throw new Error(`状态计划 ${key} lower 钱包资金快照与投入额不一致`);
  if (plan.targetMode === "two-sided" && (target[0] <= 0n || target[1] <= 0n || target[0] !== wallet[0] || target[1] !== wallet[1])) throw new Error(`状态计划 ${key} two-sided 钱包资金快照与投入额不一致`);
}

/** 阶段校验防止 dock 前 API 快照被误用成新策略资金，或已冻结 ship 在恢复时被改写；DOCK_SENT 无 hash 允许由运行时按链上状态判断是否为广播前失败。 */
function validateV3Plan(plan: PersistedPlan, key: string): PersistedPlan {
  const preShip = ["PLAN_PERSISTED", "DOCK_SENT", "DOCK_VERIFIED"] as const;
  if (preShip.includes(plan.stage as typeof preShip[number])) {
    if (plan.walletBalancesRaw || plan.targetAmountsRaw || plan.walletSnapshotAt !== undefined || plan.salt || plan.shipStrategyHash || plan.shipFundingSource || plan.shipTransactionHash) {
      throw new Error(`状态计划 ${key} 在 ${plan.stage} 阶段不应包含 ship 资金冻结字段`);
    }
  }
  if (plan.stage === "SHIP_PREPARED" && plan.shipTransactionHash) throw new Error(`状态计划 ${key} 在 SHIP_PREPARED 阶段不应包含 shipTransactionHash`);
  if (["SHIP_PREPARED", "SHIP_SENT", "ACTIVE_LATEST"].includes(plan.stage)) {
    if (plan.shipFundingSource === "LEGACY_API_SNAPSHOT") {
      if (plan.stage === "SHIP_PREPARED" || !plan.targetAmountsRaw || !plan.salt || !plan.shipStrategyHash) throw new Error(`状态计划 ${key} 旧版资金字段不完整`);
    } else {
      validateWalletFundedAmounts(plan, key);
    }
  }
  return plan;
}

/** 将 v2 的未发 ship 计划清除旧 API 投入额；已发 ship 保持原 hash，避免升级后创建第二个策略。 */
function migrateV2Plan(plan: PersistedPlan): PersistedPlan {
  if (["PLAN_PERSISTED", "DOCK_SENT", "DOCK_VERIFIED"].includes(plan.stage)) {
    const { walletBalancesRaw: _wallet, targetAmountsRaw: _target, walletSnapshotAt: _snapshotAt, salt: _salt, shipStrategyHash: _hash, shipFundingSource: _funding, shipTransactionHash: _shipTransactionHash, ...decisionPlan } = plan;
    return decisionPlan;
  }
  if (["SHIP_SENT", "ACTIVE_LATEST"].includes(plan.stage)) return { ...plan, shipFundingSource: "LEGACY_API_SNAPSHOT" };
  return plan;
}

function parseObservations(value: unknown): Record<string, RebalanceObservation> {
  const root = record(value, "状态 observations");
  const observations: Record<string, RebalanceObservation> = {};
  for (const [key, value] of Object.entries(root)) {
    const item = record(value, `状态观测 ${key}`);
    if (typeof item.strategyHash !== "string" || !Number.isSafeInteger(item.breachCount) || (item.breachCount as number) < 0 || (item.lastShipAt !== undefined && !Number.isSafeInteger(item.lastShipAt))) throw new Error(`状态观测 ${key} 无效`);
    observations[key] = { strategyHash: item.strategyHash, breachCount: item.breachCount as number, ...(item.lastShipAt === undefined ? {} : { lastShipAt: item.lastShipAt as number }) };
  }
  return observations;
}

/** 读取严格状态；v2 在任何恢复动作前原子升级为 v3，v1 rawPrice 状态始终拒绝。 */
export function loadRebalanceState(path: string): StateDocument {
  if (!existsSync(path)) return { version: 4, plans: {}, observations: {}, configuredSlots: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`状态文件无法解析：${path}`); }
  const root = record(parsed, "状态文件根节点");
  if (root.version === 1) throw new Error("状态文件为 v1 rawPrice 格式，无法安全恢复 mixed-decimals 计划；请人工核对后归档该 state 文件");
  if ((root.version !== 2 && root.version !== 3 && root.version !== 4) || typeof root.plans !== "object" || root.plans === null || Array.isArray(root.plans) || typeof root.observations !== "object" || root.observations === null || Array.isArray(root.observations)) {
    throw new Error("状态文件版本、plans 或 observations 无效");
  }
  const rawPlans = root.plans as Record<string, unknown>;
  const plans: Record<string, PersistedPlan> = {};
  for (const [key, value] of Object.entries(rawPlans)) {
    const parsedPlan = parsePlan(value, key);
    plans[key] = validateV3Plan(root.version === 2 ? migrateV2Plan(parsedPlan) : parsedPlan, key);
  }
  const configuredSlots: Record<string, ConfiguredPositionSlot> = {};
  if (root.configuredSlots !== undefined) {
    const rawSlots = record(root.configuredSlots, "状态 configuredSlots");
    for (const [slotId, value] of Object.entries(rawSlots)) {
      const slot = record(value, `状态配置仓位 ${slotId}`);
      if (slot.strategyHash !== undefined && (typeof slot.strategyHash !== "string" || slot.strategyHash === "")) throw new Error(`状态配置仓位 ${slotId}.strategyHash 无效`);
      if (!Number.isSafeInteger(slot.updatedAt) || (slot.updatedAt as number) < 0) throw new Error(`状态配置仓位 ${slotId}.updatedAt 无效`);
      configuredSlots[slotId] = { ...(slot.strategyHash === undefined ? {} : { strategyHash: slot.strategyHash as string }), updatedAt: slot.updatedAt as number };
    }
  }
  const state: StateDocument = { version: 4, plans, observations: parseObservations(root.observations), configuredSlots };
  if (root.version === 2 || root.version === 3) saveRebalanceState(path, state);
  return state;
}

/** 使用临时文件、fsync 与 rename 防止进程被中断时留下半个 JSON。 */
export function saveRebalanceState(path: string, state: StateDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = openSync(temporary, "w", 0o600);
  try { writeFileSync(handle, `${JSON.stringify(state, null, 2)}\n`, "utf8"); fsyncSync(handle); } finally { closeSync(handle); }
  renameSync(temporary, path);
}

/** 同一 stateFile 同时只允许一个 Bot 进程，避免双重 dock 或 nonce 竞争。 */
export function acquireRebalanceLock(stateFile: string): () => void {
  const lockPath = `${stateFile}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let handle: number;
  try { handle = openSync(lockPath, "wx", 0o600); } catch { throw new Error(`另一个 rebalance-bot 正在运行：${lockPath}`); }
  return () => { try { closeSync(handle); } finally { if (existsSync(lockPath)) unlinkSync(lockPath); } };
}
