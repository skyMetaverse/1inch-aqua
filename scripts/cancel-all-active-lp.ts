/**
 * Aqua 活跃 LP 一键取消脚本：通过 1inch Aqua 仓位查询接口发现当前 maker 的 open 仓位，并逐个发送 dock 交易。
 * 核心功能：复用加密私钥、校验 API 与链上策略状态、模拟 dock、广播交易并验证 Docked 事件和 docked 状态。
 * 主要流程：解密私钥 -> 查询 open 仓位 -> 链上预检 -> 串行 dock -> 等待回执 -> 记录中文运行日志。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  ABI as AquaAbi,
  AquaProtocolContract,
  AQUA_CONTRACT_ADDRESSES,
  Address,
  DockedEvent,
  HexString,
  NetworkEnum,
} from "@1inch/aqua-sdk";
import { createTransport, request, type Transport as WreqTransport } from "wreq-js";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  type Address as ViemAddress,
  type Chain,
  type Hex,
  type Transport as ViemTransport,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getDecryptedPrivateKey } from "./encrypt-private-key.ts";

const ENV_FILE = ".env";
const RPC_URL_FIELD = "RPC_URL";
const LOG_DIRECTORY = "logs";
const PROXY_API_BASE = "https://proxy-app.1inch.com/v2.0";
const API_POSITION_LIMIT = 100;
const DOCKED_TOKENS_COUNT = 0xff;
const BROWSER = "chrome_149";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** Aqua 页面 strategies/makers 接口中关闭仓位所需的最小字段集合。 */
interface MakerStrategy {
  chainId: number;
  maker: string;
  app: string;
  strategyHash: string;
  strategyBytes: string;
  tokens: Array<{ address: string }>;
  classification?: { type?: string; state?: string; feePercent?: number };
}

/** Aqua 页面 strategies/makers 接口响应。 */
interface MakerStrategiesResponse {
  items: MakerStrategy[];
}

/** 统一中文日志，同时写入终端和本次运行的独立文件。 */
interface Logger {
  readonly filePath: string;
  info(message: string): void;
}

/** 当前运行日志仅在业务执行阶段创建，帮助模式不创建空日志文件。 */
let activeLogger: Logger | null = null;

/**
 * 将本地时间格式化为指定日志格式。
 * 文件名不能包含冒号，以确保 Windows、macOS 和 Linux 均可创建日志文件。
 */
function formatTimestamp(forFileName: boolean): string {
  const now = new Date();
  const pad = (value: number, length = 2): string => String(value).padStart(length, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeSeparator = forFileName ? "-" : ":";
  const time = `${pad(now.getHours())}${timeSeparator}${pad(now.getMinutes())}${timeSeparator}${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  return `${date} ${time}`;
}

/**
 * 创建当前运行专属日志文件。
 * 所有业务日志保持 info 级别，避免不同模块自行拼接不一致的格式。
 */
function createLogger(): Logger {
  if (!existsSync(LOG_DIRECTORY)) {
    mkdirSync(LOG_DIRECTORY, { recursive: true });
  }

  const filePath = join(LOG_DIRECTORY, `${formatTimestamp(true)}.log`);
  writeFileSync(filePath, "", { encoding: "utf8", flag: "wx" });

  return {
    filePath,
    info(message: string): void {
      const line = `${formatTimestamp(false)} [info]: ${message}`;
      process.stdout.write(`${line}\n`);
      appendFileSync(filePath, `${line}\n`, "utf8");
    },
  };
}

/**
 * 从 .env 精确读取 RPC_URL，避免依赖进程环境是否已加载 .env。
 * 私钥由既有加密模块单独读取，不能在这里解析或记录加密私钥字段。
 */
function readRpcUrl(): string {
  if (!existsSync(ENV_FILE)) {
    throw new Error("未找到 .env 文件");
  }

  const fieldPattern = new RegExp(`^\\s*${RPC_URL_FIELD}\\s*=\\s*(.*?)\\s*$`);
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = line.match(fieldPattern);
    const value = match?.[1]?.trim();
    if (value) {
      const quoted = value.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
      return quoted?.[1] ?? quoted?.[2] ?? value;
    }
  }

  throw new Error(`.env 中未找到 ${RPC_URL_FIELD}`);
}

/** 仅记录 RPC 主机和端口，避免 URL 中的密钥、用户名和查询参数写入日志。 */
function maskRpcUrl(rpcUrl: string): string {
  try {
    const parsed = new URL(rpcUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "无效 RPC URL";
  }
}

/** 生成与 1inch 网页端一致的必要请求头。 */
function createApiHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    referer: "https://1inch.com/",
    "user-agent": USER_AGENT,
    "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * 从 1inch 网页端认证接口获取本次查询使用的 Bearer token。
 * 关闭脚本只查询一次仓位列表，因此不需要跨运行缓存 token。
 */
async function getAuthToken(transport: WreqTransport): Promise<string> {
  const response = await request({
    url: `${PROXY_API_BASE}/auth/token`,
    transport,
    headers: createApiHeaders(),
    method: "GET",
  });
  if (response.status !== 200) {
    throw new Error(`获取 1inch API 认证 token 失败：HTTP ${response.status}`);
  }

  const data = (await response.json()) as { access_token?: unknown };
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error("1inch API 认证 token 响应缺少 access_token");
  }
  return data.access_token;
}

/**
 * 调用 strategies/makers 接口获取当前 maker 的 open 仓位。
 * API 返回刚好达到 limit 时不能证明已取全，因此直接失败，避免一键关闭只处理部分仓位。
 */
async function getOpenStrategies(
  transport: WreqTransport,
  token: string,
  maker: ViemAddress,
  chainId: number,
): Promise<MakerStrategy[]> {
  const query = new URLSearchParams({
    status: "open",
    limit: String(API_POSITION_LIMIT),
    chainId: String(chainId),
  });
  const response = await request({
    url: `${PROXY_API_BASE}/aqua/v1.0/strategies/makers/${maker}?${query.toString()}`,
    transport,
    headers: createApiHeaders(token),
    method: "GET",
  });
  if (response.status !== 200) {
    throw new Error(`查询活跃 LP 仓位失败：HTTP ${response.status}`);
  }

  const data = (await response.json()) as MakerStrategiesResponse;
  if (!Array.isArray(data.items)) {
    throw new Error("活跃 LP 仓位接口响应缺少 items 数组");
  }
  if (data.items.length >= API_POSITION_LIMIT) {
    throw new Error(
      `接口返回 ${data.items.length} 条活跃仓位，已达到 limit=${API_POSITION_LIMIT}；无法确认是否存在分页或遗漏仓位，已停止执行以避免只关闭部分仓位`,
    );
  }
  return data.items;
}

/** 将 API 字段转换为经检查的 EVM 地址，防止把未知数据直接用于签名。 */
function requireAddress(value: string, fieldName: string): ViemAddress {
  if (!isAddress(value)) {
    throw new Error(`${fieldName} 不是有效 EVM 地址：${value}`);
  }
  return value as ViemAddress;
}

/** 校验 bytes32 strategyHash，避免 SDK 构建交易时接受截断或错误的哈希。 */
function requireStrategyHash(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`strategyHash 格式无效：${value}`);
  }
  return value as Hex;
}

/** 校验策略字节码是非空十六进制，完整 bytes 是哈希复核的必要条件。 */
function requireStrategyBytes(value: string): Hex {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error("strategyBytes 不是非空的偶数字节十六进制字符串");
  }
  return value as Hex;
}

/**
 * 校验 API 仓位资料与当前钱包、当前网络及链上策略状态一致。
 * app 必须采用仓位创建时的原始地址，不能用某个固定 router 覆盖，否则无法关闭其他受支持 Aqua app 的仓位。
 */
function validateStrategy(
  strategy: MakerStrategy,
  maker: ViemAddress,
  chainId: number,
): { app: ViemAddress; strategyHash: Hex; tokens: ViemAddress[] } {
  if (strategy.chainId !== chainId) {
    throw new Error(`策略 chainId=${strategy.chainId} 与 RPC chainId=${chainId} 不一致`);
  }

  const strategyMaker = requireAddress(strategy.maker, "策略 maker");
  if (strategyMaker.toLowerCase() !== maker.toLowerCase()) {
    throw new Error(`策略 maker=${strategyMaker} 与当前钱包=${maker} 不一致`);
  }

  const app = requireAddress(strategy.app, "策略 app");

  const strategyHash = requireStrategyHash(strategy.strategyHash);
  const strategyBytes = requireStrategyBytes(strategy.strategyBytes);
  const recalculatedHash = AquaProtocolContract.calculateStrategyHash(new HexString(strategyBytes)).toString();
  if (recalculatedHash.toLowerCase() !== strategyHash.toLowerCase()) {
    throw new Error(`strategyBytes 重新计算的 hash=${recalculatedHash} 与接口 strategyHash 不一致`);
  }

  if (!Array.isArray(strategy.tokens) || strategy.tokens.length === 0) {
    throw new Error("策略 tokens 为空，不能安全构建 dock 交易");
  }
  const tokens = strategy.tokens.map((token, index) => requireAddress(token.address, `策略 token[${index}]`));
  if (new Set(tokens.map((token) => token.toLowerCase())).size !== tokens.length) {
    throw new Error("策略 tokens 存在重复地址，不能安全构建 dock 交易");
  }

  return { app, strategyHash, tokens };
}

/**
 * 校验每个 token 的 Aqua 虚拟余额仍为活动状态。
 * dock 必须一次关闭策略全部 token；逐个读取 rawBalances 可避免 API 索引滞后导致的错误交易。
 */
async function verifyActiveRawBalances(
  publicClient: ReturnType<typeof createPublicClient>,
  registry: ViemAddress,
  maker: ViemAddress,
  app: ViemAddress,
  strategyHash: Hex,
  tokens: ViemAddress[],
  logger: Logger,
): Promise<void> {
  for (const token of tokens) {
    const result = (await publicClient.readContract({
      address: registry,
      abi: AquaAbi.AQUA_ABI,
      functionName: "rawBalances",
      args: [maker, app, strategyHash, token],
    })) as unknown as readonly [bigint, number];
    const [rawBalance, tokensCount] = result;
    logger.info(`链上预检 token=${token}，虚拟余额=${rawBalance.toString()}，tokensCount=${tokensCount}`);
    if (tokensCount !== tokens.length || tokensCount === DOCKED_TOKENS_COUNT) {
      throw new Error(`策略 token=${token} 未处于可关闭状态，tokensCount=${tokensCount}，预期=${tokens.length}`);
    }
  }
}

/**
 * 在 receipt 中查找并严格校验 Docked 事件。
 * receipt 成功还不足以证明目标策略关闭，因此必须核对 maker、app 和 strategyHash 三个字段。
 */
function verifyDockedEvent(
  logs: ReadonlyArray<{ address: ViemAddress; data: Hex; topics: readonly Hex[] }>,
  registry: ViemAddress,
  maker: ViemAddress,
  app: ViemAddress,
  strategyHash: Hex,
): void {
  const expectedTopic = DockedEvent.TOPIC.toString().toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== registry.toLowerCase() || log.topics[0]?.toLowerCase() !== expectedTopic) {
      continue;
    }

    const event = DockedEvent.fromLog({
      data: log.data,
      topics: log.topics as unknown as [Hex, ...Hex[]],
    });
    if (
      event.maker.toString().toLowerCase() === maker.toLowerCase() &&
      event.app.toString().toLowerCase() === app.toLowerCase() &&
      event.strategyHash.toString().toLowerCase() === strategyHash.toLowerCase()
    ) {
      return;
    }
  }
  throw new Error("交易回执中未找到与目标仓位匹配的 Docked 事件");
}

/** 关闭后回读 rawBalances，确认全部 token 已进入 docked 哨兵状态。 */
async function verifyDockedRawBalances(
  publicClient: ReturnType<typeof createPublicClient>,
  registry: ViemAddress,
  maker: ViemAddress,
  app: ViemAddress,
  strategyHash: Hex,
  tokens: ViemAddress[],
  logger: Logger,
): Promise<void> {
  for (const token of tokens) {
    const result = (await publicClient.readContract({
      address: registry,
      abi: AquaAbi.AQUA_ABI,
      functionName: "rawBalances",
      args: [maker, app, strategyHash, token],
    })) as unknown as readonly [bigint, number];
    const [rawBalance, tokensCount] = result;
    logger.info(`关闭后复核 token=${token}，虚拟余额=${rawBalance.toString()}，tokensCount=${tokensCount}`);
    if (rawBalance !== 0n || tokensCount !== DOCKED_TOKENS_COUNT) {
      throw new Error(`关闭后链上状态不符合预期：token=${token}，余额=${rawBalance.toString()}，tokensCount=${tokensCount}`);
    }
  }
}

/**
 * 本地签名并通过 eth_sendRawTransaction 广播交易。
 * 绝不能把裸地址作为 account 传给 viem，否则会退化为要求 RPC 节点代签的 eth_sendTransaction。
 */
export async function sendLocallySignedTransaction(
  account: PrivateKeyAccount,
  chain: Chain,
  transport: ViemTransport,
  transaction: {
    to: ViemAddress;
    data: Hex;
    value: bigint;
    nonce?: number;
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  },
): Promise<Hex> {
  const walletClient = createWalletClient({ account, chain, transport });
  return walletClient.sendTransaction(transaction);
}

/**
 * 逐个关闭策略，串行执行避免连续 wallet 交易产生 nonce 竞争。
 * dry-run 仍执行完整的 API、链上预检和 eth_call 模拟，但绝不广播交易。
 */
async function cancelStrategy(
  strategy: MakerStrategy,
  publicClient: ReturnType<typeof createPublicClient>,
  registry: ViemAddress,
  account: PrivateKeyAccount,
  chainId: number,
  chain: Chain,
  rpcUrl: string,
  dryRun: boolean,
  logger: Logger,
): Promise<void> {
  const maker = account.address;
  const { app, strategyHash, tokens } = validateStrategy(strategy, maker, chainId);
  logger.info(`开始处理仓位 strategyHash=${strategyHash}，app=${app}，代币数=${tokens.length}`);
  await verifyActiveRawBalances(publicClient, registry, maker, app, strategyHash, tokens, logger);

  const aqua = new AquaProtocolContract(new Address(registry));
  const dockTx = aqua.dock({
    app: new Address(app),
    strategyHash: new HexString(strategyHash),
    tokens: tokens.map((token) => new Address(token)),
  });
  const to = dockTx.to.toString() as ViemAddress;
  const data = dockTx.data.toString() as Hex;
  logger.info(`dock 交易已构建：to=${to}，data 字节数=${(data.length - 2) / 2}，value=${dockTx.value.toString()}`);

  // 先模拟再发送，确保 API 返回与当前链上状态之间未发生会导致 dock 回滚的变化。
  await publicClient.call({ account: maker, to, data, value: dockTx.value });
  logger.info(`dock 链上模拟成功：strategyHash=${strategyHash}`);

  if (dryRun) {
    logger.info(`dry-run 模式：未广播 dock 交易，strategyHash=${strategyHash}`);
    return;
  }

  let transactionHash: Hex;
  try {
    transactionHash = await sendLocallySignedTransaction(account, chain, http(rpcUrl), {
      to,
      data,
      value: dockTx.value,
    });
  } catch (error) {
    // viem 的完整错误可能包含 RPC URL 和 calldata；日志只保留首行可复盘原因，避免扩散敏感 RPC 信息。
    const reason = error instanceof Error ? error.message.split("\n")[0]?.trim() : "未知 RPC 错误";
    throw new Error(`dock 本地签名广播失败：${reason || "未知 RPC 错误"}`);
  }
  logger.info(`dock 交易已广播：strategyHash=${strategyHash}，交易哈希=${transactionHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash, confirmations: 1 });
  logger.info(`dock 交易已确认：strategyHash=${strategyHash}，状态=${receipt.status}，区块=${receipt.blockNumber.toString()}`);
  if (receipt.status !== "success") {
    throw new Error(`dock 交易回执失败：${transactionHash}`);
  }

  verifyDockedEvent(receipt.logs as unknown as ReadonlyArray<{ address: ViemAddress; data: Hex; topics: readonly Hex[] }>, registry, maker, app, strategyHash);
  logger.info(`Docked 事件校验成功：strategyHash=${strategyHash}`);
  await verifyDockedRawBalances(publicClient, registry, maker, app, strategyHash, tokens, logger);
  logger.info(`仓位关闭完成：strategyHash=${strategyHash}`);
}

/**
 * 脚本入口：查询当前 maker 全部 open 仓位并串行 dock。
 * 任一仓位失败后立即停止，防止出现未记录清楚的部分关闭状态。
 */
async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
    process.stdout.write("用法：bun run cancel-all-active-lp [--dry-run]\n");
    process.stdout.write("  --dry-run  查询、链上预检并模拟 dock，但不广播交易。\n");
    return;
  }
  const dryRun = argumentsList.includes("--dry-run");
  const unsupportedArguments = argumentsList.filter((argument) => argument !== "--dry-run");
  if (unsupportedArguments.length > 0) {
    throw new Error("用法：bun run cancel-all-active-lp [--dry-run]");
  }

  const logger = createLogger();
  activeLogger = logger;
  logger.info(`开始执行一键取消全部活跃 LP 仓位，模式=${dryRun ? "dry-run" : "真实广播"}`);
  logger.info(`日志文件：${logger.filePath}`);
  logger.info("说明：本脚本只发送 dock，不会撤销 ERC20 最大授权");

  const rpcUrl = readRpcUrl();
  logger.info(`已读取 RPC 配置：${maskRpcUrl(rpcUrl)}`);

  const decryptedPrivateKey = await getDecryptedPrivateKey();
  try {
    // viem 的账户构造 API 只能接收 0x 十六进制字符串；该字符串不记录、不返回也不持久化。
    const account = privateKeyToAccount(decryptedPrivateKey.toString("utf8") as Hex);
    const maker = account.address;
    logger.info(`私钥解密成功，当前 maker 钱包地址：${maker}`);

    const preliminaryClient = createPublicClient({ transport: http(rpcUrl) });
    const chainId = await preliminaryClient.getChainId();
    logger.info(`RPC 网络校验成功，chainId=${chainId}`);
    const chain = defineChain({
      id: chainId,
      name: `Aqua chain ${chainId}`,
      nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

    const network = chainId as NetworkEnum;
    const registryFromSdk = AQUA_CONTRACT_ADDRESSES[network];
    if (!registryFromSdk) {
      throw new Error(`当前 SDK 不支持 chainId=${chainId} 的 Aqua registry 地址`);
    }
    const registry = requireAddress(registryFromSdk.toString(), "Aqua registry");
    const registryCode = await publicClient.getCode({ address: registry });
    if (!registryCode || registryCode === "0x") {
      throw new Error(`Aqua registry=${registry} 未检测到合约代码`);
    }
    logger.info(`Aqua registry 合约校验成功：registry=${registry}`);

    const transport = await createTransport({ browser: BROWSER, poolMaxIdlePerHost: 8 });
    logger.info("开始获取 1inch API 认证 token");
    const authToken = await getAuthToken(transport);
    logger.info("1inch API 认证 token 获取成功");
    const strategies = await getOpenStrategies(transport, authToken, maker, chainId);
    logger.info(`已查询到 ${strategies.length} 个活跃 LP 仓位`);
    if (strategies.length === 0) {
      logger.info("当前 maker 没有活跃 LP 仓位，无需发送 dock 交易");
      return;
    }

    for (let index = 0; index < strategies.length; index += 1) {
      const strategy = strategies[index];
      if (!strategy) {
        throw new Error(`读取第 ${index + 1} 个仓位时发生意外空值`);
      }
      logger.info(`处理第 ${index + 1}/${strategies.length} 个活跃仓位`);
      await cancelStrategy(strategy, publicClient, registry, account, chainId, chain, rpcUrl, dryRun, logger);
    }

    logger.info(`${dryRun ? "dry-run 校验完成" : "全部活跃 LP 仓位已关闭"}，仓位数量=${strategies.length}`);
  } finally {
    // 即使 RPC、API 或交易失败，也必须清零调用方持有的解密私钥 Buffer。
    decryptedPrivateKey.fill(0);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "发生未知错误";
    const logMessage = `一键取消活跃 LP 仓位失败：${message}`;
    if (activeLogger) {
      activeLogger.info(logMessage);
    } else {
      process.stderr.write(`${formatTimestamp(false)} [info]: ${logMessage}\n`);
    }
    process.exitCode = 1;
  });
}
