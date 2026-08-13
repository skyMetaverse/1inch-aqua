/**
 * 本地私钥签名与 RPC 广播模块。
 * 核心功能：用 PrivateKeyAccount 在本机签名交易，通过 eth_sendRawTransaction 广播并等待成功回执。
 * 主要流程：读取 nonce/gas/fee -> 本地账户签名 -> eth_sendRawTransaction 广播；禁止裸地址账户触发节点代签。
 */
import { createPublicClient, type Address, type Chain, type Hex, type Transport } from "viem";
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

/** 只保留错误首行，避免把 RPC 可能包含的大段原始响应重复写入终端日志。 */
function firstErrorLine(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]?.trim() || "未知错误" : "未知错误";
}

/** 使用明确参数构建一笔本地签名交易，避免 viem 隐式调用 eth_fillTransaction。 */
async function signPreparedTransaction(
  account: PrivateKeyAccount,
  chain: Chain,
  transaction: TransactionRequest,
  nonce: number,
  gas: bigint,
  fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint },
): Promise<Hex> {
  const maxFeePerGas = transaction.maxFeePerGas ?? fees.maxFeePerGas;
  const maxPriorityFeePerGas = transaction.maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas;
  if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined || maxFeePerGas < maxPriorityFeePerGas) {
    throw new Error("RPC 未返回有效 EIP-1559 gas fee");
  }
  return account.signTransaction({
    chainId: chain.id,
    nonce,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
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
): Promise<Hex> {
  const publicClient = createPublicClient({ chain, transport });
  try {
    const nonce = transaction.nonce ?? await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    const gas = transaction.gas ?? await publicClient.estimateGas({ account: account.address, to: transaction.to, data: transaction.data, value: transaction.value });
    const fees = transaction.maxFeePerGas !== undefined && transaction.maxPriorityFeePerGas !== undefined
      ? { maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas }
      : await publicClient.estimateFeesPerGas();
    const serialized = await signPreparedTransaction(account, chain, transaction, nonce, gas, fees);
    return await publicClient.request({ method: "eth_sendRawTransaction", params: [serialized] }, { retryCount: 0 });
  } catch (error) {
    throw new Error(`本地签名交易准备或 raw 广播失败：${firstErrorLine(error)}`);
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
): Promise<BatchBroadcastResult[]> {
  if (transactions.length === 0) return [];
  const publicClient = createPublicClient({ chain, transport });
  try {
    const startNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    const fees = await publicClient.estimateFeesPerGas();
    const gasValues = await Promise.all(transactions.map((transaction) => transaction.gas ?? publicClient.estimateGas({ account: account.address, to: transaction.to, data: transaction.data, value: transaction.value })));
    const serialized = await Promise.all(transactions.map((transaction, index) => signPreparedTransaction(account, chain, transaction, transaction.nonce ?? startNonce + index, gasValues[index] ?? 0n, fees)));
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
