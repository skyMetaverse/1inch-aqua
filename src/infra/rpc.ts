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
    const maxFeePerGas = transaction.maxFeePerGas ?? fees.maxFeePerGas;
    const maxPriorityFeePerGas = transaction.maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas;
    if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined || maxFeePerGas < maxPriorityFeePerGas) {
      throw new Error("RPC 未返回有效 EIP-1559 gas fee");
    }
    const serialized = await account.signTransaction({
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
    return await publicClient.request({ method: "eth_sendRawTransaction", params: [serialized] });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0]?.trim() || "未知错误" : "未知错误";
    throw new Error(`本地签名交易准备或 raw 广播失败：${reason}`);
  }
}
