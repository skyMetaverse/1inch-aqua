/**
 * 一键取消活跃 LP 脚本的本地签名回归测试。
 * 核心功能：验证私钥账户广播 dock 类交易时使用 eth_sendRawTransaction，而非要求 RPC 代签的 eth_sendTransaction。
 * 主要流程：构造固定测试私钥和捕获型 transport -> 调用本地签名函数 -> 断言 RPC 方法和 raw transaction 参数。
 */

import { expect, test } from "bun:test";
import { custom, defineChain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sendLocallySignedTransaction } from "./cancel-all-active-lp.ts";

/** 测试专用链定义；不连接公共 RPC，也不携带任何真实账户或真实节点信息。 */
const testChain = defineChain({
  id: 1,
  name: "Local signing test chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:0"] } },
});

/**
 * 固定无资产测试私钥，仅用于验证 SDK 在本地签名后选择的 JSON-RPC 方法。
 * 该密钥不是项目 .env 私钥，测试过程中不访问网络。
 */
const testAccount = privateKeyToAccount(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
);

/**
 * 捕获钱包 client 的 JSON-RPC 请求。
 * 返回伪造交易哈希即可使 sendTransaction 完成，从而精确检查是否错误调用节点代签接口。
 */
test("本地私钥账户必须通过 eth_sendRawTransaction 广播", async () => {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  const transport = custom({
    async request(args: { method: string; params?: unknown[] }): Promise<Hex> {
      requests.push(args);
      if (args.method === "eth_sendRawTransaction") {
        return "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      }
      throw new Error(`不应调用 RPC 方法：${args.method}`);
    },
  });

  const transactionHash = await sendLocallySignedTransaction(testAccount, testChain, transport, {
    to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a",
    data: "0x28defc17",
    value: 0n,
    nonce: 0,
    gas: 100000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });

  const rawTransactionRequest = requests.find((request) => request.method === "eth_sendRawTransaction");

  expect(transactionHash).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  // viem 会为 nonce、gas 和费用执行只读 RPC 请求；这里必须精确保护最终广播方法。
  expect(rawTransactionRequest).toBeDefined();
  expect(requests.some((request) => request.method === "eth_sendTransaction")).toBe(false);
  expect(rawTransactionRequest?.params).toHaveLength(1);
  expect(typeof rawTransactionRequest?.params?.[0]).toBe("string");
  expect((rawTransactionRequest?.params?.[0] as string).startsWith("0x")).toBe(true);
});
