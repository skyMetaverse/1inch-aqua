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
import { readJsoncFile } from "../config/jsonc.ts";
import { calculateDisplayRange, convertAquaSqrtRangeToDisplayRange, convertDisplayRangeToAquaSqrtRange, formatFixed, parseDecimal, parseDecimalFloor, parsePercentage, percentageToAquaFeeValue } from "../domain/fixed.ts";
import { decideRebalance, outsideDistancePercent, relativePriceDeviationPercent, type RebalanceMode } from "../domain/rebalance.ts";
import { getActiveStrategies, getPairMarkets, type ApiStrategy, type PairMarket } from "../infra/aqua-api.ts";
import { readTokenState } from "../infra/erc20.ts";
import { getCurrentPrice } from "../infra/emsh.ts";
import { createLogger, formatLogLine, type Logger } from "../infra/logger.ts";
import { sendLocallySignedTransaction } from "../infra/rpc.ts";
import { acquireRebalanceLock, loadRebalanceState, saveRebalanceState, type PersistedPlan, type StateDocument } from "../infra/rebalance-state.ts";
import { ensureMaximumAllowance } from "./add-lp.ts";

const DEFAULT_CONFIG_PATH = "config/rebalance.jsonc";
const ENV_FILE = ".env";
const DOCKED_TOKENS_COUNT = 0xff;
let activeLogger: Logger | null = null;

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
function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function positionIdentity(strategy: Pick<LogicalPositionInput, "chainId" | "maker" | "app" | "tokens">): string { return `${strategy.chainId}:${strategy.maker.toLowerCase()}:${strategy.app.toLowerCase()}:${[strategy.tokens[0].address, strategy.tokens[1].address].map((value) => value.toLowerCase()).sort().join(":")}`; }
function marketKey(tokens: [{ address: Address }, { address: Address }]): string { return `${tokens[0].address.toLowerCase()}:${tokens[1].address.toLowerCase()}`; }

/** 同一 pair 的不同 strategyHash 是不同 Aqua 仓位，必须拥有独立观察计数和恢复计划。 */
type LogicalPositionInput = { chainId: number; maker: Address; app: Address; tokens: [{ address: Address }, { address: Address }]; strategyHash: Hex };
export function buildLogicalPositionKey(parameters: LogicalPositionInput): string { return `${positionIdentity(parameters)}:${parameters.strategyHash.toLowerCase()}`; }
function logicalKey(strategy: ApiStrategy): string { return buildLogicalPositionKey(strategy); }
function keyWithStrategyHash(key: string, strategyHash: string): string { return `${key.replace(/:0x[0-9a-f]{64}$/i, "")}:${strategyHash.toLowerCase()}`; }

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
function planAmounts(strategy: ApiStrategy, mode: RebalanceMode): [bigint, bigint] { const current: [bigint, bigint] = [strategy.tokens[0].currentBalance.raw, strategy.tokens[1].currentBalance.raw]; if (mode === "two-sided") { if (current[0] === 0n || current[1] === 0n) throw new Error("双边计划要求 API 两侧 currentBalance.raw 均大于零"); return current; } if (mode === "upper") { if (current[0] === 0n) throw new Error("上单边计划缺少 token0 余额"); return [current[0], 0n]; } if (current[1] === 0n) throw new Error("下单边计划缺少 token1 余额"); return [0n, current[1]]; }
function displayRangeForMode(current: bigint, mode: RebalanceMode, config: RebalanceConfig) { const width = mode === "two-sided" ? parsePercentage(config.rebalance.twoSidedHalfWidth, "twoSidedHalfWidth") : parsePercentage(config.rebalance.singleSidedWidth, "singleSidedWidth"); return calculateDisplayRange(current, mode, mode === "lower" ? undefined : width, mode === "upper" ? undefined : width); }
function updatePlan(state: StateDocument, plan: PersistedPlan, config: RebalanceConfig): void { state.plans[plan.logicalPositionKey] = plan; saveRebalanceState(config.runtime.stateFile, state); }

/** 重挂完成后把冷却观察迁移到新 strategyHash，旧计划仍作为 API 索引延迟期间的保护别名。 */
function registerCompletedObservation(state: StateDocument, plan: PersistedPlan, newStrategyHash: string, config: RebalanceConfig): void {
  const nextKey = keyWithStrategyHash(plan.logicalPositionKey, newStrategyHash);
  state.observations[nextKey] = { strategyHash: newStrategyHash, breachCount: 0, lastShipAt: Date.now() };
  state.plans[plan.logicalPositionKey] = { ...plan, shipStrategyHash: newStrategyHash, stage: "ACTIVE_LATEST", updatedAt: Date.now() };
  saveRebalanceState(config.runtime.stateFile, state);
}
function logRange(logger: Logger, strategy: ApiStrategy, range: { min: bigint; current: bigint; max: bigint }, prefix: string): void { logger.info(`${prefix}：1 ${strategy.tokens[0].symbol} = ${formatFixed(range.min)} 至 ${formatFixed(range.max)} ${strategy.tokens[1].symbol}；current=1 ${strategy.tokens[0].symbol} = ${formatFixed(range.current)} ${strategy.tokens[1].symbol}`); }

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
async function newStrategyShipped(client: ReturnType<typeof createPublicClient>, registry: Address, account: Address, app: Address, plan: PersistedPlan): Promise<boolean> {
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
function verifyPushedEvents(logs: ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>, registry: Address, maker: Address, app: Address, strategyHash: Hex, plan: PersistedPlan): void {
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
  let { plan } = parameters; if (plan.stage === "DOCK_VERIFIED" || plan.stage === "SHIP_SENT" || plan.stage === "ACTIVE_LATEST") return plan;
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
  const transactionHash = await sendLocallySignedTransaction(parameters.account, parameters.chain, http(parameters.rpcUrl), { to, data, value: dock.value });
  plan = { ...plan, dockTransactionHash: transactionHash, updatedAt: Date.now() }; updatePlan(parameters.state, plan, parameters.config); parameters.logger.info(`dock 已广播：strategyHash=${plan.sourceStrategyHash}，交易哈希=${transactionHash}`);
  const receipt = await parameters.client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 1 }); if (receipt.status !== "success") throw new Error(`dock 回执失败：${transactionHash}`);
  const logs = receipt.logs as unknown as ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>; if (!hasEvent(logs, parameters.registry, parameters.account.address, requireAddress(plan.sourceApp, "计划 sourceApp"), plan.sourceStrategyHash as Hex, "docked")) throw new Error("dock 回执缺少匹配 Docked 事件");
  for (const token of plan.tokens) { const result = await parameters.client.readContract({ address: parameters.registry, abi: AquaAbi.AQUA_ABI, functionName: "rawBalances", args: [parameters.account.address, requireAddress(plan.sourceApp, "计划 sourceApp"), plan.sourceStrategyHash as Hex, requireAddress(token, "计划 token")] }) as unknown as readonly [bigint, number]; if (result[0] !== 0n || result[1] !== DOCKED_TOKENS_COUNT) throw new Error(`dock 后链上复核失败：token=${token}`); }
  plan = { ...plan, stage: "DOCK_VERIFIED", updatedAt: Date.now() }; updatePlan(parameters.state, plan, parameters.config); parameters.logger.info(`dock 已确认并复核：strategyHash=${plan.sourceStrategyHash}`); return plan;
}

/** 以持久化 salt 和精确 sqrt 参数构建新策略，确保恢复过程不会产生第二个 hash 或丢失 mixed-decimals 区间。 */
function buildPlanStrategy(plan: PersistedPlan, chainId: number, maker: Address) {
  const built = buildConcentratedStrategy({ chainId, maker, sqrtPriceMin: BigInt(plan.targetSqrtPriceMin), sqrtPriceMax: BigInt(plan.targetSqrtPriceMax), feeValue: percentageToAquaFeeValue(parsePercentage(plan.fee, "计划 fee")), amounts: [{ token: requireAddress(plan.tokens[0], "计划 token0"), amount: BigInt(plan.targetAmountsRaw[0]) }, { token: requireAddress(plan.tokens[1], "计划 token1"), amount: BigInt(plan.targetAmountsRaw[1]) }], salt: BigInt(plan.salt) });
  if (built.strategyHash.toLowerCase() !== plan.shipStrategyHash.toLowerCase()) throw new Error("持久化计划的 ship strategyHash 与重建结果不一致"); return built;
}

/** ship 前仅按计划金额读取钱包余额与 allowance；不因链上读数改变已批准的 API 决策。 */
async function executeShip(parameters: { plan: PersistedPlan; state: StateDocument; config: RebalanceConfig; client: ReturnType<typeof createPublicClient>; registry: Address; account: PrivateKeyAccount; chain: Chain; chainId: number; rpcUrl: string; logger: Logger }): Promise<PersistedPlan> {
  let { plan } = parameters; if (plan.stage === "ACTIVE_LATEST") return plan;
  const built = buildPlanStrategy(plan, parameters.chainId, parameters.account.address); if (built.registry.toLowerCase() !== parameters.registry.toLowerCase()) throw new Error("新策略 registry 与 RPC 网络不一致");
  if (plan.stage === "SHIP_SENT") {
    if (!plan.shipTransactionHash) throw new Error("恢复 ship 计划缺少交易哈希，已停止避免重复广播");
    const receipt = await parameters.client.waitForTransactionReceipt({ hash: plan.shipTransactionHash as Hex, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`恢复 ship 回执失败：${plan.shipTransactionHash}`);
    const logs = receipt.logs as unknown as ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>;
    if (!hasEvent(logs, parameters.registry, parameters.account.address, built.app, built.strategyHash, "shipped")) throw new Error("恢复 ship 回执缺少匹配 Shipped 事件");
    verifyPushedEvents(logs, parameters.registry, parameters.account.address, built.app, built.strategyHash, plan);
    if (!await newStrategyShipped(parameters.client, parameters.registry, parameters.account.address, built.app, plan)) throw new Error("恢复 ship 后链上余额与计划不一致");
    registerCompletedObservation(parameters.state, plan, built.strategyHash, parameters.config); parameters.logger.info(`恢复 ship 成功：strategyHash=${built.strategyHash}`); return plan;
  }
  for (const [index, token] of plan.tokens.entries()) { const amount = BigInt(plan.targetAmountsRaw[index] ?? ""); if (amount === 0n) continue; const tokenState = await readTokenState(parameters.client, requireAddress(token, "计划 token"), parameters.account.address, parameters.registry); if (tokenState.balance < amount) throw new Error(`钱包余额不足以恢复计划：token=${token}，余额=${tokenState.balance.toString()}，计划=${amount.toString()}`); await ensureMaximumAllowance({ publicClient: parameters.client, account: parameters.account, chain: parameters.chain, rpcUrl: parameters.rpcUrl, token: requireAddress(token, "计划 token"), registry: parameters.registry, initialAllowance: tokenState.allowance, requiredAmount: amount, dryRun: false, logger: parameters.logger }); }
  await parameters.client.call({ account: parameters.account.address, to: built.ship.to, data: built.ship.data, value: built.ship.value }); parameters.logger.info(`ship 链上模拟成功：strategyHash=${built.strategyHash}`);
  plan = { ...plan, stage: "SHIP_SENT", updatedAt: Date.now() }; updatePlan(parameters.state, plan, parameters.config);
  const transactionHash = await sendLocallySignedTransaction(parameters.account, parameters.chain, http(parameters.rpcUrl), built.ship); plan = { ...plan, shipTransactionHash: transactionHash, updatedAt: Date.now() }; updatePlan(parameters.state, plan, parameters.config); parameters.logger.info(`ship 已广播：strategyHash=${built.strategyHash}，交易哈希=${transactionHash}`);
  const receipt = await parameters.client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 1 }); if (receipt.status !== "success") throw new Error(`ship 回执失败：${transactionHash}`);
  const logs = receipt.logs as unknown as ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>; if (!hasEvent(logs, parameters.registry, parameters.account.address, built.app, built.strategyHash, "shipped")) throw new Error("ship 回执缺少匹配 Shipped 事件");
  verifyPushedEvents(logs, parameters.registry, parameters.account.address, built.app, built.strategyHash, plan);
  for (const [index, token] of plan.tokens.entries()) { const expected = BigInt(plan.targetAmountsRaw[index] ?? ""); const result = await parameters.client.readContract({ address: parameters.registry, abi: AquaAbi.AQUA_ABI, functionName: "rawBalances", args: [parameters.account.address, built.app, built.strategyHash, requireAddress(token, "计划 token")] }) as unknown as readonly [bigint, number]; if (result[0] !== expected || result[1] !== 2) throw new Error(`ship 后链上余额复核失败：token=${token}`); }
  registerCompletedObservation(parameters.state, plan, built.strategyHash, parameters.config); parameters.logger.info(`自动重挂完成：旧=${plan.sourceStrategyHash}，新=${built.strategyHash}`); return plan;
}

/** 从一次 API/市场快照构造计划，计划中冻结 API raw 余额和随机 salt，后续不再修改策略参数。 */
function createPlan(strategy: ApiStrategy, mode: RebalanceMode, current: bigint, config: RebalanceConfig, account: Address, oldRange: { min: bigint; max: bigint }, reason: string): PersistedPlan {
  const range = displayRangeForMode(current, mode, config);
  // API 的 decimals 是策略元数据的一部分；缺失或漂移已在 API 适配层拒绝，不能退化为 rawPrice 重挂。
  const aquaRange = convertDisplayRangeToAquaSqrtRange(strategy.tokens[0].address, strategy.tokens[0].decimals, strategy.tokens[1].address, strategy.tokens[1].decimals, range);
  const amounts = planAmounts(strategy, mode);
  const salt = BigInt(`0x${randomBytes(8).toString("hex")}`);
  const built = buildConcentratedStrategy({ chainId: strategy.chainId, maker: account, sqrtPriceMin: aquaRange.sqrtPriceMin, sqrtPriceMax: aquaRange.sqrtPriceMax, feeValue: percentageToAquaFeeValue(parsePercentage(config.rebalance.fee, "rebalance.fee")), amounts: [{ token: strategy.tokens[0].address, amount: amounts[0] }, { token: strategy.tokens[1].address, amount: amounts[1] }], salt });
  const now = Date.now();
  return { logicalPositionKey: logicalKey(strategy), sourceStrategyHash: strategy.strategyHash, sourceStrategyBytes: strategy.strategyBytes, sourceApp: strategy.app, tokens: [strategy.tokens[0].address, strategy.tokens[1].address], sourceCurrentRaw: [strategy.tokens[0].currentBalance.raw.toString(), strategy.tokens[1].currentBalance.raw.toString()], targetMode: mode, targetAmountsRaw: [amounts[0].toString(), amounts[1].toString()], targetSqrtPriceMin: aquaRange.sqrtPriceMin.toString(), targetSqrtPriceMax: aquaRange.sqrtPriceMax.toString(), fee: config.rebalance.fee, salt: salt.toString(), shipStrategyHash: built.strategyHash, decisionReason: `${reason}；旧区间=${formatFixed(oldRange.min)}-${formatFixed(oldRange.max)}，新区间=${formatFixed(range.min)}-${formatFixed(range.max)}`, createdAt: now, updatedAt: now, stage: "PLAN_PERSISTED" };
}

/** 每轮处理 API 返回的完整仓位集合；每个 strategyHash 都是独立仓位，同 pair 不再互相跳过。 */
async function processSnapshot(parameters: { strategies: ApiStrategy[]; config: RebalanceConfig; state: StateDocument; account: PrivateKeyAccount; app: Address; logger: Logger; execute: (plan: PersistedPlan) => Promise<void> }): Promise<void> {
  const supported = parameters.strategies.filter((strategy) => {
    if (strategy.maker.toLowerCase() !== parameters.account.address.toLowerCase() || strategy.chainId !== parameters.config.chainId || strategy.app.toLowerCase() !== parameters.app.toLowerCase() || strategy.classification.type !== "concentrated" || strategy.classification.state !== "active") {
      parameters.logger.info(`跳过 strategyHash=${strategy.strategyHash}：maker、chain、app 或策略类型不受支持`);
      return false;
    }
    return true;
  });
  const uniquePairs = [...new Map(supported.map((strategy) => [marketKey(strategy.tokens), [strategy.tokens[0].address, strategy.tokens[1].address] as [Address, Address]])).values()];
  const marketResults = await getPairMarkets(parameters.config.chainId, uniquePairs);
  const markets = new Map(uniquePairs.map((pair, index) => [`${pair[0].toLowerCase()}:${pair[1].toLowerCase()}`, marketResults[index]]));
  for (const strategy of supported) {
    const key = logicalKey(strategy); const existingPlan = parameters.state.plans[key];
    if (existingPlan && existingPlan.stage !== "ACTIVE_LATEST") { parameters.logger.info(`逻辑仓位=${key} 存在未完成或已阻止计划，跳过新决策：阶段=${existingPlan.stage}`); continue; }
    if (existingPlan && existingPlan.shipStrategyHash.toLowerCase() !== strategy.strategyHash.toLowerCase()) { parameters.logger.info(`逻辑仓位=${key} 等待策略 API 索引新 hash=${existingPlan.shipStrategyHash}，当前仍返回=${strategy.strategyHash}`); continue; }
    const recalculatedHash = AquaProtocolContract.calculateStrategyHash(new HexString(strategy.strategyBytes)).toString();
    if (recalculatedHash.toLowerCase() !== strategy.strategyHash.toLowerCase()) { parameters.logger.info(`跳过 strategyHash=${strategy.strategyHash}：strategyBytes hash 校验失败，实际=${recalculatedHash}`); continue; }
    const market = markets.get(marketKey(strategy.tokens)); if (!market) throw new Error(`缺少 strategyHash=${strategy.strategyHash} 的 Pair 市场数据`);
    try {
      const currentResponse = await getCurrentPrice(strategy.tokens[0].address, strategy.tokens[1].address, strategy.chainId); currentTimestampValid(currentResponse.timestamp, parameters.config.polling.maxCurrentPriceAgeSeconds); const currentResult = parseDecimalFloor(currentResponse.priceText, 18, "EMSH current"); const current = currentResult.value; if (currentResult.truncated) parameters.logger.info(`EMSH current 精度处理：strategyHash=${strategy.strategyHash}，价格超过 18 位，向下取整；舍弃小数=${currentResult.discardedFraction}`);
      const pairPrice = parseDecimal(String(market.lastPrice), 18, "Pair lastPrice"); const priceDeviation = relativePriceDeviationPercent(current, pairPrice); const maxDeviation = parsePercentage(parameters.config.market.maxPairPriceDeviationPercent, "maxPairPriceDeviationPercent"); const volumeMinimum = Number(parameters.config.market.minimumPairVolumeUsd);
      const marketHealthy = Number.isFinite(volumeMinimum) && market.volumeUsd >= volumeMinimum && market.swaps >= parameters.config.market.minimumPairSwaps && priceDeviation <= maxDeviation;
      // 直接解析 sqrt 区间并按 API token decimals 恢复人类价格；先截断 rawPrice 会把 8/18 decimals 的窄区间压成同一个整数。
      const sqrtRange = parseConcentratedSqrtRange(strategy.strategyBytes);
      const display = convertAquaSqrtRangeToDisplayRange(strategy.tokens[0].address, strategy.tokens[0].decimals, strategy.tokens[1].address, strategy.tokens[1].decimals, sqrtRange);
      const oldRange = { ...display, current };
      const outside = outsideDistancePercent(current, oldRange); const excess = parsePercentage(parameters.config.rebalance.recenterExcess, "recenterExcess"); const observation = parameters.state.observations[key]; const prior = observation?.strategyHash === strategy.strategyHash ? observation : { strategyHash: strategy.strategyHash, breachCount: 0, lastShipAt: observation?.lastShipAt }; const breachCount = outside > excess ? prior.breachCount + 1 : 0; parameters.state.observations[key] = { ...prior, breachCount }; saveRebalanceState(parameters.config.runtime.stateFile, parameters.state);
      const cooldownElapsed = !prior.lastShipAt || Date.now() - prior.lastShipAt >= parameters.config.rebalance.cooldownSeconds * 1000;
      const decision = decideRebalance({ balances: { initial: [strategy.tokens[0].initialBalance.raw, strategy.tokens[1].initialBalance.raw], current: [strategy.tokens[0].currentBalance.raw, strategy.tokens[1].currentBalance.raw], usd: [strategy.tokens[0].currentBalance.usd, strategy.tokens[1].currentBalance.usd] }, currentPrice: current, oldRange, marketHealthy, stableBreach: breachCount >= parameters.config.polling.stableSnapshotsRequired, cooldownElapsed, recenterExcessPercent: excess, minValueRatioBps: parameters.config.rebalance.convertToTwoSidedMinValueRatioBps });
      parameters.logger.info(`监控 strategyHash=${strategy.strategyHash}，Pair volumeUsd=${market.volumeUsd}，swaps=${market.swaps}，Pair/EMSH 偏离=${formatFixed(priceDeviation)}%，越界=${formatFixed(outside)}%，连续=${breachCount}/${parameters.config.polling.stableSnapshotsRequired}，决定=${decision.action}，原因=${decision.reason}`); logRange(parameters.logger, strategy, oldRange, "旧策略区间");
      if (decision.action === "rehang") { const plan = createPlan(strategy, decision.targetMode, current, parameters.config, parameters.account.address, oldRange, decision.reason); parameters.state.plans[key] = plan; saveRebalanceState(parameters.config.runtime.stateFile, parameters.state); parameters.logger.info(`已生成自动计划：旧=${plan.sourceStrategyHash}，新=${plan.shipStrategyHash}，模式=${plan.targetMode}，原因=${plan.decisionReason}`); await parameters.execute(plan); }
      if (decision.action === "block") parameters.logger.info(`阻止 strategyHash=${strategy.strategyHash}：${decision.reason}`);
    } catch (error) { const message = error instanceof Error ? error.message.split("\n")[0] : "未知错误"; parameters.logger.info(`跳过 strategyHash=${strategy.strategyHash}：${message}`); }
  }
}

async function main(): Promise<void> {
  const configPath = parseBotArguments(); const logger = createLogger(); activeLogger = logger; const config = validateRebalanceConfig(readJsoncFile(configPath)); logger.info(`启动自动再平衡 Bot：配置=${configPath}，chainId=${config.chainId}，日志=${logger.filePath}`);
  const release = acquireRebalanceLock(config.runtime.stateFile); const rpcUrl = readRpcUrl(); logger.info(`已读取 RPC 配置：${maskRpcUrl(rpcUrl)}`); const privateKey = await getDecryptedPrivateKey();
  try {
    const account = privateKeyToAccount(privateKey.toString("utf8") as Hex); const preliminary = createPublicClient({ transport: http(rpcUrl) }); const chainId = await preliminary.getChainId(); if (chainId !== config.chainId) throw new Error(`RPC chainId=${chainId} 与配置不一致`); const chain = defineChain({ id: chainId, name: `Aqua chain ${chainId}`, nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }); const client = createPublicClient({ chain, transport: http(rpcUrl) }); const registrySdk = AQUA_CONTRACT_ADDRESSES[chainId as NetworkEnum]; const appSdk = AQUA_SWAP_VM_CONTRACT_ADDRESSES[chainId as NetworkEnum]; if (!registrySdk || !appSdk) throw new Error(`SDK 不支持 chainId=${chainId}`); const registry = requireAddress(registrySdk.toString(), "Aqua registry"); const app = requireAddress(appSdk.toString(), "Aqua SwapVM app"); if (!await client.getCode({ address: registry })) throw new Error("Aqua registry 未检测到合约代码"); logger.info(`私钥解密与网络校验成功：maker=${account.address}，registry=${registry}，app=${app}`);
    const state = loadRebalanceState(config.runtime.stateFile);
    if (migrateStateKeys(state)) {
      saveRebalanceState(config.runtime.stateFile, state);
      logger.info("已将旧版不含 strategyHash 的状态 key 迁移为独立仓位 key");
    }
    const execute = async (plan: PersistedPlan): Promise<void> => {
      try {
        const docked = await executeDock({ plan, state, config, client, registry, account, chain, rpcUrl, logger });
        await executeShip({ plan: docked, state, config, client, registry, account, chain, chainId, rpcUrl, logger });
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] || "未知错误" : "未知错误";
        if (message.startsWith("链上余额与 API 计划不一致")) {
          delete state.plans[plan.logicalPositionKey];
          saveRebalanceState(config.runtime.stateFile, state);
          logger.info(`API 快照计划已失效，下一轮重新拉取：逻辑仓位=${plan.logicalPositionKey}，原因=${message}`);
          return;
        }
        const latest = state.plans[plan.logicalPositionKey] ?? plan;
        if (latest.stage === "DOCK_VERIFIED") {
          logger.info(`ship 尚未广播，保留原计划供下一轮恢复：逻辑仓位=${plan.logicalPositionKey}，原因=${message}`);
          return;
        }
        state.plans[plan.logicalPositionKey] = { ...latest, stage: "BLOCKED", blockedReason: message, updatedAt: Date.now() };
        saveRebalanceState(config.runtime.stateFile, state);
        logger.info(`自动执行已阻止：逻辑仓位=${plan.logicalPositionKey}，原因=${message}`);
      }
    };
    while (true) { try { for (const plan of Object.values(state.plans)) if (plan.stage !== "ACTIVE_LATEST" && plan.stage !== "BLOCKED") { logger.info(`恢复未完成计划：逻辑仓位=${plan.logicalPositionKey}，阶段=${plan.stage}`); await execute(plan); } const strategies = await getActiveStrategies(account.address, chainId); logger.info(`官方策略 API 返回 active 仓位数=${strategies.length}`); await processSnapshot({ strategies, config, state, account, app, logger, execute }); } catch (error) { logger.info(`本轮监控失败：${error instanceof Error ? error.message.split("\n")[0] : "未知错误"}`); } await sleep(config.polling.intervalSeconds * 1000); }
  } finally { privateKey.fill(0); release(); }
}
if (import.meta.main) main().catch((error: unknown) => { const message = error instanceof Error ? error.message.split("\n")[0] : "未知错误"; if (activeLogger) activeLogger.info(`自动再平衡 Bot 退出：${message}`); else process.stderr.write(`${formatLogLine(`自动再平衡 Bot 退出：${message}`)}\n`); process.exitCode = 1; });
