/**
 * 本地私钥签名与 RPC 广播模块。
 * 核心功能：用 PrivateKeyAccount 在本机签名交易，通过 eth_sendRawTransaction 广播并等待成功回执。
 * 主要流程：构建本地 wallet client -> 广播已签名交易 -> 等待确认；禁止裸地址账户触发节点代签。
 */
import { createWalletClient, type Address, type Chain, type Hex, type Transport } from "viem";
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
 * 本地签名并发送交易。PrivateKeyAccount 是安全边界，不能用 address 字符串替代。
 * RPC 不需要也不应保管用户密钥，只会收到 eth_sendRawTransaction 的已签名交易。
 */
export async function sendLocallySignedTransaction(
  account: PrivateKeyAccount,
  chain: Chain,
  transport: Transport,
  transaction: TransactionRequest,
): Promise<Hex> {
  const walletClient = createWalletClient({ account, chain, transport });
  return walletClient.sendTransaction(transaction);
}
