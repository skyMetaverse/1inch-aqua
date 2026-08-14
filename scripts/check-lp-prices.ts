/**
 * Aqua mixed-decimals LP 本地只读检查脚本。
 * 核心功能：检查 1INCH/WBTC、1INCH/cbBTC、1INCH/USDT 的链上 decimals、余额、EMSH current、价格区间和已有 active 策略。
 * 主要流程：读取本地 RPC 与 JSONC 配置 -> 只读查询 ERC20/Aqua/API -> 使用 decimals-aware sqrtPrice 计算 -> 输出投入 raw amount、展示价格和区间校验。
 * 安全边界：不读取或解密私钥，不调用 approve、dock、ship、eth_sendRawTransaction，也不执行交易模拟。
 */
import { existsSync, readFileSync } from "node:fs";
import { ABI as AquaAbi, AQUA_CONTRACT_ADDRESSES, NetworkEnum } from "@1inch/aqua-sdk";
import { createPublicClient, http, isAddress, type Address, type Hex } from "viem";
import { parseConcentratedSqrtRange } from "../src/aqua/strategy-parser.ts";
import { readJsoncFile } from "../src/config/jsonc.ts";
import { validateAddLpConfig, type PositionConfig } from "../src/config/lp-config.ts";
import {
  calculateDisplayRange,
  calculatePercentAmount,
  convertAquaSqrtRangeToDisplayRange,
  convertDisplayRangeToAquaSqrtRange,
  formatFixed,
  invertFixedPrice,
  parseDecimal,
  parseDecimalFloor,
  parsePercentage,
} from "../src/domain/fixed.ts";
import { getActiveStrategies, getPairMarkets, type ApiStrategy } from "../src/infra/aqua-api.ts";
import { ERC20_ABI, readTokenState } from "../src/infra/erc20.ts";
import { getCurrentPrice } from "../src/infra/emsh.ts";
import { createLogger, type Logger } from "../src/infra/logger.ts";

const DEFAULT_CONFIG_PATH = "config/lp.add.jsonc";
const ENV_FILE = ".env";
const ONE_INCH = "0x111111111117dc0aa78b770fa6a738034120c302" as Address;
const TARGETS = new Map<string, string>([
  ["0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", "WBTC"],
  ["0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", "cbBTC"],
  ["0xdac17f958d2ee523a2206206994597c13d831ec7", "USDT"],
]);
const MAX_CURRENT_AGE_SECONDS = 120;
const MAX_SQRT_ROUNDING_ERROR_PERCENT = 1_000_000_000_000n; // 0.000001%，仅覆盖 SDK sqrt 向下取整误差。

type ReadClient = ReturnType<typeof createPublicClient>;

function readRpcUrl(): string {
  if (!existsSync(ENV_FILE)) throw new Error("未找到 .env 文件");
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const value = line.match(/^\s*RPC_URL\s*=\s*(.*?)\s*$/)?.[1]?.trim();
    if (value) {
      const quoted = value.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
      return quoted?.[1] ?? quoted?.[2] ?? value;
    }
  }
  throw new Error(".env 中未找到 RPC_URL");
}

function parseArguments(): { configPath: string; maker: Address } {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("用法：bun run scripts/check-lp-prices.ts --maker <maker地址> [配置文件路径]\n");
    process.stdout.write(`默认配置文件：${DEFAULT_CONFIG_PATH}\n`);
    process.exit(0);
  }
  const makerText = args[args.indexOf("--maker") + 1];
  const configPaths = args.filter((item, index) => item !== "--maker" && args[index - 1] !== "--maker");
  if (typeof makerText !== "string" || !isAddress(makerText) || configPaths.length > 1 || configPaths.some((item) => item.startsWith("-"))) {
    throw new Error("用法：bun run scripts/check-lp-prices.ts --maker <maker地址> [配置文件路径]");
  }
  return { configPath: configPaths[0] ?? DEFAULT_CONFIG_PATH, maker: makerText as Address };
}

function verifyCurrentTimestamp(timestamp: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (timestamp > now + 60 || now - timestamp > MAX_CURRENT_AGE_SECONDS) {
    throw new Error(`EMSH current 已过期或时间位于未来：age=${now - timestamp}s`);
  }
}

function tokenLabel(position: PositionConfig): string {
  return `${position.pair.tokens[0].symbol}/${position.pair.tokens[1].symbol}`;
}

function matchingTarget(position: PositionConfig): string | undefined {
  const tokens = position.pair.tokens.map((item) => item.address.toLowerCase());
  if (tokens[0] !== ONE_INCH.toLowerCase()) return undefined;
  const token1 = tokens[1];
  return token1 ? TARGETS.get(token1) : undefined;
}

function absoluteDifference(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

function relativePercent(error: bigint, reference: bigint): bigint {
  if (reference <= 0n) throw new Error("价格参考值必须大于零");
  return (error * 100n * 10n ** 18n) / reference;
}

function logDisplayRange(logger: Logger, position: PositionConfig, current: bigint, range: { min: bigint; max: bigint }): void {
  logger.info(`配置区间：1 ${position.pair.tokens[0].symbol} = ${formatFixed(range.min)} 至 ${formatFixed(range.max)} ${position.pair.tokens[1].symbol}；current=${formatFixed(current)}；反向=${formatFixed(invertFixedPrice(range.max))} 至 ${formatFixed(invertFixedPrice(range.min))} ${position.pair.tokens[0].symbol}`);
}

async function readAquaBalances(client: ReadClient, registry: Address, strategy: ApiStrategy): Promise<[bigint, bigint]> {
  const values: bigint[] = [];
  for (const token of strategy.tokens) {
    const result = await client.readContract({
      address: registry,
      abi: AquaAbi.AQUA_ABI,
      functionName: "rawBalances",
      args: [strategy.maker, strategy.app, strategy.strategyHash, token.address],
    }) as readonly [bigint, number];
    values.push(result[0]);
  }
  return [values[0] ?? 0n, values[1] ?? 0n];
}

async function printExistingStrategies(logger: Logger, client: ReadClient, registry: Address, strategies: ApiStrategy[], target: string, position: PositionConfig): Promise<void> {
  const expected = new Set(position.pair.tokens.map((item) => item.address.toLowerCase()));
  const matches = strategies.filter((strategy) => strategy.tokens.every((token) => expected.has(token.address.toLowerCase())));
  if (matches.length === 0) {
    logger.info(`链上已有 active 策略：${target}=0`);
    return;
  }
  logger.info(`链上已有 active 策略：${target}=${matches.length}`);
  for (const strategy of matches) {
    const sqrtRange = parseConcentratedSqrtRange(strategy.strategyBytes);
    const display = convertAquaSqrtRangeToDisplayRange(
      position.pair.tokens[0].address,
      position.pair.tokens[0].address.toLowerCase() === strategy.tokens[0].address.toLowerCase() ? strategy.tokens[0].decimals : strategy.tokens[1].decimals,
      position.pair.tokens[1].address,
      position.pair.tokens[1].address.toLowerCase() === strategy.tokens[1].address.toLowerCase() ? strategy.tokens[1].decimals : strategy.tokens[0].decimals,
      sqrtRange,
    );
    const balances = await readAquaBalances(client, registry, strategy);
    logger.info(`已有策略：hash=${strategy.strategyHash}，区间=1 ${position.pair.tokens[0].symbol} ${formatFixed(display.min)}-${formatFixed(display.max)} ${position.pair.tokens[1].symbol}，rawBalances=[${balances[0].toString()},${balances[1].toString()}]，余额=${formatFixed(balances[0], strategy.tokens[0].decimals)}/${formatFixed(balances[1], strategy.tokens[1].decimals)}`);
  }
}

async function checkPosition(parameters: {
  logger: Logger;
  client: ReadClient;
  registry: Address;
  chainId: number;
  maker: Address;
  position: PositionConfig;
  market: Awaited<ReturnType<typeof getPairMarkets>>[number];
  strategies: ApiStrategy[];
}): Promise<void> {
  const { logger, client, registry, chainId, maker, position, market, strategies } = parameters;
  const target = matchingTarget(position);
  if (!target) throw new Error(`配置仓位不是目标顺序的 1INCH/WBTC、1INCH/cbBTC 或 1INCH/USDT：${tokenLabel(position)}`);
  const token0 = position.pair.tokens[0].address;
  const token1 = position.pair.tokens[1].address;
  logger.info(`========== 只读检查 ${tokenLabel(position)} (${target}) ==========`);
  const state0 = await readTokenState(client, token0, maker, registry);
  const state1 = await readTokenState(client, token1, maker, registry);
  const percent0 = parsePercentage(position.pair.tokens[0].balancePercent, `${target}.token0.balancePercent`);
  const percent1 = parsePercentage(position.pair.tokens[1].balancePercent, `${target}.token1.balancePercent`);
  const amount0 = calculatePercentAmount(state0.balance, percent0);
  const amount1 = calculatePercentAmount(state1.balance, percent1);
  logger.info(`链上 token0：address=${token0}，decimals=${state0.decimals}，balanceRaw=${state0.balance}，balance=${formatFixed(state0.balance, state0.decimals)}，配置比例=${position.pair.tokens[0].balancePercent}，计划投入Raw=${amount0}，计划投入=${formatFixed(amount0, state0.decimals)}`);
  logger.info(`链上 token1：address=${token1}，decimals=${state1.decimals}，balanceRaw=${state1.balance}，balance=${formatFixed(state1.balance, state1.decimals)}，配置比例=${position.pair.tokens[1].balancePercent}，计划投入Raw=${amount1}，计划投入=${formatFixed(amount1, state1.decimals)}`);
  logger.info(`只读 allowance：token0=${state0.allowance}，token1=${state1.allowance}；本脚本不会修改授权`);

  const currentResponse = await getCurrentPrice(token0, token1, chainId);
  verifyCurrentTimestamp(currentResponse.timestamp);
  const currentResult = parseDecimalFloor(currentResponse.priceText, 18, `${target} EMSH current`);
  const upper = position.range.upperPercent ? parsePercentage(position.range.upperPercent, `${target}.upperPercent`) : undefined;
  const lower = position.range.lowerPercent ? parsePercentage(position.range.lowerPercent, `${target}.lowerPercent`) : undefined;
  const displayRange = calculateDisplayRange(currentResult.value, position.range.mode, upper, lower);
  const sqrtRange = convertDisplayRangeToAquaSqrtRange(token0, state0.decimals, token1, state1.decimals, displayRange);
  logger.info(`EMSH current：原文=${currentResponse.priceText}，使用=${formatFixed(currentResult.value)} ${position.pair.tokens[1].symbol}/${position.pair.tokens[0].symbol}，timestamp=${currentResponse.timestamp}，age=${Math.floor(Date.now() / 1000) - currentResponse.timestamp}s`);
  logDisplayRange(logger, position, currentResult.value, displayRange);
  logger.info(`计划 Aqua 参数：tokenLtDecimals=${sqrtRange.isDisplayOrderCanonical ? state0.decimals : state1.decimals}，tokenGtDecimals=${sqrtRange.isDisplayOrderCanonical ? state1.decimals : state0.decimals}，sqrtPriceMin=${sqrtRange.sqrtPriceMin}，sqrtPriceMax=${sqrtRange.sqrtPriceMax}`);
  const recovered = convertAquaSqrtRangeToDisplayRange(token0, state0.decimals, token1, state1.decimals, sqrtRange);
  const minError = relativePercent(absoluteDifference(recovered.min, displayRange.min), displayRange.min);
  const maxError = relativePercent(absoluteDifference(recovered.max, displayRange.max), displayRange.max);
  const quantizationOkay = minError <= MAX_SQRT_ROUNDING_ERROR_PERCENT && maxError <= MAX_SQRT_ROUNDING_ERROR_PERCENT;
  logger.info(`sqrt 回读校验：恢复区间=${formatFixed(recovered.min)}-${formatFixed(recovered.max)}，下界相对误差=${formatFixed(minError)}%，上界相对误差=${formatFixed(maxError)}%，允许量化误差=${formatFixed(MAX_SQRT_ROUNDING_ERROR_PERCENT)}%，结果=${quantizationOkay ? "通过" : "失败"}`);
  const marketPrice = parseDecimal(String(market.lastPrice), 18, `${target} Pair lastPrice`);
  const difference = marketPrice > currentResult.value ? marketPrice - currentResult.value : currentResult.value - marketPrice;
  logger.info(`官方 Pair 市场交叉检查：lastPrice=${market.lastPrice}，与 EMSH 偏差=${formatFixed((difference * 100n * 10n ** 18n) / currentResult.value)}%（仅观察，不作为下单价格）`);
  await printExistingStrategies(logger, client, registry, strategies, target, position);
  logger.info(`安全结论：${quantizationOkay ? "当前 decimals-aware sqrt 区间可表达，未发现计算层套利倍率错误" : "sqrt 区间量化误差超限，禁止使用该配置"}`);
}

async function main(): Promise<void> {
  const { configPath, maker } = parseArguments();
  const logger = createLogger();
  const config = validateAddLpConfig(readJsoncFile(configPath));
  const rpcUrl = readRpcUrl();
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== config.chainId) throw new Error(`RPC chainId=${chainId} 与配置 chainId=${config.chainId} 不一致`);
  const registrySdk = AQUA_CONTRACT_ADDRESSES[chainId as NetworkEnum];
  if (!registrySdk) throw new Error(`SDK 不支持 chainId=${chainId}`);
  const registry = registrySdk.toString() as Address;
  if (!(await client.getCode({ address: registry }))) throw new Error(`Aqua registry 没有合约代码：${registry}`);
  logger.info(`启动只读 LP 价格检查：config=${configPath}，chainId=${chainId}，maker=${maker}，registry=${registry}`);
  logger.info("安全模式：只执行 eth_call/HTTP 查询，不解密私钥，不模拟交易，不发送任何交易");

  const positions = config.positions.filter((position) => matchingTarget(position));
  if (positions.length !== TARGETS.size) throw new Error(`配置中目标仓位数量=${positions.length}，必须恰好包含 WBTC、cbBTC、USDT 三个 1INCH pair`);
  const pairs = positions.map((position) => [position.pair.tokens[0].address, position.pair.tokens[1].address] as [Address, Address]);
  const [markets, strategies] = await Promise.all([getPairMarkets(chainId, pairs), getActiveStrategies(maker, chainId)]);
  for (const [index, position] of positions.entries()) {
    const market = markets[index];
    if (!market) throw new Error(`缺少第 ${index + 1} 个目标 pair 的市场数据`);
    await checkPosition({ logger, client, registry, chainId, maker, position, market, strategies });
  }
  logger.info("========== 只读检查完成：没有授权、dock、ship、eth_sendRawTransaction ==========");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message.split("\n")[0] : "未知错误";
    process.stderr.write(`[error] ${message}\n`);
    process.exitCode = 1;
  });
}
