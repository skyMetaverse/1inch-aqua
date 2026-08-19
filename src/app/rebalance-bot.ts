/**
 * Aqua 自动再平衡 Bot 入口。
 * 核心功能：监控官方 API 的全部受支持活跃仓位，依据 API 余额、Pair 活跃度和 EMSH current 自动 dock 并 ship 新策略。
 * 主要流程：解密私钥并取得锁 -> 优先恢复未完成计划 -> 拉取 API 快照 -> 生成唯一计划 -> 链上预检与本地签名执行。
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { AQUA_CONTRACT_ADDRESSES, AquaProtocolContract, Address as AquaAddress, ABI as AquaAbi, DockedEvent, HexString, NetworkEnum, PushedEvent, ShippedEvent } from "@1inch/aqua-sdk";
import { AQUA_SWAP_VM_CONTRACT_ADDRESSES } from "@1inch/swap-vm-sdk";
import { createPublicClient, defineChain, http, isAddress, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getDecryptedPrivateKey } from "../../scripts/encrypt-private-key.ts";
import { buildConcentratedStrategy } from "../aqua/strategy.ts";
import { parseConcentratedSqrtRange } from "../aqua/strategy-parser.ts";
import { validateRebalanceConfig, type RebalanceConfig } from "../config/rebalance-config.ts";
import { validateAddLpConfig, type AddLpConfig, type PositionConfig } from "../config/lp-config.ts";
import { readJsoncFile } from "../config/jsonc.ts";
import { calculateDisplayRange, convertAquaSqrtRangeToDisplayRange, convertDisplayRangeToAquaSqrtRange, formatFixed, parseDecimal, parseDecimalFloor, parsePercentage, percentageToAquaFeeValue } from "../domain/fixed.ts";
import { decideRebalance, outsideDistancePercent, relativePriceDeviationPercent, type RebalanceMode } from "../domain/rebalance.ts";
import { getActiveStrategies, getPairMarkets, type ApiStrategy, type PairMarket } from "../infra/aqua-api.ts";
import { MAX_UINT256, readTokenAllowance, readTokenBalance } from "../infra/erc20.ts";
import { getCurrentPrice } from "../infra/emsh.ts";
import { createLogger, formatLogLine, type Logger } from "../infra/logger.ts";
import { RebalanceTerminalDashboard, type DashboardStatus, type RebalanceDashboardRow } from "../infra/rebalance-terminal.ts";
import { RawBroadcastIndeterminateError, sendLocallySignedTransaction, type TransactionRequest } from "../infra/rpc.ts";
import { acquireRebalanceLock, loadRebalanceState, saveRebalanceState, type PersistedPlan, type StateDocument } from "../infra/rebalance-state.ts";
import { addConfiguredPositions, ensureMaximumAllowance } from "./add-lp.ts";

const DEFAULT_CONFIG_PATH = "config/rebalance.jsonc";
const ENV_FILE = ".env";
const DOCKED_TOKENS_COUNT = 0xff;
let activeLogger: Logger | null = null;
let activeTerminal: RebalanceTerminalDashboard | null = null;

/** 从 .env 读取 RPC，仅保留必要字段，不将包含私钥的整个文件载入环境变量。 */
function readRpcUrl(): string {
  if (!existsSync(ENV_FILE)) throw new Error("未找到 .env 文件");
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const value = line.match(/^\s*RPC_URL\s*=\s*(.*?)\s*$/)?.[1]?.trim();
    if (value) { const quoted = value.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/); return quoted?.[1] ?? quoted?.[2] ?? value; }
  }
  throw new Error(".env 中未找到 RPC_URL");
}
function maskRpcUrl(value: string): string { try { const url = new URL(value); return `${url.protocol}//${url.host}`; } catch { return "无效 RPC URL"; } }
function requireAddress(value: string, field: string): Address { if (!isAddress(value)) throw new Error(`${field} 不是有效 EVM 地址`); return value; }

/** 网络超时后只使用本地 hash 等待同一笔回执，禁止为 dock/ship 再发送一次 raw transaction。 */
async function sendOrReconcileBroadcast(parameters: { account: PrivateKeyAccount; chain: Chain; rpcUrl: string; transaction: TransactionRequest; logger: Logger; action: string }): Promise<Hex> {
  try {
    return await sendLocallySignedTransaction(parameters.account, parameters.chain, http(parameters.rpcUrl), parameters.transaction);
  } catch (error) {
    if (error instanceof RawBroadcastIndeterminateError) {
      parameters.logger.info(`${parameters.action} raw 广播响应不确定：本地交易哈希=${error.transactionHash}；不重发，改为查询同一笔回执`);
      return error.transactionHash;
    }
    throw error;
  }
}

/**
 * 校验策略是否属于 Bot 可处理范围。illiquidity 是明确的强制重挂触发状态；其他未知状态仍阻止自动交易，避免把 API 标签擅自当作可交易状态。
 */
export function unsupportedStrategyReason(strategy: Pick<ApiStrategy, "maker" | "chainId" | "app" | "classification">, expectedMaker: Address, expectedChainId: number, expectedApp: Address): string | null {
  const reasons: string[] = [];
  if (strategy.maker.toLowerCase() !== expectedMaker.toLowerCase()) reasons.push(`maker 不匹配：${strategy.maker}`);
  if (strategy.chainId !== expectedChainId) reasons.push(`chainId 不匹配：${strategy.chainId}`);
  if (strategy.app.toLowerCase() !== expectedApp.toLowerCase()) reasons.push(`app 不匹配：${strategy.app}`);
  if (strategy.classification.type !== "concentrated") reasons.push(`策略类型=${strategy.classification.type}，仅支持 concentrated`);
  if (strategy.classification.state !== "active" && strategy.classification.state !== "illiquidity") reasons.push(`策略状态=${strategy.classification.state}，仅自动处理 active 或 illiquidity`);
  return reasons.length > 0 ? reasons.join("；") : null;
}
function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/**
 * 判断 BLOCKED 计划是否可丢弃后重新决策。
 * 只有节点明确拒绝旧 nonce，或 dock 模拟前返回无细节的临时 RPC 创建错误时，才能确认没有可追踪的 raw 交易。
 * 后者必须同时没有任何交易 hash 或冻结的 ship 字段，避免把已 dock/已 ship 的不确定计划误当成安全重试。
 */
export function isRetryableBlockedPlan(plan: Pick<PersistedPlan, "stage" | "blockedReason" | "dockTransactionHash" | "shipTransactionHash" | "walletBalancesRaw" | "targetAmountsRaw" | "shipStrategyHash">): boolean {
  if (plan.stage !== "BLOCKED") return false;
  if (/nonce too low/i.test(plan.blockedReason ?? "")) return true;
  const isPreBroadcastRpcCreationFailure = plan.blockedReason === "Transaction creation failed."
    && !plan.dockTransactionHash
    && !plan.shipTransactionHash
    && !plan.walletBalancesRaw
    && !plan.targetAmountsRaw
    && !plan.shipStrategyHash;
  return isPreBroadcastRpcCreationFailure;
}

/** 以最小信号接口隔离 process，允许测试验证 Ctrl+C/服务停止会进入同一清理路径。 */
export interface RebalanceTerminationSignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: (signal: string) => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: (signal: string) => void): unknown;
}

/**
 * 注册可移除的终止处理器。共享 completed 标记是为处理用户连续按 Ctrl+C 或运行环境同时发送 SIGTERM，防止重复释放同一个锁文件。
 * SIGKILL 不可被用户态捕获，仍只能在确认 Bot 已停止后人工清理遗留锁。
 */
export function installRebalanceTerminationHandler(source: RebalanceTerminationSignalSource, onTerminate: (signal: string) => void): () => void {
  let completed = false;
  const handler = (signal: string): void => {
    if (completed) return;
    completed = true;
    onTerminate(signal);
  };
  source.once("SIGINT", handler);
  source.once("SIGTERM", handler);
  return (): void => {
    source.off("SIGINT", handler);
    source.off("SIGTERM", handler);
  };
}
function positionIdentity(strategy: Pick<LogicalPositionInput, "chainId" | "maker" | "app" | "tokens">): string { return `${strategy.chainId}:${strategy.maker.toLowerCase()}:${strategy.app.toLowerCase()}:${[strategy.tokens[0].address, strategy.tokens[1].address].map((value) => value.toLowerCase()).sort().join(":")}`; }
function marketKey(tokens: [{ address: Address }, { address: Address }]): string { return `${tokens[0].address.toLowerCase()}:${tokens[1].address.toLowerCase()}`; }

/** 配置对账只关心同一交易对，不依赖 token 顺序或已成交后的单边/双边模式。 */
function configuredPairKey(tokens: readonly { address: Address }[]): string {
  return tokens.map((token) => token.address.toLowerCase()).sort().join(":");
}

/** 找到某个当前或历史 strategyHash 所属的配置模板；模板仅用于补足数量，不干预动态重挂模式。 */
export function configuredPositionIdForStrategyHash(state: StateDocument, strategyHash: string): string | undefined {
  return Object.entries(state.configuredSlots).find(([, slot]) => slot.strategyHash?.toLowerCase() === strategyHash.toLowerCase())?.[0];
}

/** 只要配置槽位有未完成计划，就必须先恢复同一份 dock/ship，不能并发创建第二个替代仓位。 */
function hasPendingConfiguredSlotPlan(state: StateDocument, positionId: string): boolean {
  return Object.values(state.plans).some((plan) => plan.configuredPositionId === positionId && plan.stage !== "ACTIVE_LATEST");
}

/**
 * 用 API 活跃快照对齐配置槽位，并返回需要按初始模板补建的槽位。
 * 首次升级缺少历史关联时，同 pair 的活跃策略按 openedAt/hash 稳定分配给未占用模板；之后关联随 ship 新 hash 持续迁移，动态模式不参与判断。
 */
export function reconcileConfiguredPositionSlots(parameters: { state: StateDocument; lpConfig: AddLpConfig; strategies: readonly ApiStrategy[]; indexingGraceMilliseconds: number; now?: number }): PositionConfig[] {
  const now = parameters.now ?? Date.now();
  const configuredIds = new Set(parameters.lpConfig.positions.map((position) => position.id));
  for (const slotId of Object.keys(parameters.state.configuredSlots)) {
    if (!configuredIds.has(slotId)) delete parameters.state.configuredSlots[slotId];
  }
  const active = parameters.strategies.filter((strategy) => parameters.lpConfig.positions.some((position) => configuredPairKey(position.pair.tokens) === configuredPairKey(strategy.tokens)));
  const activeByHash = new Map(active.map((strategy) => [strategy.strategyHash.toLowerCase(), strategy]));
  const assigned = new Set<string>();
  for (const position of parameters.lpConfig.positions) {
    const slot = parameters.state.configuredSlots[position.id];
    if (!slot?.strategyHash) continue;
    if (activeByHash.has(slot.strategyHash.toLowerCase())) {
      assigned.add(slot.strategyHash.toLowerCase());
      continue;
    }
    // 新 ship 已经链上确认但 API 尚未索引时，不得按“缺失”再添加同一配置仓位。
    if (!hasPendingConfiguredSlotPlan(parameters.state, position.id) && now - slot.updatedAt >= parameters.indexingGraceMilliseconds) {
      parameters.state.configuredSlots[position.id] = { updatedAt: now };
    }
  }
  const unassigned = active.filter((strategy) => !assigned.has(strategy.strategyHash.toLowerCase())).sort((left, right) => left.openedAt - right.openedAt || left.strategyHash.localeCompare(right.strategyHash));
  for (const strategy of unassigned) {
    const position = parameters.lpConfig.positions.find((candidate) => !parameters.state.configuredSlots[candidate.id]?.strategyHash && !hasPendingConfiguredSlotPlan(parameters.state, candidate.id) && configuredPairKey(candidate.pair.tokens) === configuredPairKey(strategy.tokens));
    if (!position) continue;
    parameters.state.configuredSlots[position.id] = { strategyHash: strategy.strategyHash, updatedAt: now };
  }
  return parameters.lpConfig.positions.filter((position) => !parameters.state.configuredSlots[position.id]?.strategyHash && !hasPendingConfiguredSlotPlan(parameters.state, position.id));
}

/** 同一 pair 的不同 strategyHash 是不同 Aqua 仓位，必须拥有独立观察计数和恢复计划。 */
type LogicalPositionInput = { chainId: number; maker: Address; app: Address; tokens: [{ address: Address }, { address: Address }]; strategyHash: Hex };
export function buildLogicalPositionKey(parameters: LogicalPositionInput): string { return `${positionIdentity(parameters)}:${parameters.strategyHash.toLowerCase()}`; }
function logicalKey(strategy: ApiStrategy): string { return buildLogicalPositionKey(strategy); }
function keyWithStrategyHash(key: string, strategyHash: string): string { return `${key.replace(/:0x[0-9a-f]{64}$/i, "")}:${strategyHash.toLowerCase()}`; }

/** 授权缓存只在当前进程有效，key 绑定 owner、registry 和 token；重启或链上未确认最大授权时都必须重新读取。 */
function maximumAllowanceCacheKey(owner: Address, registry: Address, token: Address): string {
  return `${owner.toLowerCase()}:${registry.toLowerCase()}:${token.toLowerCase()}`;
}

/** 启动后一次性预检当前 open 策略涉及的 token；精确 MAX_UINT256 才可对任意后续投入额跳过 allowance 读取。 */
async function primeMaximumAllowanceCache(parameters: { client: ReturnType<typeof createPublicClient>; strategies: readonly ApiStrategy[]; owner: Address; registry: Address; cache: Set<string>; logger: Logger }): Promise<void> {
  const tokens = new Map<string, Address>();
  for (const strategy of parameters.strategies) {
    for (const token of strategy.tokens) tokens.set(token.address.toLowerCase(), token.address);
  }
  for (const token of tokens.values()) {
    const allowance = await readTokenAllowance(parameters.client, token, parameters.owner, parameters.registry);
    const cacheKey = maximumAllowanceCacheKey(parameters.owner, parameters.registry, token);
    if (allowance === MAX_UINT256) {
      parameters.cache.add(cacheKey);
      parameters.logger.info(`启动授权预检：token=${token} 已确认 MAX_UINT256，后续本进程重挂不再读取 allowance`);
    } else {
      parameters.logger.info(`启动授权预检：token=${token} 非最大授权，ship 前仍需核对 allowance=${allowance.toString()}`);
    }
  }
}

/** 将旧版不含 strategyHash 的状态 key 迁移到当前独立仓位 key，避免升级后丢失恢复计划。 */
function migrateStateKeys(state: StateDocument): boolean {
  let changed = false;
  const plans: Record<string, PersistedPlan> = {};
  for (const [key, plan] of Object.entries(state.plans)) {
    const nextKey = keyWithStrategyHash(key, plan.sourceStrategyHash);
    if (nextKey !== key || plan.logicalPositionKey !== nextKey) changed = true;
    const nextPlan = nextKey === key && plan.logicalPositionKey === nextKey ? plan : { ...plan, logicalPositionKey: nextKey };
    if (plans[nextKey] && plans[nextKey]?.sourceStrategyHash.toLowerCase() !== nextPlan.sourceStrategyHash.toLowerCase()) throw new Error(`状态文件存在无法区分的逻辑仓位：${nextKey}`);
    plans[nextKey] = nextPlan;
  }
  const observations: StateDocument["observations"] = {};
  for (const [key, observation] of Object.entries(state.observations)) {
    const nextKey = keyWithStrategyHash(key, observation.strategyHash);
    if (nextKey !== key) changed = true;
    observations[nextKey] = observation;
  }
  if (changed) { state.plans = plans; state.observations = observations; }
  return changed;
}
function parseBotArguments(): string { const args = process.argv.slice(2); if (args.includes("--help") || args.includes("-h")) { process.stdout.write("用法：bun run rebalance-bot [配置文件路径]\n"); process.stdout.write(`默认配置文件：${DEFAULT_CONFIG_PATH}\n`); process.stdout.write("运行后会持续监控并直接执行符合条件的 dock/ship，不提供 dry-run。\n"); process.exit(0); } if (args.length > 1 || args.some((item) => item.startsWith("-"))) throw new Error("用法：bun run rebalance-bot [配置文件路径]"); return args[0] ?? DEFAULT_CONFIG_PATH; }
function currentTimestampValid(timestamp: number, maximumAge: number): void { const now = Math.floor(Date.now() / 1000); if (timestamp > now + 60 || now - timestamp > maximumAge) throw new Error(`EMSH current 时间戳无效或过期：timestamp=${timestamp}`); }
/**
 * 按已决定的模式从 dock 后钱包快照导出最终 ship 金额。决策模式来自 API，资金规模则必须来自钱包实际余额，避免忽略钱包中可用的同 pair 资产。
 * 单边刻意保留非目标侧在钱包中；双边要求两个实际余额均非零，不能静默降级为单边。
 */
export function deriveWalletShipAmounts(walletBalances: [bigint, bigint], mode: RebalanceMode): [bigint, bigint] {
  if (walletBalances.some((value) => value < 0n)) throw new Error("钱包 raw 余额不能为负数");
  if (mode === "upper") {
    if (walletBalances[0] === 0n) throw new Error("上单边重挂时钱包 token0 余额为零");
    return [walletBalances[0], 0n];
  }
  if (mode === "lower") {
    if (walletBalances[1] === 0n) throw new Error("下单边重挂时钱包 token1 余额为零");
    return [0n, walletBalances[1]];
  }
  if (walletBalances[0] === 0n || walletBalances[1] === 0n) throw new Error("双边重挂时钱包两侧余额必须均大于零");
  return walletBalances;
}
function displayRangeForMode(current: bigint, mode: RebalanceMode, config: RebalanceConfig) { const width = mode === "two-sided" ? parsePercentage(config.rebalance.twoSidedHalfWidth, "twoSidedHalfWidth") : parsePercentage(config.rebalance.singleSidedWidth, "singleSidedWidth"); return calculateDisplayRange(current, mode, mode === "lower" ? undefined : width, mode === "upper" ? undefined : width); }
function updatePlan(state: StateDocument, plan: PersistedPlan, config: RebalanceConfig): void { state.plans[plan.logicalPositionKey] = plan; saveRebalanceState(config.runtime.stateFile, state); }

/** 重挂完成后把冷却观察迁移到新 strategyHash，旧计划仍作为 API 索引延迟期间的保护别名。 */
function registerCompletedObservation(state: StateDocument, plan: PersistedPlan, newStrategyHash: string, config: RebalanceConfig): void {
  const now = Date.now();
  const nextKey = keyWithStrategyHash(plan.logicalPositionKey, newStrategyHash);
  state.observations[nextKey] = { strategyHash: newStrategyHash, breachCount: 0, lastShipAt: now };
  state.plans[plan.logicalPositionKey] = { ...plan, shipStrategyHash: newStrategyHash, stage: "ACTIVE_LATEST", updatedAt: now };
  // 只迁移关联 hash，不写回 targetMode；后续重挂仍由当前成交余额动态决定。
  if (plan.configuredPositionId) state.configuredSlots[plan.configuredPositionId] = { strategyHash: newStrategyHash, updatedAt: now };
  saveRebalanceState(config.runtime.stateFile, state);
}
function logRange(logger: Logger, strategy: ApiStrategy, range: { min: bigint; current: bigint; max: bigint }, prefix: string): void { logger.info(`${prefix}：1 ${strategy.tokens[0].symbol} = ${formatFixed(range.min)} 至 ${formatFixed(range.max)} ${strategy.tokens[1].symbol}；current=1 ${strategy.tokens[0].symbol} = ${formatFixed(range.current)} ${strategy.tokens[1].symbol}`); }

/** 终端状态只反映决策结果：在区间内为 KEEP，越界等待/冷却为 WARN，计划和链上动作由 ACTION/PLAN 显示。 */
function dashboardStatus(decision: ReturnType<typeof decideRebalance>): DashboardStatus {
  if (decision.action === "rehang") return "ACTION";
  if (decision.action === "block") return "BLOCK";
  return decision.reason === "当前价格仍在旧策略区间内" ? "KEEP" : "WARN";
}

/** 将精确 bigint 快照转换为仅用于终端呈现的行；文件日志仍保留完整原始字段和原因。 */
function dashboardRow(strategy: ApiStrategy, range: { min: bigint; current: bigint; max: bigint }, outside: bigint, breachCount: number, requiredBreaches: number, priceDeviation: bigint | null, decision: ReturnType<typeof decideRebalance>): RebalanceDashboardRow {
  return {
    strategyHash: strategy.strategyHash,
    pair: `${strategy.tokens[0].symbol}/${strategy.tokens[1].symbol}`,
    current: formatFixed(range.current),
    min: formatFixed(range.min),
    max: formatFixed(range.max),
    outside: `${formatFixed(outside)}%`,
    breach: `${breachCount}/${requiredBreaches}`,
    deviation: priceDeviation === null ? "--" : `${formatFixed(priceDeviation)}%`,
    status: dashboardStatus(decision),
    reason: decision.reason,
  };
}

/** 面板模式仅过滤终端输出，审计 logger 仍无条件把每条中文 [info] 写入本次 logs 文件。 */
function createDashboardLogger(auditLogger: Logger, dashboard: RebalanceTerminalDashboard): Logger {
  return {
    filePath: auditLogger.filePath,
    info(message: string): void {
      auditLogger.info(message);
      if (dashboard.recordAuditMessage(message)) dashboard.render();
    },
  };
}

/** API 索引延迟或未完成计划没有可用 current 快照时，仍保留一行明确说明该策略为何暂不决策。 */
function dashboardPlaceholderRow(strategy: ApiStrategy, status: DashboardStatus, reason: string): RebalanceDashboardRow {
  return {
    strategyHash: strategy.strategyHash,
    pair: `${strategy.tokens[0].symbol}/${strategy.tokens[1].symbol}`,
    current: "--",
    min: "--",
    max: "--",
    outside: "--",
    breach: "--",
    deviation: "--",
    status,
    reason,
  };
}

/** dock 前核对 API 快照，避免索引延迟让 Bot 关闭的不是计划中的余额。 */
async function verifyApiSnapshotOnChain(client: ReturnType<typeof createPublicClient>, registry: Address, account: Address, plan: PersistedPlan): Promise<void> {
  for (const [index, token] of plan.tokens.entries()) {
    const result = await client.readContract({ address: registry, abi: AquaAbi.AQUA_ABI, functionName: "rawBalances", args: [account, requireAddress(plan.sourceApp, "计划 sourceApp"), plan.sourceStrategyHash as Hex, requireAddress(token, "计划 token")] }) as unknown as readonly [bigint, number];
    const expected = BigInt(plan.sourceCurrentRaw[index] ?? "");
    if (result[0] !== expected || result[1] !== 2) throw new Error(`链上余额与 API 计划不一致：token=${token}，链上=${result[0].toString()}，API=${expected.toString()}，tokensCount=${result[1]}`);
  }
}

/** 判断旧策略是否已完整 dock；恢复 DOCK_SENT 时仅以该链上终态判定，不能再次发送 dock。 */
async function oldStrategyDocked(client: ReturnType<typeof createPublicClient>, registry: Address, account: Address, plan: PersistedPlan): Promise<boolean> {
  for (const token of plan.tokens) {
    const result = await client.readContract({ address: registry, abi: AquaAbi.AQUA_ABI, functionName: "rawBalances", args: [account, requireAddress(plan.sourceApp, "计划 sourceApp"), plan.sourceStrategyHash as Hex, requireAddress(token, "计划 token")] }) as unknown as readonly [bigint, number];
    if (result[0] !== 0n || result[1] !== DOCKED_TOKENS_COUNT) return false;
  }
  return true;
}

/** 判断持久化新 hash 是否已完整 ship；恢复 SHIP_SENT 时只要成立便完成，不会重发。 */
async function newStrategyShipped(client: ReturnType<typeof createPublicClient>, registry: Address, account: Address, app: Address, plan: FrozenShipPlan): Promise<boolean> {
  for (const [index, token] of plan.tokens.entries()) {
    const result = await client.readContract({ address: registry, abi: AquaAbi.AQUA_ABI, functionName: "rawBalances", args: [account, app, plan.shipStrategyHash as Hex, requireAddress(token, "计划 token")] }) as unknown as readonly [bigint, number];
    if (result[0] !== BigInt(plan.targetAmountsRaw[index] ?? "") || result[1] !== 2) return false;
  }
  return true;
}
function hasEvent(logs: ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>, registry: Address, maker: Address, app: Address, hash: Hex, kind: "docked" | "shipped"): boolean {
  const eventType = kind === "docked" ? DockedEvent : ShippedEvent; const topic = eventType.TOPIC.toString().toLowerCase();
  return logs.some((log) => { if (log.address.toLowerCase() !== registry.toLowerCase() || log.topics[0]?.toLowerCase() !== topic) return false; const event = eventType.fromLog({ data: log.data, topics: log.topics as unknown as [Hex, ...Hex[]] }); return event.maker.toString().toLowerCase() === maker.toLowerCase() && event.app.toString().toLowerCase() === app.toLowerCase() && event.strategyHash.toString().toLowerCase() === hash.toLowerCase(); });
}

/** ship 恢复与正常路径都必须确认每个非零投入 token 的 Pushed 事件。 */
function verifyPushedEvents(logs: ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>, registry: Address, maker: Address, app: Address, strategyHash: Hex, plan: FrozenShipPlan): void {
  const topic = PushedEvent.TOPIC.toString().toLowerCase();
  for (const [index, token] of plan.tokens.entries()) {
    const expected = BigInt(plan.targetAmountsRaw[index] ?? "");
    if (expected === 0n) continue;
    const found = logs.some((log) => { if (log.address.toLowerCase() !== registry.toLowerCase() || log.topics[0]?.toLowerCase() !== topic) return false; const event = PushedEvent.fromLog({ data: log.data, topics: log.topics as unknown as [Hex, ...Hex[]] }); return event.maker.toString().toLowerCase() === maker.toLowerCase() && event.app.toString().toLowerCase() === app.toLowerCase() && event.strategyHash.toString().toLowerCase() === strategyHash.toLowerCase() && event.token.toString().toLowerCase() === token.toLowerCase() && event.amount === expected; });
    if (!found) throw new Error(`ship 回执缺少 Pushed 事件：token=${token}`);
  }
}

/** 按已持久化计划关闭旧策略；阶段在广播前写入，重启时可用 rawBalances 判断是否已落链。 */
async function executeDock(parameters: { plan: PersistedPlan; state: StateDocument; config: RebalanceConfig; client: ReturnType<typeof createPublicClient>; registry: Address; account: PrivateKeyAccount; chain: Chain; rpcUrl: string; logger: Logger }): Promise<PersistedPlan> {
  let { plan } = parameters; if (plan.stage === "DOCK_VERIFIED" || plan.stage === "SHIP_PREPARED" || plan.stage === "SHIP_SENT" || plan.stage === "ACTIVE_LATEST") return plan;
  const storedHash = AquaProtocolContract.calculateStrategyHash(new HexString(plan.sourceStrategyBytes)).toString();
  if (storedHash.toLowerCase() !== plan.sourceStrategyHash.toLowerCase()) throw new Error("持久化计划的 sourceStrategyBytes hash 不一致");
  if (plan.stage === "DOCK_SENT") {
    if (!plan.dockTransactionHash) throw new Error("恢复 dock 计划缺少交易哈希，已停止避免重复广播");
    const receipt = await parameters.client.waitForTransactionReceipt({ hash: plan.dockTransactionHash as Hex, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`恢复 dock 回执失败：${plan.dockTransactionHash}`);
    const logs = receipt.logs as unknown as ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>;
    if (!hasEvent(logs, parameters.registry, parameters.account.address, requireAddress(plan.sourceApp, "计划 sourceApp"), plan.sourceStrategyHash as Hex, "docked")) throw new Error("恢复 dock 回执缺少匹配 Docked 事件");
    if (!await oldStrategyDocked(parameters.client, parameters.registry, parameters.account.address, plan)) throw new Error("恢复 dock 后链上状态未进入 docked");
    plan = { ...plan, stage: "DOCK_VERIFIED", updatedAt: Date.now() }; updatePlan(parameters.state, plan, parameters.config); parameters.logger.info(`恢复 dock 成功：strategyHash=${plan.sourceStrategyHash}`); return plan;
  }
  await verifyApiSnapshotOnChain(parameters.client, parameters.registry, parameters.account.address, plan);
  const aqua = new AquaProtocolContract(new AquaAddress(parameters.registry)); const dock = aqua.dock({ app: new AquaAddress(plan.sourceApp), strategyHash: new HexString(plan.sourceStrategyHash), tokens: plan.tokens.map((token) => new AquaAddress(token)) });
  const to = dock.to.toString() as Address; const data = dock.data.toString() as Hex;
  await parameters.client.call({ account: parameters.account.address, to, data, value: dock.value });
  parameters.logger.info(`dock 链上模拟成功：strategyHash=${plan.sourceStrategyHash}`);
  plan = { ...plan, stage: "DOCK_SENT", updatedAt: Date.now() }; updatePlan(parameters.state, plan, parameters.config);
  const transactionHash = await sendOrReconcileBroadcast({ account: parameters.account, chain: parameters.chain, rpcUrl: parameters.rpcUrl, transaction: { to, data, value: dock.value }, logger: parameters.logger, action: `dock strategyHash=${plan.sourceStrategyHash}` });
  plan = { ...plan, dockTransactionHash: transactionHash, updatedAt: Date.now() }; updatePlan(parameters.state, plan, parameters.config); parameters.logger.info(`dock 已广播：strategyHash=${plan.sourceStrategyHash}，交易哈希=${transactionHash}`);
  const receipt = await parameters.client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 1 }); if (receipt.status !== "success") throw new Error(`dock 回执失败：${transactionHash}`);
  const logs = receipt.logs as unknown as ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>; if (!hasEvent(logs, parameters.registry, parameters.account.address, requireAddress(plan.sourceApp, "计划 sourceApp"), plan.sourceStrategyHash as Hex, "docked")) throw new Error("dock 回执缺少匹配 Docked 事件");
  for (const token of plan.tokens) { const result = await parameters.client.readContract({ address: parameters.registry, abi: AquaAbi.AQUA_ABI, functionName: "rawBalances", args: [parameters.account.address, requireAddress(plan.sourceApp, "计划 sourceApp"), plan.sourceStrategyHash as Hex, requireAddress(token, "计划 token")] }) as unknown as readonly [bigint, number]; if (result[0] !== 0n || result[1] !== DOCKED_TOKENS_COUNT) throw new Error(`dock 后链上复核失败：token=${token}`); }
  plan = { ...plan, stage: "DOCK_VERIFIED", updatedAt: Date.now() }; updatePlan(parameters.state, plan, parameters.config); parameters.logger.info(`dock 已确认并复核：strategyHash=${plan.sourceStrategyHash}`); return plan;
}

type FrozenShipPlan = PersistedPlan & { targetAmountsRaw: [string, string]; salt: string; shipStrategyHash: string };

/** 只有 SHIP_PREPARED 后才允许使用新策略字段；恢复时不重新读取钱包来改变已冻结的金额或 hash。 */
function requireFrozenShipPlan(plan: PersistedPlan): FrozenShipPlan {
  if (!plan.targetAmountsRaw || !plan.salt || !plan.shipStrategyHash) throw new Error(`计划阶段=${plan.stage} 缺少已冻结的 ship 金额、salt 或 strategyHash`);
  return plan as FrozenShipPlan;
}

/** 以持久化 salt、实际钱包快照金额和精确 sqrt 参数构建新策略，确保恢复过程不会产生第二个 hash。 */
function buildPlanStrategy(plan: FrozenShipPlan, chainId: number, maker: Address) {
  const built = buildConcentratedStrategy({ chainId, maker, sqrtPriceMin: BigInt(plan.targetSqrtPriceMin), sqrtPriceMax: BigInt(plan.targetSqrtPriceMax), feeValue: percentageToAquaFeeValue(parsePercentage(plan.fee, "计划 fee")), amounts: [{ token: requireAddress(plan.tokens[0], "计划 token0"), amount: BigInt(plan.targetAmountsRaw[0]) }, { token: requireAddress(plan.tokens[1], "计划 token1"), amount: BigInt(plan.targetAmountsRaw[1]) }], salt: BigInt(plan.salt) });
  if (built.strategyHash.toLowerCase() !== plan.shipStrategyHash.toLowerCase()) throw new Error("持久化计划的 ship strategyHash 与重建结果不一致");
  return built;
}

/**
 * dock 已确认后读取该 pair 的两个实际钱包余额，并在任何 approve、模拟或广播前原子冻结最终金额、salt 与 hash。
 * SHIP_PREPARED 后即使用户转入更多代币也不再改变本次策略，确保恢复只会重建同一个 strategyHash。
 */
async function prepareShipFromWallet(parameters: { plan: PersistedPlan; state: StateDocument; config: RebalanceConfig; client: ReturnType<typeof createPublicClient>; registry: Address; account: PrivateKeyAccount; chainId: number; logger: Logger }): Promise<PersistedPlan> {
  if (parameters.plan.stage !== "DOCK_VERIFIED") return parameters.plan;
  const token0 = requireAddress(parameters.plan.tokens[0], "计划 token0");
  const token1 = requireAddress(parameters.plan.tokens[1], "计划 token1");
  // 保持串行读取，沿用低额度 RPC 的限流保护；这两个余额是新策略唯一的资金来源快照。
  const balance0 = await readTokenBalance(parameters.client, token0, parameters.account.address);
  const balance1 = await readTokenBalance(parameters.client, token1, parameters.account.address);
  const walletBalances: [bigint, bigint] = [balance0, balance1];
  const amounts = deriveWalletShipAmounts(walletBalances, parameters.plan.targetMode);
  const salt = BigInt(`0x${randomBytes(8).toString("hex")}`);
  const built = buildConcentratedStrategy({ chainId: parameters.chainId, maker: parameters.account.address, sqrtPriceMin: BigInt(parameters.plan.targetSqrtPriceMin), sqrtPriceMax: BigInt(parameters.plan.targetSqrtPriceMax), feeValue: percentageToAquaFeeValue(parsePercentage(parameters.plan.fee, "计划 fee")), amounts: [{ token: token0, amount: amounts[0] }, { token: token1, amount: amounts[1] }], salt });
  if (built.registry.toLowerCase() !== parameters.registry.toLowerCase()) throw new Error("新策略 registry 与 RPC 网络不一致");
  const now = Date.now();
  const prepared: PersistedPlan = { ...parameters.plan, walletBalancesRaw: [walletBalances[0].toString(), walletBalances[1].toString()], targetAmountsRaw: [amounts[0].toString(), amounts[1].toString()], walletSnapshotAt: now, salt: salt.toString(), shipStrategyHash: built.strategyHash, shipFundingSource: "WALLET_SNAPSHOT", stage: "SHIP_PREPARED", updatedAt: now };
  updatePlan(parameters.state, prepared, parameters.config);
  parameters.logger.info(`dock 后钱包余额已冻结：strategyHash=${prepared.sourceStrategyHash}，token0=${token0} raw=${walletBalances[0].toString()}，token1=${token1} raw=${walletBalances[1].toString()}，模式=${prepared.targetMode}，ship token0 raw=${amounts[0].toString()}，ship token1 raw=${amounts[1].toString()}，salt=${prepared.salt}，新策略=${prepared.shipStrategyHash}`);
  return prepared;
}

/** ship 仅使用 SHIP_PREPARED 已冻结的钱包金额；再次读取钱包只验证余额和 allowance，不能改变计划投入额。 */
async function executeShip(parameters: { plan: PersistedPlan; state: StateDocument; config: RebalanceConfig; client: ReturnType<typeof createPublicClient>; registry: Address; account: PrivateKeyAccount; chain: Chain; chainId: number; rpcUrl: string; logger: Logger; maximumAllowanceCache: Set<string> }): Promise<PersistedPlan> {
  let { plan } = parameters;
  if (plan.stage === "ACTIVE_LATEST") return plan;
  plan = await prepareShipFromWallet(parameters);
  if (plan.stage !== "SHIP_PREPARED" && plan.stage !== "SHIP_SENT") throw new Error(`ship 要求计划处于 SHIP_PREPARED 或 SHIP_SENT，实际=${plan.stage}`);
  const frozen = requireFrozenShipPlan(plan);
  const built = buildPlanStrategy(frozen, parameters.chainId, parameters.account.address);
  if (built.registry.toLowerCase() !== parameters.registry.toLowerCase()) throw new Error("新策略 registry 与 RPC 网络不一致");
  if (frozen.stage === "SHIP_SENT") {
    if (!frozen.shipTransactionHash) throw new Error("恢复 ship 计划缺少交易哈希，已停止避免重复广播");
    const receipt = await parameters.client.waitForTransactionReceipt({ hash: frozen.shipTransactionHash as Hex, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`恢复 ship 回执失败：${frozen.shipTransactionHash}`);
    const logs = receipt.logs as unknown as ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>;
    if (!hasEvent(logs, parameters.registry, parameters.account.address, built.app, built.strategyHash, "shipped")) throw new Error("恢复 ship 回执缺少匹配 Shipped 事件");
    verifyPushedEvents(logs, parameters.registry, parameters.account.address, built.app, built.strategyHash, frozen);
    if (!await newStrategyShipped(parameters.client, parameters.registry, parameters.account.address, built.app, frozen)) throw new Error("恢复 ship 后链上余额与计划不一致");
    registerCompletedObservation(parameters.state, frozen, built.strategyHash, parameters.config);
    parameters.logger.info(`恢复 ship 成功：strategyHash=${built.strategyHash}`);
    return frozen;
  }
  for (const [index, token] of frozen.tokens.entries()) {
    const amount = BigInt(frozen.targetAmountsRaw[index] ?? "");
    if (amount === 0n) continue;
    const plannedToken = requireAddress(token, "计划 token");
    const balance = await readTokenBalance(parameters.client, plannedToken, parameters.account.address);
    if (balance < amount) throw new Error(`钱包余额不足以执行已冻结计划：token=${token}，余额=${balance.toString()}，计划=${amount.toString()}`);
    const cacheKey = maximumAllowanceCacheKey(parameters.account.address, parameters.registry, plannedToken);
    if (parameters.maximumAllowanceCache.has(cacheKey)) {
      parameters.logger.info(`token=${plannedToken} 已由启动预检确认 MAX_UINT256，本进程跳过 allowance 检查`);
      continue;
    }
    const allowance = await readTokenAllowance(parameters.client, plannedToken, parameters.account.address, parameters.registry);
    const confirmedAllowance = await ensureMaximumAllowance({ publicClient: parameters.client, account: parameters.account, chain: parameters.chain, rpcUrl: parameters.rpcUrl, token: plannedToken, registry: parameters.registry, initialAllowance: allowance, requiredAmount: amount, dryRun: false, logger: parameters.logger });
    if (confirmedAllowance === MAX_UINT256) parameters.maximumAllowanceCache.add(cacheKey);
  }
  parameters.logger.info(`ship 使用已冻结的 dock 后钱包快照：strategyHash=${built.strategyHash}，token0 raw=${frozen.targetAmountsRaw[0]}，token1 raw=${frozen.targetAmountsRaw[1]}`);
  try {
    await parameters.client.call({ account: parameters.account.address, to: built.ship.to, data: built.ship.data, value: built.ship.value });
  } catch (error) {
    // 最大授权可能在运行中被外部 revoke；模拟失败后移除缓存，下一轮恢复同一计划时重新读取链上额度，而不是盲目重发 ship。
    for (const [index, token] of frozen.tokens.entries()) {
      if (BigInt(frozen.targetAmountsRaw[index] ?? "") > 0n) parameters.maximumAllowanceCache.delete(maximumAllowanceCacheKey(parameters.account.address, parameters.registry, requireAddress(token, "计划 token")));
    }
    throw error;
  }
  parameters.logger.info(`ship 链上模拟成功：strategyHash=${built.strategyHash}`);
  plan = { ...frozen, stage: "SHIP_SENT", updatedAt: Date.now() };
  updatePlan(parameters.state, plan, parameters.config);
  const transactionHash = await sendOrReconcileBroadcast({ account: parameters.account, chain: parameters.chain, rpcUrl: parameters.rpcUrl, transaction: built.ship, logger: parameters.logger, action: `ship strategyHash=${built.strategyHash}` });
  plan = { ...plan, shipTransactionHash: transactionHash, updatedAt: Date.now() };
  updatePlan(parameters.state, plan, parameters.config);
  parameters.logger.info(`ship 已广播：strategyHash=${built.strategyHash}，交易哈希=${transactionHash}`);
  const receipt = await parameters.client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`ship 回执失败：${transactionHash}`);
  const logs = receipt.logs as unknown as ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>;
  if (!hasEvent(logs, parameters.registry, parameters.account.address, built.app, built.strategyHash, "shipped")) throw new Error("ship 回执缺少匹配 Shipped 事件");
  const shipped = requireFrozenShipPlan(plan);
  verifyPushedEvents(logs, parameters.registry, parameters.account.address, built.app, built.strategyHash, shipped);
  for (const [index, token] of shipped.tokens.entries()) {
    const expected = BigInt(shipped.targetAmountsRaw[index] ?? "");
    const result = await parameters.client.readContract({ address: parameters.registry, abi: AquaAbi.AQUA_ABI, functionName: "rawBalances", args: [parameters.account.address, built.app, built.strategyHash as Hex, requireAddress(token, "计划 token")] }) as unknown as readonly [bigint, number];
    if (result[0] !== expected || result[1] !== 2) throw new Error(`ship 后链上余额复核失败：token=${token}`);
  }
  registerCompletedObservation(parameters.state, shipped, built.strategyHash, parameters.config);
  parameters.logger.info(`自动重挂完成：旧=${shipped.sourceStrategyHash}，新=${built.strategyHash}`);
  return shipped;
}

/**
 * 补足配置中缺失的 LP。该路径仅使用配置模板初始创建新仓位；已经存在的策略不会被此函数重置模式或资金比例。
 * 两个及以上缺口必须在同一笔 multicall 中创建，所有 receipt 与 rawBalances 复核通过后才一次写入槽位关联，避免部分创建。
 */
async function replenishConfiguredPositions(parameters: { missing: readonly PositionConfig[]; state: StateDocument; config: RebalanceConfig; client: ReturnType<typeof createPublicClient>; account: PrivateKeyAccount; chain: Chain; registry: Address; rpcUrl: string; logger: Logger }): Promise<void> {
  if (parameters.missing.length === 0) return;
  for (const position of parameters.missing) {
    parameters.logger.info(`检测到配置 LP 缺口：配置槽位=${position.id}，按 lp.add 模板创建初始仓位`);
  }
  const created = await addConfiguredPositions({ positions: parameters.missing, publicClient: parameters.client, account: parameters.account, chain: parameters.chain, chainId: parameters.config.chainId, registry: parameters.registry, rpcUrl: parameters.rpcUrl, logger: parameters.logger });
  const updatedAt = Date.now();
  for (const { positionId, strategyHash } of created) {
    parameters.state.configuredSlots[positionId] = { strategyHash, updatedAt };
    parameters.logger.info(`配置 LP 缺口已补足：配置槽位=${positionId}，strategyHash=${strategyHash}`);
  }
  saveRebalanceState(parameters.config.runtime.stateFile, parameters.state);
}

/**
 * 从一次 API/市场快照构造 dock 计划。API currentBalance.raw 只冻结为旧策略链上核验基准，绝不作为新策略投入额。
 * 新策略金额、salt 与 hash 必须等 dock 已确认后，以钱包真实余额在 SHIP_PREPARED 阶段一次性冻结。
 */
function createPlan(strategy: ApiStrategy, mode: RebalanceMode, current: bigint, config: RebalanceConfig, oldRange: { min: bigint; max: bigint }, reason: string, configuredPositionId?: string): PersistedPlan {
  const range = displayRangeForMode(current, mode, config);
  // API 的 decimals 是策略元数据的一部分；缺失或漂移已在 API 适配层拒绝，不能退化为 rawPrice 重挂。
  const aquaRange = convertDisplayRangeToAquaSqrtRange(strategy.tokens[0].address, strategy.tokens[0].decimals, strategy.tokens[1].address, strategy.tokens[1].decimals, range);
  const now = Date.now();
  return { logicalPositionKey: logicalKey(strategy), sourceStrategyHash: strategy.strategyHash, sourceStrategyBytes: strategy.strategyBytes, sourceApp: strategy.app, tokens: [strategy.tokens[0].address, strategy.tokens[1].address], sourceCurrentRaw: [strategy.tokens[0].currentBalance.raw.toString(), strategy.tokens[1].currentBalance.raw.toString()], targetMode: mode, targetSqrtPriceMin: aquaRange.sqrtPriceMin.toString(), targetSqrtPriceMax: aquaRange.sqrtPriceMax.toString(), fee: config.rebalance.fee, decisionReason: `${reason}；旧区间=${formatFixed(oldRange.min)}-${formatFixed(oldRange.max)}，新区间=${formatFixed(range.min)}-${formatFixed(range.max)}`, createdAt: now, updatedAt: now, stage: "PLAN_PERSISTED", ...(configuredPositionId === undefined ? {} : { configuredPositionId }) };
}

/** 每轮处理 API 返回的完整仓位集合；每个 strategyHash 都是独立仓位，同 pair 不再互相跳过。illiquidity 会在价格读取后直接创建重挂计划。 */
async function processSnapshot(parameters: { strategies: ApiStrategy[]; config: RebalanceConfig; state: StateDocument; account: PrivateKeyAccount; app: Address; logger: Logger; terminal?: RebalanceTerminalDashboard; execute: (plan: PersistedPlan) => Promise<void> }): Promise<void> {
  parameters.terminal?.beginSnapshot(parameters.strategies.length);
  const supported = parameters.strategies.filter((strategy) => {
    const reason = unsupportedStrategyReason(strategy, parameters.account.address, parameters.config.chainId, parameters.app);
    if (reason) {
      parameters.logger.info(`跳过 strategyHash=${strategy.strategyHash}：${reason}`);
      parameters.terminal?.upsert(dashboardPlaceholderRow(strategy, "BLOCK", reason));
      return false;
    }
    return true;
  });
  // illiquidity 是直接关闭重开，不依赖 Pair 市场接口；active 策略仍需要该独立价格源交叉校验。
  const uniquePairs = [...new Map(supported.filter((strategy) => strategy.classification.state === "active").map((strategy) => [marketKey(strategy.tokens), [strategy.tokens[0].address, strategy.tokens[1].address] as [Address, Address]])).values()];
  const marketResults = uniquePairs.length > 0 ? await getPairMarkets(parameters.config.chainId, uniquePairs) : [];
  const markets = new Map(uniquePairs.map((pair, index) => [`${pair[0].toLowerCase()}:${pair[1].toLowerCase()}`, marketResults[index]]));
  for (const strategy of supported) {
    const key = logicalKey(strategy); let existingPlan = parameters.state.plans[key];
    if (existingPlan && existingPlan.stage !== "ACTIVE_LATEST") {
      if (isRetryableBlockedPlan(existingPlan)) {
        // 此处只删除从未产生可追踪 raw 的安全重试计划；重新决策会完整重做 API、链上余额和模拟预检，绝不复用旧 calldata。
        const retryReason = /nonce too low/i.test(existingPlan.blockedReason ?? "") ? "nonce too low" : "RPC 预检临时创建失败";
        delete parameters.state.plans[key];
        saveRebalanceState(parameters.config.runtime.stateFile, parameters.state);
        parameters.logger.info(`检测到可安全重新决策的历史阻止计划：原因=${retryReason}，已删除并重新预检：逻辑仓位=${key}`);
        existingPlan = undefined;
      } else {
        const reason = `存在未完成或已阻止计划：${existingPlan.stage}`;
        parameters.logger.info(`逻辑仓位=${key} ${reason}，跳过新决策`);
        parameters.terminal?.upsert(dashboardPlaceholderRow(strategy, existingPlan.stage === "BLOCKED" ? "BLOCK" : "PLAN", reason));
        continue;
      }
    }
    if (existingPlan?.shipStrategyHash && existingPlan.shipStrategyHash.toLowerCase() !== strategy.strategyHash.toLowerCase()) { const reason = `等待策略 API 索引新 hash=${existingPlan.shipStrategyHash}`; parameters.logger.info(`逻辑仓位=${key} ${reason}，当前仍返回=${strategy.strategyHash}`); parameters.terminal?.upsert(dashboardPlaceholderRow(strategy, "PLAN", reason)); continue; }
    const recalculatedHash = AquaProtocolContract.calculateStrategyHash(new HexString(strategy.strategyBytes)).toString();
    if (recalculatedHash.toLowerCase() !== strategy.strategyHash.toLowerCase()) { parameters.logger.info(`跳过 strategyHash=${strategy.strategyHash}：strategyBytes hash 校验失败，实际=${recalculatedHash}`); continue; }
    const market = markets.get(marketKey(strategy.tokens));
    if (!market && strategy.classification.state === "active") throw new Error(`缺少 strategyHash=${strategy.strategyHash} 的 Pair 市场数据`);
    try {
      const currentResponse = await getCurrentPrice(strategy.tokens[0].address, strategy.tokens[1].address, strategy.chainId); currentTimestampValid(currentResponse.timestamp, parameters.config.polling.maxCurrentPriceAgeSeconds); const currentResult = parseDecimalFloor(currentResponse.priceText, 18, "EMSH current"); const current = currentResult.value; if (currentResult.truncated) parameters.logger.info(`EMSH current 精度处理：strategyHash=${strategy.strategyHash}，价格超过 18 位，向下取整；舍弃小数=${currentResult.discardedFraction}`);
      const priceDeviation = market ? relativePriceDeviationPercent(current, parseDecimal(String(market.lastPrice), 18, "Pair lastPrice")) : null;
      const maxDeviation = parsePercentage(parameters.config.market.maxPairPriceDeviationPercent, "maxPairPriceDeviationPercent");
      // Pair volumeUsd 的统计窗口和小额 pair 的聚合口径不稳定，仅作为日志观察；active 策略仍要求最少 swaps 与独立价格源交叉通过。
      const marketHealthy = market !== undefined && priceDeviation !== null && market.swaps >= parameters.config.market.minimumPairSwaps && priceDeviation <= maxDeviation;
      // 直接解析 sqrt 区间并按 API token decimals 恢复人类价格；先截断 rawPrice 会把 8/18 decimals 的窄区间压成同一个整数。
      const sqrtRange = parseConcentratedSqrtRange(strategy.strategyBytes);
      const display = convertAquaSqrtRangeToDisplayRange(strategy.tokens[0].address, strategy.tokens[0].decimals, strategy.tokens[1].address, strategy.tokens[1].decimals, sqrtRange);
      const oldRange = { ...display, current };
      const outside = outsideDistancePercent(current, oldRange); const excess = parsePercentage(parameters.config.rebalance.recenterExcess, "recenterExcess"); const observation = parameters.state.observations[key]; const prior = observation?.strategyHash === strategy.strategyHash ? observation : { strategyHash: strategy.strategyHash, breachCount: 0, lastShipAt: observation?.lastShipAt }; const breachCount = outside > excess ? prior.breachCount + 1 : 0; parameters.state.observations[key] = { ...prior, breachCount }; saveRebalanceState(parameters.config.runtime.stateFile, parameters.state);
      const cooldownElapsed = !prior.lastShipAt || Date.now() - prior.lastShipAt >= parameters.config.rebalance.cooldownSeconds * 1000;
      // illiquidity 不等待越界连续确认、冷却或 Pair 市场门槛；仍读取 current 来构造新价格区间，并保留所有 dock/ship 链上复核。
      const illiquidityRehangReason = strategy.classification.state === "illiquidity" ? "策略状态=illiquidity，按当前钱包余额直接关闭并重新开仓" : undefined;
      const decision = decideRebalance({ balances: { initial: [strategy.tokens[0].initialBalance.raw, strategy.tokens[1].initialBalance.raw], current: [strategy.tokens[0].currentBalance.raw, strategy.tokens[1].currentBalance.raw], usd: [strategy.tokens[0].currentBalance.usd, strategy.tokens[1].currentBalance.usd] }, currentPrice: current, oldRange, marketHealthy, stableBreach: breachCount >= parameters.config.polling.stableSnapshotsRequired, cooldownElapsed, recenterExcessPercent: excess, minValueRatioBps: parameters.config.rebalance.convertToTwoSidedMinValueRatioBps, forceRehangReason: illiquidityRehangReason });
      parameters.terminal?.upsert(dashboardRow(strategy, oldRange, outside, breachCount, parameters.config.polling.stableSnapshotsRequired, priceDeviation, decision));
      const pairSummary = market ? `Pair volumeUsd=${market.volumeUsd}，swaps=${market.swaps}，Pair/EMSH 偏离=${formatFixed(priceDeviation ?? 0n)}%` : "Pair 市场未读取（illiquidity 直接重挂）";
      parameters.logger.info(`监控 strategyHash=${strategy.strategyHash}，${pairSummary}，越界=${formatFixed(outside)}%，连续=${breachCount}/${parameters.config.polling.stableSnapshotsRequired}，决定=${decision.action}，原因=${decision.reason}`); logRange(parameters.logger, strategy, oldRange, "旧策略区间");
      if (decision.action === "rehang") {
        // 配置槽位关联只随计划迁移 hash，targetMode 仍完整保留本轮的动态成交决策。
        const configuredPositionId = configuredPositionIdForStrategyHash(parameters.state, strategy.strategyHash);
        const plan = createPlan(strategy, decision.targetMode, current, parameters.config, oldRange, decision.reason, configuredPositionId);
        parameters.state.plans[key] = plan;
        saveRebalanceState(parameters.config.runtime.stateFile, parameters.state);
        parameters.logger.info(`已生成自动计划：旧=${plan.sourceStrategyHash}，模式=${plan.targetMode}，配置槽位=${configuredPositionId ?? "未关联"}，新策略金额与 hash 将在 dock 确认后按钱包实际余额冻结，原因=${plan.decisionReason}`);
        await parameters.execute(plan);
      }
      if (decision.action === "block") parameters.logger.info(`阻止 strategyHash=${strategy.strategyHash}：${decision.reason}`);
    } catch (error) { const message = error instanceof Error ? error.message.split("\n")[0] : "未知错误"; parameters.logger.info(`跳过 strategyHash=${strategy.strategyHash}：${message}`); }
  }
}

/**
 * Bot 入口：TTY 使用动态面板且文件保留完整审计行；非 TTY 保持逐行输出，确保重定向和 CI 行为不变。
 * 锁和私钥均在 finally 清理，并在退出时复位 ANSI 样式，避免密码输入或启动校验失败后遗留状态文件锁或终端样式。
 */
async function main(): Promise<void> {
  const configPath = parseBotArguments();
  const terminal = new RebalanceTerminalDashboard(process.stdout);
  activeTerminal = terminal;
  const auditLogger = createLogger("logs", { writeToStdout: !terminal.enabled });
  const logger = terminal.enabled ? createDashboardLogger(auditLogger, terminal) : auditLogger;
  activeLogger = logger;
  const config = validateRebalanceConfig(readJsoncFile(configPath));
  const lpConfig = validateAddLpConfig(readJsoncFile(config.runtime.lpConfigPath));
  if (lpConfig.chainId !== config.chainId) throw new Error(`LP 配置 chainId=${lpConfig.chainId} 与 rebalance 配置 chainId=${config.chainId} 不一致`);
  logger.info(`启动自动再平衡 Bot：配置=${configPath}，LP 模板=${config.runtime.lpConfigPath}，目标仓位数=${lpConfig.positions.length}，chainId=${config.chainId}，日志=${logger.filePath}`);
  let release: (() => void) | undefined;
  let privateKey: Buffer | undefined;
  let cleaned = false;
  /** 正常返回、异常和可捕获终止信号共用此清理函数，确保锁与敏感内存恰好处理一次。 */
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    privateKey?.fill(0);
    release?.();
    terminal.close();
  };
  const removeTerminationHandler = installRebalanceTerminationHandler(process, (signal) => {
    try {
      logger.info(`收到 ${signal}，正在安全释放自动再平衡 Bot 资源`);
    } finally {
      cleanup();
      process.exit(0);
    }
  });
  try {
    release = acquireRebalanceLock(config.runtime.stateFile);
    const rpcUrl = readRpcUrl();
    logger.info(`已读取 RPC 配置：${maskRpcUrl(rpcUrl)}`);
    privateKey = await getDecryptedPrivateKey();
    const account = privateKeyToAccount(privateKey.toString("utf8") as Hex); const preliminary = createPublicClient({ transport: http(rpcUrl) }); const chainId = await preliminary.getChainId(); if (chainId !== config.chainId) throw new Error(`RPC chainId=${chainId} 与配置不一致`); const chain = defineChain({ id: chainId, name: `Aqua chain ${chainId}`, nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }); const client = createPublicClient({ chain, transport: http(rpcUrl) }); const registrySdk = AQUA_CONTRACT_ADDRESSES[chainId as NetworkEnum]; const appSdk = AQUA_SWAP_VM_CONTRACT_ADDRESSES[chainId as NetworkEnum]; if (!registrySdk || !appSdk) throw new Error(`SDK 不支持 chainId=${chainId}`); const registry = requireAddress(registrySdk.toString(), "Aqua registry"); const app = requireAddress(appSdk.toString(), "Aqua SwapVM app"); if (!await client.getCode({ address: registry })) throw new Error("Aqua registry 未检测到合约代码"); logger.info(`私钥解密与网络校验成功：maker=${account.address}，registry=${registry}，app=${app}`);
    const state = loadRebalanceState(config.runtime.stateFile);
    // 仅进程内保存已确认最大授权；不写入 state 文件，避免外部 revoke 后跨重启仍错误跳过链上检查。
    const maximumAllowanceCache = new Set<string>();
    let allowancePreflightCompleted = false;
    if (migrateStateKeys(state)) {
      saveRebalanceState(config.runtime.stateFile, state);
      logger.info("已将旧版不含 strategyHash 的状态 key 迁移为独立仓位 key");
    }
    const execute = async (plan: PersistedPlan): Promise<void> => {
      try {
        const docked = await executeDock({ plan, state, config, client, registry, account, chain, rpcUrl, logger });
        await executeShip({ plan: docked, state, config, client, registry, account, chain, chainId, rpcUrl, logger, maximumAllowanceCache });
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] || "未知错误" : "未知错误";
        if (message.startsWith("链上余额与 API 计划不一致")) {
          delete state.plans[plan.logicalPositionKey];
          saveRebalanceState(config.runtime.stateFile, state);
          logger.info(`API 快照计划已失效，下一轮重新拉取：逻辑仓位=${plan.logicalPositionKey}，原因=${message}`);
          return;
        }
        if (/nonce too low/i.test(message)) {
          // 节点明确拒绝旧 nonce 代表当前 raw 未被接收；放弃该未发送计划，下一轮重新读取 API 和 pending nonce，不能自动重发原交易。
          delete state.plans[plan.logicalPositionKey];
          saveRebalanceState(config.runtime.stateFile, state);
          logger.info(`nonce 已被占用，已放弃未发送计划并在下一轮重新决策：逻辑仓位=${plan.logicalPositionKey}，原因=${message}`);
          return;
        }
        const latest = state.plans[plan.logicalPositionKey] ?? plan;
        if (latest.stage === "DOCK_SENT" || latest.stage === "DOCK_VERIFIED" || latest.stage === "SHIP_PREPARED" || latest.stage === "SHIP_SENT") {
          // 广播过 dock/ship 后的 RPC 读取错误不能覆盖原阶段；下一轮必须只读恢复同一笔交易，禁止补建第二个仓位。
          logger.info(`存在已广播或已冻结的计划，保留原计划供下一轮恢复：逻辑仓位=${plan.logicalPositionKey}，阶段=${latest.stage}，原因=${message}`);
          return;
        }
        state.plans[plan.logicalPositionKey] = { ...latest, stage: "BLOCKED", blockedReason: message, updatedAt: Date.now() };
        saveRebalanceState(config.runtime.stateFile, state);
        logger.info(`自动执行已阻止：逻辑仓位=${plan.logicalPositionKey}，原因=${message}`);
      }
    };
    while (true) {
      try {
        for (const plan of Object.values(state.plans)) {
          if (plan.stage !== "ACTIVE_LATEST" && plan.stage !== "BLOCKED") {
            logger.info(`恢复未完成计划：逻辑仓位=${plan.logicalPositionKey}，阶段=${plan.stage}`);
            await execute(plan);
          }
        }
        const strategies = await getActiveStrategies(account.address, chainId);
        logger.info(`官方策略 API 返回 open 仓位数=${strategies.length}`);
        const missingConfiguredPositions = reconcileConfiguredPositionSlots({ state, lpConfig, strategies, indexingGraceMilliseconds: config.runtime.slotIndexingGraceSeconds * 1000 });
        saveRebalanceState(config.runtime.stateFile, state);
        logger.info(`配置 LP 对账完成：目标=${lpConfig.positions.length}，已关联=${lpConfig.positions.length - missingConfiguredPositions.length}，待补足=${missingConfiguredPositions.length}`);
        if (!allowancePreflightCompleted) {
          const authorizationStrategies = strategies.filter((strategy) => unsupportedStrategyReason(strategy, account.address, config.chainId, app) === null);
          await primeMaximumAllowanceCache({ client, strategies: authorizationStrategies, owner: account.address, registry, cache: maximumAllowanceCache, logger });
          allowancePreflightCompleted = true;
          logger.info(`启动授权预检完成：最大授权 token 数=${maximumAllowanceCache.size}`);
        }
        await replenishConfiguredPositions({ missing: missingConfiguredPositions, state, config, client, account, chain, registry, rpcUrl, logger });
        await processSnapshot({ strategies, config, state, account, app, logger, terminal, execute });
        terminal.render();
      } catch (error) {
        logger.info(`本轮监控失败：${error instanceof Error ? error.message.split("\n")[0] : "未知错误"}`);
        terminal.render();
      }
      await sleep(config.polling.intervalSeconds * 1000);
    }
  } finally {
    removeTerminationHandler();
    cleanup();
  }
}
if (import.meta.main) main().catch((error: unknown) => { const message = error instanceof Error ? error.message.split("\n")[0] : "未知错误"; if (activeLogger) activeLogger.info(`自动再平衡 Bot 退出：${message}`); else process.stderr.write(`${formatLogLine(`自动再平衡 Bot 退出：${message}`)}\n`); activeTerminal?.close(); process.exitCode = 1; });
