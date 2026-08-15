/**
 * 本地私钥签名与 RPC 广播模块。
 * 核心功能：用 PrivateKeyAccount 在本机签名交易，通过 eth_sendRawTransaction 广播并等待成功回执。
 * 主要流程：读取 pending nonce/gas/最新区块 base fee -> 应用 .env 或 RPC 的 EIP-1559 fee -> 本地账户签名 -> eth_sendRawTransaction 广播；禁止裸地址账户触发节点代签。
 */
import { readFileSync } from "node:fs";
import { createPublicClient, keccak256, type Address, type Chain, type Hex, type Transport } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

export interface TransactionRequest {
  to: Address;
  data: Hex;
  value: bigint;
  nonce?: number;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface BatchBroadcastResult {
  hash?: Hex;
  error?: string;
}

/**
 * raw 广播的 HTTP 响应不确定时返回本地可验证交易 hash。节点可能已接收交易但未及时响应；调用方必须只读查询该 hash，严禁重发 raw transaction。
 */
export class RawBroadcastIndeterminateError extends Error {
  constructor(readonly transactionHash: Hex, reason: string) {
    super(`raw 广播响应不确定：本地交易哈希=${transactionHash}，原因=${reason}`);
    this.name = "RawBroadcastIndeterminateError";
  }
}

/** .env 中可选的 EIP-1559 绝对费率上限；单位转换后始终使用 wei。 */
export interface Eip1559FeeOverrides {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

const GWEI_IN_WEI = 1_000_000_000n;
const MAX_FEE_PER_GAS_FIELD = "MAX_FEE_PER_GAS_GWEI";
const MAX_PRIORITY_FEE_PER_GAS_FIELD = "MAX_PRIORITY_FEE_PER_GAS_GWEI";

/** 将最多九位小数的 gwei 文本精确转换为 wei，禁止浮点数导致费率精度漂移。 */
function parseGweiToWei(value: string, field: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) throw new Error(`.env 中 ${field} 必须是最多 9 位小数的非负 gwei 十进制数`);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole ?? "0") * GWEI_IN_WEI + BigInt(fraction.padEnd(9, "0"));
}

/** 从 dotenv 文本提取一个字段；空值表示未配置，避免将注释或其他环境变量带入费率解析。 */
function dotenvValue(content: string, field: string): string | undefined {
  const pattern = new RegExp(`^\\s*${field}\\s*=\\s*(.*?)\\s*$`);
  for (const line of content.split(/\r?\n/)) {
    const matched = line.match(pattern);
    if (!matched) continue;
    const value = matched[1]?.trim() ?? "";
    if (value === "") return undefined;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
    return value;
  }
  return undefined;
}

/**
 * 解析一对自定义 EIP-1559 上限。两项必须成对设置，避免只覆盖 priority 或 max fee 后无意混用 RPC 报价。
 * 环境配置绝不包含 base fee：基础费仍在每次签名前从最新链上区块读取并参与下限校验。
 */
export function parseEip1559FeeOverrides(dotenvContent: string): Eip1559FeeOverrides {
  const maxFeeText = dotenvValue(dotenvContent, MAX_FEE_PER_GAS_FIELD);
  const maxPriorityText = dotenvValue(dotenvContent, MAX_PRIORITY_FEE_PER_GAS_FIELD);
  if (maxFeeText === undefined && maxPriorityText === undefined) return {};
  if (maxFeeText === undefined || maxPriorityText === undefined) throw new Error(`.env 中 ${MAX_FEE_PER_GAS_FIELD} 与 ${MAX_PRIORITY_FEE_PER_GAS_FIELD} 必须同时设置`);
  const maxFeePerGas = parseGweiToWei(maxFeeText, MAX_FEE_PER_GAS_FIELD);
  const maxPriorityFeePerGas = parseGweiToWei(maxPriorityText, MAX_PRIORITY_FEE_PER_GAS_FIELD);
  if (maxFeePerGas <= 0n) throw new Error(`.env 中 ${MAX_FEE_PER_GAS_FIELD} 必须大于 0`);
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** 读取本地 .env 的自定义费率；没有 .env 时返回空配置，让测试和不依赖 dotenv 的调用保持可用。 */
export function readEip1559FeeOverrides(envPath = ".env"): Eip1559FeeOverrides {
  try {
    return parseEip1559FeeOverrides(readFileSync(envPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

/**
 * 只提取 RPC 错误的短文本，避免把可能包含 URL、raw transaction 或完整响应的大段内容写入日志。
 * viem 有时把节点错误包成通用顶层 message，真实原因位于 details 或 cause，因此必须有限深度地向内查找。
 */
function firstErrorLine(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object" && !seen.has(current); depth += 1) {
    seen.add(current);
    const value = current as { message?: unknown; details?: unknown; cause?: unknown };
    for (const candidate of [value.details, value.message]) {
      if (typeof candidate !== "string") continue;
      const line = candidate.split("\n")[0]?.trim();
      if (line && !messages.includes(line)) messages.push(line);
    }
    current = value.cause;
  }
  // 优先选择不是 viem 通用包装文本的节点原因；没有更具体信息时才回退到第一条。
  return messages.find((message) => !/^An unknown RPC error occurred\.?$/i.test(message)) ?? messages[0] ?? "未知错误";
}

/** 仅将网络级无响应归为不确定结果；合约、nonce、fee 或参数拒绝仍是确定失败，不能伪装成已广播。 */
function isIndeterminateBroadcastError(error: unknown): boolean {
  const message = firstErrorLine(error);
  return /(timed?\s*out|timeout|network error|fetch failed|socket hang up|econnreset|connection reset|connection aborted)/i.test(message);
}

interface Eip1559Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * 归一化 EIP-1559 fee。部分 RPC 返回 0 priority fee，但 Zan 等节点拒绝 zero tip；1 wei 是不改变报价量级的最小可接受值。
 * 即使 maxFee/priority 来自 .env，也必须用最新链上 base fee 验证 `maxFee >= baseFee + priority`，避免基础费上涨后签出无效交易。
 */
function resolveEip1559Fees(
  transaction: TransactionRequest,
  estimated: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint },
  baseFeePerGas: bigint,
  overrides: Eip1559FeeOverrides,
): Eip1559Fees {
  const maxFeePerGas = overrides.maxFeePerGas ?? transaction.maxFeePerGas ?? estimated.maxFeePerGas;
  const candidatePriorityFee = overrides.maxPriorityFeePerGas ?? transaction.maxPriorityFeePerGas ?? estimated.maxPriorityFeePerGas;
  if (maxFeePerGas === undefined || candidatePriorityFee === undefined || maxFeePerGas <= 0n || baseFeePerGas < 0n) {
    throw new Error("RPC 未返回有效 EIP-1559 gas fee 或链上 base fee");
  }
  const maxPriorityFeePerGas = candidatePriorityFee === 0n ? 1n : candidatePriorityFee;
  if (maxPriorityFeePerGas <= 0n || maxFeePerGas < maxPriorityFeePerGas) throw new Error("EIP-1559 maxFeePerGas 未覆盖 priority fee");
  if (maxFeePerGas < baseFeePerGas + maxPriorityFeePerGas) throw new Error(`EIP-1559 maxFeePerGas 未覆盖最新链上 base fee 与 priority fee：baseFeePerGas=${baseFeePerGas.toString()}，maxPriorityFeePerGas=${maxPriorityFeePerGas.toString()}`);
  return { maxFeePerGas, maxPriorityFeePerGas };
}

interface Eip1559FeeContext {
  baseFeePerGas: bigint;
  estimated: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };
}

/**
 * 读取当前区块基础费并获取必要的 RPC 费率估算。批量交易共享同一基础费快照，但仍可逐笔保留显式 fee 参数。
 * .env 覆盖优先于单次调用参数与 RPC 估算，确保所有发送入口采用同一用户配置；但 base fee 永远来自链上。
 */
async function readEip1559FeeContext(
  publicClient: ReturnType<typeof createPublicClient>,
  transactions: readonly TransactionRequest[],
  overrides: Eip1559FeeOverrides,
): Promise<Eip1559FeeContext> {
  if (transactions.length === 0) throw new Error("批量交易不能为空");
  const needsEstimatedFees = transactions.some((transaction) =>
    (overrides.maxFeePerGas ?? transaction.maxFeePerGas) === undefined
    || (overrides.maxPriorityFeePerGas ?? transaction.maxPriorityFeePerGas) === undefined,
  );
  const [latestBlock, estimated] = await Promise.all([
    publicClient.getBlock({ blockTag: "latest" }),
    needsEstimatedFees ? publicClient.estimateFeesPerGas() : Promise.resolve({}),
  ]);
  if (latestBlock.baseFeePerGas == null) throw new Error("最新链上区块未返回 EIP-1559 baseFeePerGas");
  return { baseFeePerGas: latestBlock.baseFeePerGas, estimated };
}

/** 使用明确参数构建一笔本地签名交易，避免 viem 隐式调用 eth_fillTransaction。 */
async function signPreparedTransaction(
  account: PrivateKeyAccount,
  chain: Chain,
  transaction: TransactionRequest,
  nonce: number,
  gas: bigint,
  fees: Eip1559Fees,
): Promise<Hex> {
  return account.signTransaction({
    chainId: chain.id,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
    type: "eip1559",
  });
}

/**
 * 本地准备、签名并发送交易。
 * viem 的 walletClient.sendTransaction 会自动尝试 eth_fillTransaction；部分 RPC 对该隐式方法返回笼统参数错误。
 * 因此这里显式读取 nonce、gas 和 EIP-1559 fee，再由 PrivateKeyAccount 签名，最后只调用 eth_sendRawTransaction。
 */
export async function sendLocallySignedTransaction(
  account: PrivateKeyAccount,
  chain: Chain,
  transport: Transport,
  transaction: TransactionRequest,
  feeOverrides: Eip1559FeeOverrides = readEip1559FeeOverrides(),
): Promise<Hex> {
  const publicClient = createPublicClient({ chain, transport });
  let nonce: number;
  try {
    nonce = transaction.nonce ?? await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  } catch (error) {
    throw new Error(`读取 pending nonce 失败：${firstErrorLine(error)}`);
  }

  let gas: bigint;
  try {
    gas = transaction.gas ?? await publicClient.estimateGas({ account: account.address, to: transaction.to, data: transaction.data, value: transaction.value });
  } catch (error) {
    throw new Error(`估算 gas 失败：nonce=${nonce}，原因=${firstErrorLine(error)}`);
  }

  let fees: Eip1559Fees;
  let serialized: Hex;
  try {
    const feeContext = await readEip1559FeeContext(publicClient, [transaction], feeOverrides);
    fees = resolveEip1559Fees(transaction, feeContext.estimated, feeContext.baseFeePerGas, feeOverrides);
    serialized = await signPreparedTransaction(account, chain, transaction, nonce, gas, fees);
  } catch (error) {
    throw new Error(`EIP-1559 fee 解析或本地签名失败：nonce=${nonce}，gas=${gas}，原因=${firstErrorLine(error)}`);
  }

  try {
    // raw 广播一旦得到网络级错误，节点接收状态不可假设；禁止自动重试，交由调用方只读确认后决定下一次操作。
    return await publicClient.request({ method: "eth_sendRawTransaction", params: [serialized] }, { retryCount: 0 });
  } catch (error) {
    const reason = firstErrorLine(error);
    if (isIndeterminateBroadcastError(error)) {
      // 已签名 raw 的 keccak256 是节点应返回的交易 hash；只提供查询锚点，不代表可安全重发。
      throw new RawBroadcastIndeterminateError(keccak256(serialized), reason);
    }
    throw new Error(`raw 广播失败：nonce=${nonce}，gas=${gas}，maxFeePerGas=${fees.maxFeePerGas ?? "unknown"}，maxPriorityFeePerGas=${fees.maxPriorityFeePerGas ?? "unknown"}，原因=${reason}`);
  }
}

/**
 * 为多笔独立交易分配连续 nonce 并本地签名，再按 nonce 顺序流水线提交。
 * 部分 RPC 支持 JSON-RPC request batch，却不会按数组顺序处理依赖 nonce 的 raw transaction；因此每笔收到 hash 后立即提交下一笔，但不等待区块确认。
 * 任一 nonce 广播失败时停止后续提交，避免创建永远受前序 nonce 缺口阻塞的交易。
 */
export async function sendLocallySignedTransactions(
  account: PrivateKeyAccount,
  chain: Chain,
  transport: Transport,
  transactions: readonly TransactionRequest[],
  feeOverrides: Eip1559FeeOverrides = readEip1559FeeOverrides(),
): Promise<BatchBroadcastResult[]> {
  if (transactions.length === 0) return [];
  const publicClient = createPublicClient({ chain, transport });
  try {
    const startNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    // 同一批独立交易共享本轮最新 base fee 与 RPC quote，避免每笔读取不同区块；最终 fee 仍按每笔显式参数解析。
    const feeContext = await readEip1559FeeContext(publicClient, transactions, feeOverrides);
    const gasValues = await Promise.all(transactions.map((transaction) => transaction.gas ?? publicClient.estimateGas({ account: account.address, to: transaction.to, data: transaction.data, value: transaction.value })));
    const serialized = await Promise.all(transactions.map((transaction, index) => signPreparedTransaction(
      account,
      chain,
      transaction,
      transaction.nonce ?? startNonce + index,
      gasValues[index] ?? 0n,
      resolveEip1559Fees(transaction, feeContext.estimated, feeContext.baseFeePerGas, feeOverrides),
    )));
    const results: BatchBroadcastResult[] = [];
    for (const [index, raw] of serialized.entries()) {
      try {
        const hash = await publicClient.request({ method: "eth_sendRawTransaction", params: [raw] }, { retryCount: 0 });
        if (typeof hash !== "string" || !hash.startsWith("0x")) throw new Error("RPC 返回无效交易哈希");
        results.push({ hash });
      } catch (error) {
        results.push({ error: firstErrorLine(error) });
        // 后续连续 nonce 依赖当前交易被节点接受；继续提交只会产生卡住的 future nonce 交易。
        for (let pendingIndex = index + 1; pendingIndex < serialized.length; pendingIndex += 1) {
          results.push({ error: `未提交：第 ${index + 1} 笔 nonce 广播失败` });
        }
        break;
      }
    }
    return results;
  } catch (error) {
    throw new Error(`批量交易准备或签名失败，尚未开始 raw 广播：${firstErrorLine(error)}`);
  }
}
