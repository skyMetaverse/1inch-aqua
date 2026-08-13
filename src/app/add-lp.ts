/**
 * Aqua 添加 LP 脚本入口：读取 JSONC 配置、精确计算 current 价格区间、完成最大授权并真实广播 ship。
 * 核心功能：复用加密私钥与本地签名，使用 EMSH current 作为唯一价格来源，支持双边/上单边/下单边。
 * 主要流程：配置校验 -> 链上余额与授权 -> current 原文价格 -> 无损区间 -> approve -> ship -> 事件和状态复核。
 */
import { existsSync, readFileSync } from "node:fs";
import {
  ABI as AquaAbi,
  AQUA_CONTRACT_ADDRESSES,
  NetworkEnum,
  PushedEvent,
  ShippedEvent,
} from "@1inch/aqua-sdk";
import { createPublicClient, defineChain, http, isAddress, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getDecryptedPrivateKey } from "../../scripts/encrypt-private-key.ts";
import { buildConcentratedStrategy } from "../aqua/strategy.ts";
import { readJsoncFile } from "../config/jsonc.ts";
import { validateAddLpConfig, type PositionConfig } from "../config/lp-config.ts";
import {
  calculateDisplayRange,
  calculatePercentAmount,
  convertDisplayRangeToAquaRange,
  FIXED_SCALE,
  formatFixed,
  invertFixedPrice,
  parseDecimalFloor,
  parsePercentage,
  percentageToAquaFeeValue,
} from "../domain/fixed.ts";
import { getCurrentPrice } from "../infra/emsh.ts";
import { ERC20_ABI, buildMaximumApprovalSteps, hasSufficientAllowance, readTokenState } from "../infra/erc20.ts";
import { createLogger, formatLogLine, type Logger } from "../infra/logger.ts";
import { sendLocallySignedTransaction, sendLocallySignedTransactions } from "../infra/rpc.ts";

const DEFAULT_CONFIG_PATH = "config/lp.add.jsonc";
const ENV_FILE = ".env";
const RPC_URL_FIELD = "RPC_URL";
const MAX_CURRENT_PRICE_AGE_SECONDS = 120;

interface PreparedShip {
  index: number;
  built: ReturnType<typeof buildConcentratedStrategy>;
  tokens: [Address, Address];
  amounts: [bigint, bigint];
}

let activeLogger: Logger | null = null;

/** 从 .env 精确读取 RPC 地址，不将整个 .env 加载进 process.env。 */
function readRpcUrl(): string {
  if (!existsSync(ENV_FILE)) throw new Error("未找到 .env 文件");
  const pattern = new RegExp(`^\\s*${RPC_URL_FIELD}\\s*=\\s*(.*?)\\s*$`);
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const value = line.match(pattern)?.[1]?.trim();
    if (value) {
      const quoted = value.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
      return quoted?.[1] ?? quoted?.[2] ?? value;
    }
  }
  throw new Error(`.env 中未找到 ${RPC_URL_FIELD}`);
}

/** RPC 日志仅显示协议与主机，避免密钥或路径泄露到运行记录。 */
function maskRpcUrl(rpcUrl: string): string {
  try {
    const parsed = new URL(rpcUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "无效 RPC URL";
  }
}

function requireAddress(value: string, fieldName: string): Address {
  if (!isAddress(value)) throw new Error(`${fieldName} 不是有效 EVM 地址`);
  return value;
}

/** 解析 CLI，仅允许一个配置路径和可选 --dry-run，避免静默忽略错误参数。 */
function parseArguments(): { configPath: string; dryRun: boolean } {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
    process.stdout.write("用法：bun run add-lp [配置文件路径] [--dry-run]\n");
    process.stdout.write(`默认配置文件：${DEFAULT_CONFIG_PATH}\n`);
    process.stdout.write("  --dry-run  查询、构建、授权预览并模拟 ship，但不广播 approve 或 ship。\n");
    process.exit(0);
  }
  const dryRun = argumentsList.includes("--dry-run");
  const paths = argumentsList.filter((argument) => argument !== "--dry-run");
  if (paths.length > 1) throw new Error("用法：bun run add-lp [配置文件路径] [--dry-run]");
  return { configPath: paths[0] ?? DEFAULT_CONFIG_PATH, dryRun };
}

/** current 时间必须接近本地时间；过期或明显未来数据都可能导致错误区间而被套利。 */
function verifyCurrentTimestamp(timestamp: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (timestamp > now + 60) throw new Error(`EMSH current 时间戳位于未来：${timestamp}`);
  if (now - timestamp > MAX_CURRENT_PRICE_AGE_SECONDS) {
    throw new Error(`EMSH current 数据已过期：${now - timestamp} 秒，最大允许 ${MAX_CURRENT_PRICE_AGE_SECONDS} 秒`);
  }
}

/** 依据模式检查单边资金方向，避免“单边”配置实际 ship 两种资产。 */
function validateAmountsForMode(position: PositionConfig, amounts: [bigint, bigint]): void {
  if (position.range.mode === "two-sided" && (amounts[0] === 0n || amounts[1] === 0n)) {
    throw new Error("双边模式要求两个 token 的 balancePercent 都计算出大于零的 raw amount");
  }
  // 配置价格是 1 token0 = N token1：区间在 current 上方时只应配置 token0；在下方时只应配置 token1。
  if (position.range.mode === "upper" && (amounts[0] === 0n || amounts[1] !== 0n)) {
    throw new Error("上单边模式要求 tokens[0] 投入大于零，tokens[1] 的 balancePercent 必须为 0%");
  }
  if (position.range.mode === "lower" && (amounts[0] !== 0n || amounts[1] === 0n)) {
    throw new Error("下单边模式要求 tokens[0] 的 balancePercent 必须为 0%，tokens[1] 投入大于零");
  }
}

/** 对一个 token 的最大授权进行预览或真实执行，并在每笔后复查状态。 */
export async function ensureMaximumAllowance(parameters: {
  publicClient: ReturnType<typeof createPublicClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  chain: Chain;
  rpcUrl: string;
  token: Address;
  registry: Address;
  initialAllowance: bigint;
  requiredAmount: bigint;
  dryRun: boolean;
  logger: Logger;
}): Promise<void> {
  const steps = buildMaximumApprovalSteps(
    parameters.initialAllowance,
    parameters.requiredAmount,
    parameters.registry,
  );
  if (steps.length === 0) {
    parameters.logger.info(`token=${parameters.token} 当前授权已覆盖本次投入，无需 approve：allowance=${parameters.initialAllowance.toString()}，所需=${parameters.requiredAmount.toString()}`);
    return;
  }

  for (const [index, step] of steps.entries()) {
    parameters.logger.info(`token=${parameters.token} 授权步骤 ${index + 1}/${steps.length}：${step.reason}，目标额度=${step.amount.toString()}`);
    if (parameters.dryRun) {
      // eth_call 不会保留前一步 approve(0) 的状态变化；清零后的授权不能在同一旧状态上模拟。
      if (index > 0) {
        parameters.logger.info(`dry-run：token=${parameters.token} 授权依赖前一步清零确认，已跳过旧 allowance 状态下的无效 eth_call 模拟`);
      } else {
        await parameters.publicClient.call({ account: parameters.account.address, to: parameters.token, data: step.data, value: 0n });
        parameters.logger.info(`dry-run：token=${parameters.token} approve 模拟成功`);
      }
      continue;
    }
    const hash = await sendLocallySignedTransaction(parameters.account, parameters.chain, http(parameters.rpcUrl), {
      to: parameters.token,
      data: step.data,
      value: 0n,
    });
    parameters.logger.info(`token=${parameters.token} approve 已广播：交易哈希=${hash}`);
    const receipt = await parameters.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    parameters.logger.info(`token=${parameters.token} approve 已确认：状态=${receipt.status}，区块=${receipt.blockNumber.toString()}`);
    if (receipt.status !== "success") throw new Error(`token=${parameters.token} approve 回执失败：${hash}`);
  }

  if (!parameters.dryRun) {
    const allowance = await parameters.publicClient.readContract({
      address: parameters.token,
      abi: (await import("../infra/erc20.ts")).ERC20_ABI,
      functionName: "allowance",
      args: [parameters.account.address, parameters.registry],
    });
    if (!hasSufficientAllowance(allowance, parameters.requiredAmount)) {
      throw new Error(`token=${parameters.token} 授权复查失败：实际=${allowance.toString()}，本次所需=${parameters.requiredAmount.toString()}`);
    }
    parameters.logger.info(`token=${parameters.token} 授权复查成功：实际=${allowance.toString()}，本次所需=${parameters.requiredAmount.toString()}`);
  }
}

/** 解析并验证 ship receipt 中的目标 Shipped 事件。 */
function verifyShippedEvent(
  logs: ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>,
  registry: Address,
  maker: Address,
  app: Address,
  strategyHash: Hex,
): void {
  const topic = ShippedEvent.TOPIC.toString().toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== registry.toLowerCase() || log.topics[0]?.toLowerCase() !== topic) continue;
    const event = ShippedEvent.fromLog({ data: log.data, topics: log.topics as unknown as [Hex, ...Hex[]] });
    if (event.maker.toString().toLowerCase() === maker.toLowerCase() && event.app.toString().toLowerCase() === app.toLowerCase() && event.strategyHash.toString().toLowerCase() === strategyHash.toLowerCase()) return;
  }
  throw new Error("ship 回执中未找到匹配的 Shipped 事件");
}

/** 处理一个配置仓位；从余额、价格到 ship 的每个外部边界均记录中文日志。 */
async function addPosition(parameters: {
  position: PositionConfig;
  index: number;
  publicClient: ReturnType<typeof createPublicClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  chain: Chain;
  chainId: number;
  registry: Address;
  rpcUrl: string;
  dryRun: boolean;
  logger: Logger;
  batchShip: boolean;
}): Promise<PreparedShip | undefined> {
  const { position, logger } = parameters;
  const token0 = requireAddress(position.pair.tokens[0].address, "tokens[0].address");
  const token1 = requireAddress(position.pair.tokens[1].address, "tokens[1].address");
  logger.info(`开始处理第 ${parameters.index + 1} 个 LP：${position.pair.tokens[0].symbol}(${token0}) / ${position.pair.tokens[1].symbol}(${token1})`);

  // 低额度 RPC 常限制瞬时 eth_call 数量；两个 token 也按顺序读取，避免六个只读调用同时触发限流。
  const state0 = await readTokenState(parameters.publicClient, token0, parameters.account.address, parameters.registry);
  const state1 = await readTokenState(parameters.publicClient, token1, parameters.account.address, parameters.registry);
  const balancePercent0 = parsePercentage(position.pair.tokens[0].balancePercent, "tokens[0].balancePercent");
  const balancePercent1 = parsePercentage(position.pair.tokens[1].balancePercent, "tokens[1].balancePercent");
  const amount0 = calculatePercentAmount(state0.balance, balancePercent0);
  const amount1 = calculatePercentAmount(state1.balance, balancePercent1);
  validateAmountsForMode(position, [amount0, amount1]);
  logger.info(`token0=${token0} decimals=${state0.decimals}，余额 raw=${state0.balance.toString()}，余额=${formatFixed(state0.balance, state0.decimals)}，比例=${position.pair.tokens[0].balancePercent}，投入 raw=${amount0.toString()}，投入=${formatFixed(amount0, state0.decimals)}，allowance=${state0.allowance.toString()}`);
  logger.info(`token1=${token1} decimals=${state1.decimals}，余额 raw=${state1.balance.toString()}，余额=${formatFixed(state1.balance, state1.decimals)}，比例=${position.pair.tokens[1].balancePercent}，投入 raw=${amount1.toString()}，投入=${formatFixed(amount1, state1.decimals)}，allowance=${state1.allowance.toString()}`);

  logger.info(`开始请求 EMSH current：chainId=${parameters.chainId}，价格方向=1 ${position.pair.tokens[0].symbol} = N ${position.pair.tokens[1].symbol}`);
  const currentResponse = await getCurrentPrice(token0, token1, parameters.chainId);
  verifyCurrentTimestamp(currentResponse.timestamp);
  const currentResult = parseDecimalFloor(currentResponse.priceText, 18, "EMSH current price");
  const current = currentResult.value;
  logger.info(`EMSH current 成功：price 原文=${currentResponse.priceText}，使用价格=${formatFixed(current)}，timestamp=${currentResponse.timestamp}，本地接收耗时=${currentResponse.elapsedMs}ms，原始响应=${currentResponse.rawResponse}`);
  if (currentResult.truncated) {
    logger.info(`EMSH current 精度处理：价格超过 18 位，向下取整；舍弃小数=${currentResult.discardedFraction}`);
  }

  const upperPercent = position.range.upperPercent ? parsePercentage(position.range.upperPercent, "upperPercent") : undefined;
  const lowerPercent = position.range.lowerPercent ? parsePercentage(position.range.lowerPercent, "lowerPercent") : undefined;
  const displayRange = calculateDisplayRange(current, position.range.mode, upperPercent, lowerPercent);
  const aquaRange = convertDisplayRangeToAquaRange(token0, token1, displayRange);
  const token0Config = position.pair.tokens[0];
  const token1Config = position.pair.tokens[1];
  const depositedToken = position.range.mode === "upper" ? token0Config : position.range.mode === "lower" ? token1Config : undefined;
  const rangeDescription = position.range.mode === "upper"
    ? `价格位于 current 上方，current 到上沿 +${position.range.upperPercent}`
    : position.range.mode === "lower"
      ? `价格位于 current 下方，下沿到 current +${position.range.lowerPercent}`
      : `价格覆盖 current，下沿到 current +${position.range.lowerPercent}，current 到上沿 +${position.range.upperPercent}`;
  logger.info(`仓位摘要：${position.range.mode === "upper" ? "上单边" : position.range.mode === "lower" ? "下单边" : "双边"}，${rangeDescription}，投入=${depositedToken ? `${depositedToken.symbol} ${depositedToken.balancePercent}` : `${token0Config.symbol} ${token0Config.balancePercent} + ${token1Config.symbol} ${token1Config.balancePercent}`}`);
  logger.info(`配置报价区间：1 ${token0Config.symbol} = ${formatFixed(displayRange.min)} 至 ${formatFixed(displayRange.max)} ${token1Config.symbol}；current=1 ${token0Config.symbol} = ${formatFixed(displayRange.current)} ${token1Config.symbol}`);
  logger.info(`反向报价区间：1 ${token1Config.symbol} = ${formatFixed(invertFixedPrice(displayRange.max))} 至 ${formatFixed(invertFixedPrice(displayRange.min))} ${token0Config.symbol}；current=1 ${token1Config.symbol} = ${formatFixed(invertFixedPrice(displayRange.current))} ${token0Config.symbol}`);
  logger.info(`链上审计价格：Aqua 方向=tokenGt/tokenLt，displayOrderCanonical=${aquaRange.isDisplayOrderCanonical}，rawPriceMin=${aquaRange.rawPriceMin.toString()}，rawPriceMax=${aquaRange.rawPriceMax.toString()}`);

  const feePercent = parsePercentage(position.fee, "fee");
  const feeValue = percentageToAquaFeeValue(feePercent);
  logger.info(`费率：配置=${position.fee}，Aqua 内部值=${feeValue.toString()}，SDK bps=${formatFixed(feePercent * 100n, 18)}`);
  const built = buildConcentratedStrategy({
    chainId: parameters.chainId,
    maker: parameters.account.address,
    rawPriceMin: aquaRange.rawPriceMin,
    rawPriceMax: aquaRange.rawPriceMax,
    feeValue,
    amounts: [{ token: token0, amount: amount0 }, { token: token1, amount: amount1 }],
  });
  if (built.registry.toLowerCase() !== parameters.registry.toLowerCase()) throw new Error("SDK strategy registry 与当前链 registry 不一致");
  logger.info(`策略构建成功：strategyHash=${built.strategyHash}，salt=${built.salt.toString()}，app=${built.app}，ship to=${built.ship.to}，ship data 字节数=${(built.ship.data.length - 2) / 2}`);

  // 仅对实际作为策略资金的一侧做授权；单边另一侧 amount=0 不会在策略中被 pull。
  if (amount0 > 0n) await ensureMaximumAllowance({ ...parameters, token: token0, initialAllowance: state0.allowance, requiredAmount: amount0 });
  if (amount1 > 0n) await ensureMaximumAllowance({ ...parameters, token: token1, initialAllowance: state1.allowance, requiredAmount: amount1 });

  await parameters.publicClient.call({ account: parameters.account.address, to: built.ship.to, data: built.ship.data, value: built.ship.value });
  logger.info(`ship 链上模拟成功：strategyHash=${built.strategyHash}`);
  if (parameters.dryRun) {
    logger.info(`dry-run：未广播 ship，strategyHash=${built.strategyHash}`);
    return undefined;
  }
  if (parameters.batchShip) {
    logger.info(`ship 已准备：strategyHash=${built.strategyHash}，等待批量广播`);
    return { index: parameters.index, built, tokens: [token0, token1], amounts: [amount0, amount1] };
  }

  const hash = await sendLocallySignedTransaction(parameters.account, parameters.chain, http(parameters.rpcUrl), built.ship);
  await verifyShipReceipt({ ...parameters, built, tokens: [token0, token1], amounts: [amount0, amount1], hash });
  return undefined;
}

async function verifyShipReceipt(parameters: {
  publicClient: ReturnType<typeof createPublicClient>;
  registry: Address;
  account: ReturnType<typeof privateKeyToAccount>;
  built: ReturnType<typeof buildConcentratedStrategy>;
  tokens: [Address, Address];
  amounts: [bigint, bigint];
  hash: Hex;
  logger: Logger;
  index: number;
}): Promise<void> {
  const { publicClient, registry, account, built, tokens, amounts, hash, logger } = parameters;
  logger.info(`ship 已广播：strategyHash=${built.strategyHash}，交易哈希=${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  logger.info(`ship 已确认：strategyHash=${built.strategyHash}，状态=${receipt.status}，区块=${receipt.blockNumber.toString()}`);
  if (receipt.status !== "success") throw new Error(`ship 回执失败：${hash}`);
  const receiptLogs = receipt.logs as unknown as ReadonlyArray<{ address: Address; data: Hex; topics: readonly Hex[] }>;
  verifyShippedEvent(receiptLogs, registry, account.address, built.app, built.strategyHash);
  logger.info(`Shipped 事件校验成功：strategyHash=${built.strategyHash}`);
  for (const [index, token] of tokens.entries()) {
    const expected = amounts[index] ?? 0n;
    if (expected > 0n) {
      const pushedTopic = PushedEvent.TOPIC.toString().toLowerCase();
      const pushed = receiptLogs.some((log) => {
        if (log.address.toLowerCase() !== registry.toLowerCase() || log.topics[0]?.toLowerCase() !== pushedTopic) return false;
        const event = PushedEvent.fromLog({ data: log.data, topics: log.topics as unknown as [Hex, ...Hex[]] });
        return event.maker.toString().toLowerCase() === account.address.toLowerCase() && event.app.toString().toLowerCase() === built.app.toLowerCase() && event.strategyHash.toString().toLowerCase() === built.strategyHash.toLowerCase() && event.token.toString().toLowerCase() === token.toLowerCase() && event.amount === expected;
      });
      if (!pushed) throw new Error(`ship 回执中未找到匹配的 Pushed 事件：token=${token}`);
      logger.info(`Pushed 事件校验成功：token=${token}，amount=${expected.toString()}`);
    } else {
      logger.info(`token=${token} 投入为 0，跳过 Pushed 事件校验，继续复核 rawBalances`);
    }
    const [balance, tokensCount] = await publicClient.readContract({ address: registry, abi: AquaAbi.AQUA_ABI, functionName: "rawBalances", args: [account.address, built.app, built.strategyHash, token] }) as readonly [bigint, number];
    logger.info(`ship 后链上复核：token=${token}，虚拟余额=${balance.toString()}，tokensCount=${tokensCount}`);
    if (balance !== expected || tokensCount !== 2) throw new Error(`ship 后虚拟余额复核失败：token=${token}`);
  }
  logger.info(`第 ${parameters.index + 1} 个 LP 添加完成：strategyHash=${built.strategyHash}`);
}

/**
 * 批量提交已经完成模拟的 ship。
 * 发送前重新合计同一 token 的 raw 投入，避免多个仓位各自模拟成功但合计超过钱包余额。
 * JSON-RPC batch 可能部分成功；成功 hash 必须落日志，失败时禁止自动重发整批。
 */
async function broadcastPreparedShips(parameters: {
  ships: readonly PreparedShip[];
  publicClient: ReturnType<typeof createPublicClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  chain: Chain;
  rpcUrl: string;
  registry: Address;
  logger: Logger;
}): Promise<void> {
  const totals = new Map<string, { token: Address; amount: bigint }>();
  for (const ship of parameters.ships) {
    for (const [index, token] of ship.tokens.entries()) {
      const amount = ship.amounts[index] ?? 0n;
      const key = token.toLowerCase();
      const existing = totals.get(key);
      totals.set(key, { token, amount: (existing?.amount ?? 0n) + amount });
    }
  }
  for (const { token, amount } of totals.values()) {
    const balance = await parameters.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [parameters.account.address] }) as bigint;
    if (balance < amount) throw new Error(`批量 ship 前余额不足：token=${token}，最新余额=${balance.toString()}，合计投入=${amount.toString()}`);
    parameters.logger.info(`批量 ship 余额复核：token=${token}，最新余额=${balance.toString()}，合计投入=${amount.toString()}`);
  }
  const results = await sendLocallySignedTransactions(parameters.account, parameters.chain, http(parameters.rpcUrl, { batch: true }), parameters.ships.map((ship) => ship.built.ship));
  results.forEach((result, index) => {
    const ship = parameters.ships[index];
    if (result.hash) parameters.logger.info(`批量 ship 已提交：第 ${(ship?.index ?? index) + 1} 个 LP，strategyHash=${ship?.built.strategyHash ?? "unknown"}，交易哈希=${result.hash}`);
    if (result.error) parameters.logger.info(`批量 ship 提交失败：第 ${(ship?.index ?? index) + 1} 个 LP，原因=${result.error}`);
  });
  const failures = results.flatMap((result, index) => result.error ? [`第 ${(parameters.ships[index]?.index ?? index) + 1} 个 LP 广播失败：${result.error}`] : []);
  if (failures.length > 0) throw new Error(`批量 ship 部分失败：${failures.join("；")}；已成功 hash 已记录，禁止自动重发`);
  await Promise.all(parameters.ships.map(async (ship, index) => {
    const hash = results[index]?.hash;
    if (!hash) throw new Error(`第 ${ship.index + 1} 个 LP 未返回交易哈希`);
    await verifyShipReceipt({ publicClient: parameters.publicClient, registry: parameters.registry, account: parameters.account, built: ship.built, tokens: ship.tokens, amounts: ship.amounts, hash, logger: parameters.logger, index: ship.index });
  }));
}

async function main(): Promise<void> {
  const { configPath, dryRun } = parseArguments();
  const logger = createLogger();
  activeLogger = logger;
  logger.info(`开始执行添加 LP，模式=${dryRun ? "dry-run" : "真实广播"}，配置文件=${configPath}`);
  logger.info(`日志文件：${logger.filePath}`);
  const config = validateAddLpConfig(readJsoncFile(configPath));
  logger.info(`JSONC 配置校验成功：chainId=${config.chainId}，仓位数=${config.positions.length}`);

  const rpcUrl = readRpcUrl();
  logger.info(`已读取 RPC 配置：${maskRpcUrl(rpcUrl)}`);
  const privateKey = await getDecryptedPrivateKey();
  try {
    const account = privateKeyToAccount(privateKey.toString("utf8") as Hex);
    logger.info(`私钥解密成功，maker=${account.address}`);
    const preliminaryClient = createPublicClient({ transport: http(rpcUrl) });
    const rpcChainId = await preliminaryClient.getChainId();
    if (rpcChainId !== config.chainId) throw new Error(`RPC chainId=${rpcChainId} 与配置 chainId=${config.chainId} 不一致`);
    const chain = defineChain({ id: rpcChainId, name: `Aqua chain ${rpcChainId}`, nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const registryAddress = AQUA_CONTRACT_ADDRESSES[rpcChainId as NetworkEnum];
    if (!registryAddress) throw new Error(`当前 Aqua SDK 不支持 chainId=${rpcChainId}`);
    const registry = requireAddress(registryAddress.toString(), "Aqua registry");
    const code = await publicClient.getCode({ address: registry });
    if (!code || code === "0x") throw new Error(`Aqua registry=${registry} 未检测到合约代码`);
    logger.info(`RPC 与 Aqua registry 校验成功：chainId=${rpcChainId}，registry=${registry}`);

    const batchShip = config.positions.length > 2;
    if (batchShip && !dryRun) logger.info(`仓位数=${config.positions.length} > 2，启用 ship JSON-RPC 批量广播；链上仍为多笔独立交易`);
    const preparedShips: PreparedShip[] = [];
    for (const [index, position] of config.positions.entries()) {
      const prepared = await addPosition({ position, index, publicClient, account, chain, chainId: rpcChainId, registry, rpcUrl, dryRun, logger, batchShip });
      if (prepared) preparedShips.push(prepared);
    }
    if (batchShip && !dryRun) {
      await broadcastPreparedShips({ ships: preparedShips, publicClient, account, chain, rpcUrl, registry, logger });
    }
    logger.info(`${dryRun ? "添加 LP dry-run 完成" : "全部 LP 添加完成"}，仓位数=${config.positions.length}`);
  } finally {
    privateKey.fill(0);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message.split("\n")[0]?.trim() || "发生未知错误" : "发生未知错误";
    const line = `添加 LP 失败：${message}`;
    if (activeLogger) activeLogger.info(line);
    else process.stderr.write(`${formatLogLine(line)}\n`);
    process.exitCode = 1;
  });
}
