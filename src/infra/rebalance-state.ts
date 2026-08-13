/**
 * 自动再平衡计划的原子状态持久化与进程锁。
 * 核心功能：每个逻辑仓位只保留一份最新计划，并在 dock 与 ship 两笔交易之间支持安全恢复。
 * 主要流程：取得独占锁 -> 读取严格 JSON 状态 -> 原子替换写入 -> 退出时释放锁。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";

export type PlanStage = "PLAN_PERSISTED" | "DOCK_SENT" | "DOCK_VERIFIED" | "SHIP_SENT" | "ACTIVE_LATEST" | "BLOCKED";
export interface PersistedPlan {
  logicalPositionKey: string;
  sourceStrategyHash: string;
  sourceStrategyBytes: string;
  sourceApp: string;
  tokens: [string, string];
  sourceCurrentRaw: [string, string];
  targetMode: "upper" | "lower" | "two-sided";
  targetAmountsRaw: [string, string];
  targetRawPriceMin: string;
  targetRawPriceMax: string;
  fee: string;
  salt: string;
  shipStrategyHash: string;
  decisionReason: string;
  createdAt: number;
  updatedAt: number;
  stage: PlanStage;
  dockTransactionHash?: string;
  shipTransactionHash?: string;
  blockedReason?: string;
}
export interface RebalanceObservation { strategyHash: string; breachCount: number; lastShipAt?: number; }
export interface StateDocument { version: 1; plans: Record<string, PersistedPlan>; observations: Record<string, RebalanceObservation>; }

/** 原子写入前进行最小结构校验，防止损坏或手工篡改状态被自动执行器采用。 */
function validatePlan(value: unknown, key: string): PersistedPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`状态计划 ${key} 必须是对象`);
  const plan = value as Record<string, unknown>;
  const text = (field: string): string => { if (typeof plan[field] !== "string" || plan[field] === "") throw new Error(`状态计划 ${key}.${field} 无效`); return plan[field] as string; };
  const rawPair = (field: string): [string, string] => { const value = plan[field]; if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "string" || !/^(?:0|[1-9]\d*)$/.test(item))) throw new Error(`状态计划 ${key}.${field} 必须是两个非负 raw 字符串`); return value as [string, string]; };
  const mode = text("targetMode"); if (mode !== "upper" && mode !== "lower" && mode !== "two-sided") throw new Error(`状态计划 ${key}.targetMode 无效`);
  const stage = text("stage"); if (!["PLAN_PERSISTED", "DOCK_SENT", "DOCK_VERIFIED", "SHIP_SENT", "ACTIVE_LATEST", "BLOCKED"].includes(stage)) throw new Error(`状态计划 ${key}.stage 无效`);
  const tokens = plan.tokens; if (!Array.isArray(tokens) || tokens.length !== 2 || tokens.some((item) => typeof item !== "string")) throw new Error(`状态计划 ${key}.tokens 无效`);
  const createdAt = plan.createdAt; const updatedAt = plan.updatedAt;
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(updatedAt)) throw new Error(`状态计划 ${key} 时间戳无效`);
  const safeCreatedAt = createdAt as number; const safeUpdatedAt = updatedAt as number;
  const salt = text("salt"); if (!/^(?:0|[1-9]\d*)$/.test(salt)) throw new Error(`状态计划 ${key}.salt 必须是非负整数字符串`);
  return { logicalPositionKey: text("logicalPositionKey"), sourceStrategyHash: text("sourceStrategyHash"), sourceStrategyBytes: text("sourceStrategyBytes"), sourceApp: text("sourceApp"), tokens: tokens as [string, string], sourceCurrentRaw: rawPair("sourceCurrentRaw"), targetMode: mode, targetAmountsRaw: rawPair("targetAmountsRaw"), targetRawPriceMin: text("targetRawPriceMin"), targetRawPriceMax: text("targetRawPriceMax"), fee: text("fee"), salt, shipStrategyHash: text("shipStrategyHash"), decisionReason: text("decisionReason"), createdAt: safeCreatedAt, updatedAt: safeUpdatedAt, stage: stage as PlanStage, ...(typeof plan.dockTransactionHash === "string" ? { dockTransactionHash: plan.dockTransactionHash } : {}), ...(typeof plan.shipTransactionHash === "string" ? { shipTransactionHash: plan.shipTransactionHash } : {}), ...(typeof plan.blockedReason === "string" ? { blockedReason: plan.blockedReason } : {}) };
}

export function loadRebalanceState(path: string): StateDocument {
  if (!existsSync(path)) return { version: 1, plans: {}, observations: {} };
  let parsed: unknown; try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`状态文件无法解析：${path}`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("状态文件根节点必须是对象");
  const root = parsed as Record<string, unknown>; if (root.version !== 1 || typeof root.plans !== "object" || root.plans === null || Array.isArray(root.plans) || typeof root.observations !== "object" || root.observations === null || Array.isArray(root.observations)) throw new Error("状态文件版本、plans 或 observations 无效");
  const plans: Record<string, PersistedPlan> = {}; for (const [key, value] of Object.entries(root.plans as Record<string, unknown>)) plans[key] = validatePlan(value, key);
  const observations: Record<string, RebalanceObservation> = {};
  for (const [key, value] of Object.entries(root.observations as Record<string, unknown>)) { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`状态观测 ${key} 必须是对象`); const item = value as Record<string, unknown>; if (typeof item.strategyHash !== "string" || !Number.isSafeInteger(item.breachCount) || (item.breachCount as number) < 0 || (item.lastShipAt !== undefined && !Number.isSafeInteger(item.lastShipAt))) throw new Error(`状态观测 ${key} 无效`); observations[key] = { strategyHash: item.strategyHash, breachCount: item.breachCount as number, ...(item.lastShipAt === undefined ? {} : { lastShipAt: item.lastShipAt as number }) }; }
  return { version: 1, plans, observations };
}

/** 使用临时文件、fsync 与 rename 防止进程被中断时留下半个 JSON。 */
export function saveRebalanceState(path: string, state: StateDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`; const handle = openSync(temporary, "w", 0o600);
  try { writeFileSync(handle, `${JSON.stringify(state, null, 2)}\n`, "utf8"); fsyncSync(handle); } finally { closeSync(handle); }
  renameSync(temporary, path);
}

/** 同一 stateFile 同时只允许一个 Bot 进程，避免双重 dock 或 nonce 竞争。 */
export function acquireRebalanceLock(stateFile: string): () => void {
  const lockPath = `${stateFile}.lock`; mkdirSync(dirname(lockPath), { recursive: true });
  let handle: number; try { handle = openSync(lockPath, "wx", 0o600); } catch { throw new Error(`另一个 rebalance-bot 正在运行：${lockPath}`); }
  return () => { try { closeSync(handle); } finally { if (existsSync(lockPath)) unlinkSync(lockPath); } };
}
