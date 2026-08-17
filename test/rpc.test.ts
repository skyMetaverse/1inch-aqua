/**
 * 本地签名 RPC 广播模块的回归测试。
 * 核心功能：验证私钥账户广播交易时使用 eth_sendRawTransaction，而非要求 RPC 代签的 eth_sendTransaction。
 * 主要流程：构造固定测试私钥和捕获型 transport -> 调用共享本地签名函数 -> 断言 RPC 方法和 raw transaction 参数。
 */

import { expect, test } from "bun:test";
import { custom, defineChain, keccak256, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseEip1559FeeOverrides, RawBroadcastIndeterminateError, sendLocallySignedTransaction, sendLocallySignedTransactions } from "../src/infra/rpc.ts";

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
test("批量本地签名交易使用连续 nonce 并返回每笔 hash", async () => {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  const transport = custom({
    async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
      requests.push(args);
      if (args.method === "eth_getTransactionCount") return "0x7";
      if (args.method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
      if (args.method === "eth_getBlockByNumber") return { baseFeePerGas: "0x3b9aca00" };
      if (args.method === "eth_estimateGas") return "0x186a0";
      if (args.method === "eth_sendRawTransaction") return `0x${String(requests.filter((request) => request.method === "eth_sendRawTransaction").length).padStart(64, "0")}`;
      throw new Error(`不应调用 RPC 方法：${args.method}`);
    },
  });
  const results = await sendLocallySignedTransactions(testAccount, testChain, transport, [
    { to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a", data: "0x01", value: 0n },
    { to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a", data: "0x02", value: 0n },
  ], {});
  const rawRequests = requests.filter((request) => request.method === "eth_sendRawTransaction");
  expect(results.every((result) => result.hash !== undefined && result.error === undefined)).toBe(true);
  expect(rawRequests).toHaveLength(2);
  const nonces = rawRequests.map((request) => parseTransaction(request.params?.[0] as Hex).nonce);
  expect(nonces).toEqual([7, 8]);
  expect(requests.some((request) => request.method === "eth_fillTransaction")).toBe(false);
});

test("流水线广播在中间 nonce 失败时不提交后续交易", async () => {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  let rawRequestCount = 0;
  const transport = custom({
    async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
      requests.push(args);
      if (args.method === "eth_getTransactionCount") return "0x9";
      if (args.method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
      if (args.method === "eth_getBlockByNumber") return { baseFeePerGas: "0x3b9aca00" };
      if (args.method === "eth_estimateGas") return "0x186a0";
      if (args.method === "eth_sendRawTransaction") {
        rawRequestCount += 1;
        if (rawRequestCount === 2) throw new Error("Missing or invalid parameters.");
        return "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      }
      throw new Error(`不应调用 RPC 方法：${args.method}`);
    },
  });
  const results = await sendLocallySignedTransactions(testAccount, testChain, transport, [
    { to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a", data: "0x01", value: 0n },
    { to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a", data: "0x02", value: 0n },
    { to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a", data: "0x03", value: 0n },
  ], {});
  expect(rawRequestCount).toBe(2);
  expect(results[0]?.hash).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  expect(results[1]?.error).toBeDefined();
  expect(results[2]?.error).toContain("未提交");
});

test("raw 广播拒绝时记录阶段和安全交易参数，不自动重试", async () => {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  let rawRequestCount = 0;
  const transport = custom({
    async request(args: { method: string; params?: unknown[] }): Promise<Hex> {
      requests.push(args);
      if (args.method === "eth_getTransactionCount") return "0xc";
      if (args.method === "eth_estimateGas") return "0x186a0";
      if (args.method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
      if (args.method === "eth_getBlockByNumber") return { baseFeePerGas: "0x3b9aca00" } as unknown as Hex;
      if (args.method === "eth_sendRawTransaction") {
        rawRequestCount += 1;
        throw new Error("Missing or invalid parameters.");
      }
      throw new Error(`不应调用 RPC 方法：${args.method}`);
    },
  });
  await expect(sendLocallySignedTransaction(testAccount, testChain, transport, {
    to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a",
    data: "0x28defc17",
    value: 0n,
  }, {})).rejects.toThrow("raw 广播失败：nonce=12，gas=100000，maxFeePerGas=2200000000，maxPriorityFeePerGas=1000000000，原因=Missing or invalid parameters.");
  expect(rawRequestCount).toBe(1);
  expect(requests.filter((request) => request.method === "eth_sendRawTransaction")).toHaveLength(1);
});

/** HTTP 超时不等于节点未接收 raw；共享层必须给出本地 hash 供调用方只读查回执，且绝不重发。 */
test("raw 广播超时返回本地可验证交易哈希", async () => {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  const transport = custom({
    async request(args: { method: string; params?: unknown[] }): Promise<Hex> {
      requests.push(args);
      if (args.method === "eth_getTransactionCount") return "0xe";
      if (args.method === "eth_estimateGas") return "0x186a0";
      if (args.method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
      if (args.method === "eth_getBlockByNumber") return { baseFeePerGas: "0x3b9aca00" } as unknown as Hex;
      if (args.method === "eth_sendRawTransaction") throw new Error("The request timed out.");
      throw new Error(`不应调用 RPC 方法：${args.method}`);
    },
  });
  let caught: unknown;
  try {
    await sendLocallySignedTransaction(testAccount, testChain, transport, { to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a", data: "0x28defc17", value: 0n }, {});
  } catch (error) {
    caught = error;
  }
  const raw = requests.find((request) => request.method === "eth_sendRawTransaction")?.params?.[0] as Hex;
  expect(caught).toBeInstanceOf(RawBroadcastIndeterminateError);
  expect((caught as RawBroadcastIndeterminateError).transactionHash).toBe(keccak256(raw));
  expect(requests.filter((request) => request.method === "eth_sendRawTransaction")).toHaveLength(1);
});

/** pending nonce 短暂滞后时，前一笔超时但被节点接收的 raw 必须保留后续 nonce，不能让下一独立交易重签同一 nonce。 */
test("raw 广播结果不确定后本地 nonce 游标覆盖滞后的 pending 查询", async () => {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  let rawRequestCount = 0;
  const transport = custom({
    async request(args: { method: string; params?: unknown[] }): Promise<Hex> {
      requests.push(args);
      if (args.method === "eth_getTransactionCount") return "0x379";
      if (args.method === "eth_estimateGas") return "0x186a0";
      if (args.method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
      if (args.method === "eth_getBlockByNumber") return { baseFeePerGas: "0x3b9aca00" } as unknown as Hex;
      if (args.method === "eth_sendRawTransaction") {
        rawRequestCount += 1;
        if (rawRequestCount === 1) throw new Error("The request timed out.");
        return "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      }
      throw new Error(`不应调用 RPC 方法：${args.method}`);
    },
  });
  const transaction = { to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a" as const, data: "0x28defc17" as Hex, value: 0n };
  await expect(sendLocallySignedTransaction(testAccount, testChain, transport, transaction, {})).rejects.toBeInstanceOf(RawBroadcastIndeterminateError);
  await sendLocallySignedTransaction(testAccount, testChain, transport, transaction, {});
  const rawTransactions = requests.filter((request) => request.method === "eth_sendRawTransaction").map((request) => parseTransaction(request.params?.[0] as Hex));
  expect(rawTransactions.map((item) => item.nonce)).toEqual([889, 890]);
  expect(rawRequestCount).toBe(2);
});

test("RPC 返回零 priority fee 时以 1 wei 广播，兼容要求最小 tip 的节点", async () => {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  const transport = custom({
    async request(args: { method: string; params?: unknown[] }): Promise<Hex> {
      requests.push(args);
      if (args.method === "eth_getTransactionCount") return "0xd";
      if (args.method === "eth_estimateGas") return "0x186a0";
      if (args.method === "eth_maxPriorityFeePerGas") return "0x0";
      if (args.method === "eth_getBlockByNumber") return { baseFeePerGas: "0x3b9aca00" } as unknown as Hex;
      if (args.method === "eth_sendRawTransaction") return "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
      throw new Error(`不应调用 RPC 方法：${args.method}`);
    },
  });
  await sendLocallySignedTransaction(testAccount, testChain, transport, {
    to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a",
    data: "0x28defc17",
    value: 0n,
  }, {});
  const raw = requests.find((request) => request.method === "eth_sendRawTransaction")?.params?.[0] as Hex;
  expect(parseTransaction(raw).maxPriorityFeePerGas).toBe(1n);
});

test("本地私钥账户必须通过 eth_sendRawTransaction 广播", async () => {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  const transport = custom({
    async request(args: { method: string; params?: unknown[] }): Promise<Hex> {
      requests.push(args);
      if (args.method === "eth_getTransactionCount") return "0x0";
      if (args.method === "eth_estimateGas") return "0x186a0";
      if (args.method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
      if (args.method === "eth_getBlockByNumber") return { baseFeePerGas: "0x3b9aca00" } as unknown as Hex;
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
  }, {});

  const rawTransactionRequest = requests.find((request) => request.method === "eth_sendRawTransaction");

  expect(transactionHash).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  // nonce、gas 和费用只读查询允许存在；这里必须精确保护最终广播方法和本地签名边界。
  expect(rawTransactionRequest).toBeDefined();
  expect(requests.some((request) => request.method === "eth_sendTransaction")).toBe(false);
  expect(requests.some((request) => request.method === "eth_fillTransaction")).toBe(false);
  expect(rawTransactionRequest?.params).toHaveLength(1);
  expect(typeof rawTransactionRequest?.params?.[0]).toBe("string");
  expect((rawTransactionRequest?.params?.[0] as string).startsWith("0x")).toBe(true);
});

/** 自定义费率必须成对出现，并以整数 wei 精确表达，防止 dotenv 文本被浮点数或半配置静默误用。 */
test("解析 .env 自定义 EIP-1559 费率并拒绝半配置", () => {
  expect(parseEip1559FeeOverrides("MAX_FEE_PER_GAS_GWEI=25.5\nMAX_PRIORITY_FEE_PER_GAS_GWEI=1.25\n")).toEqual({
    maxFeePerGas: 25_500_000_000n,
    maxPriorityFeePerGas: 1_250_000_000n,
  });
  expect(() => parseEip1559FeeOverrides("MAX_FEE_PER_GAS_GWEI=25\n")).toThrow("必须同时设置");
});

/** 自定义 max fee 仍要读取链上 base fee，签出的最终交易必须精确使用 dotenv 覆盖值而不是 RPC 估算值。 */
test("自定义 EIP-1559 费率使用链上 base fee 校验后本地签名", async () => {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  const transport = custom({
    async request(args: { method: string; params?: unknown[] }): Promise<Hex> {
      requests.push(args);
      if (args.method === "eth_getBlockByNumber") return { baseFeePerGas: "0x4a817c800" } as unknown as Hex;
      if (args.method === "eth_sendRawTransaction") return "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
      throw new Error(`不应调用 RPC 方法：${args.method}`);
    },
  });
  await sendLocallySignedTransaction(testAccount, testChain, transport, {
    to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a", data: "0x28defc17", value: 0n, nonce: 1, gas: 100000n,
  }, { maxFeePerGas: 25_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n });
  const raw = requests.find((request) => request.method === "eth_sendRawTransaction")?.params?.[0] as Hex;
  expect(parseTransaction(raw).maxFeePerGas).toBe(25_000_000_000n);
  expect(parseTransaction(raw).maxPriorityFeePerGas).toBe(2_000_000_000n);
  expect(requests.some((request) => request.method === "eth_getBlockByNumber")).toBe(true);
  expect(requests.some((request) => request.method === "eth_maxPriorityFeePerGas")).toBe(false);
});

/** 基础费上涨超过用户 max fee 时必须在广播前拒绝，不能让节点接收注定不可打包的 raw transaction。 */
test("自定义 max fee 未覆盖链上 base fee 与 priority fee 时拒绝广播", async () => {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  const transport = custom({
    async request(args: { method: string; params?: unknown[] }): Promise<Hex> {
      requests.push(args);
      if (args.method === "eth_getBlockByNumber") return { baseFeePerGas: "0x4a817c800" } as unknown as Hex;
      throw new Error(`不应调用 RPC 方法：${args.method}`);
    },
  });
  await expect(sendLocallySignedTransaction(testAccount, testChain, transport, {
    to: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a", data: "0x28defc17", value: 0n, nonce: 1, gas: 100000n,
  }, { maxFeePerGas: 21_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n })).rejects.toThrow("未覆盖最新链上 base fee 与 priority fee");
  expect(requests.some((request) => request.method === "eth_sendRawTransaction")).toBe(false);
});
