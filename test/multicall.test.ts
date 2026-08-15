/**
 * Aqua registry multicall 编码回归测试。
 * 核心功能：验证两个及以上仓位进入批量模式、编码使用正确 selector，并拒绝跨合约或非零 value 的危险子调用。
 * 主要流程：构造确定性 dock/ship 风格 calldata -> 编码并解码 multicall -> 断言参数和安全边界。
 */
import { expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { AQUA_MULTICALL_ABI, buildAquaMulticallTransaction, shouldUseAquaMulticall } from "../src/aqua/multicall.ts";

const registry = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a" as const;

/** 两个策略即应使用 multicall，锁定开仓与关仓共享的 >= 2 阈值，避免再次退化为严格大于两个。 */
test("Aqua multicall 在至少两个子调用时启用", () => {
  expect(shouldUseAquaMulticall(0)).toBe(false);
  expect(shouldUseAquaMulticall(1)).toBe(false);
  expect(shouldUseAquaMulticall(2)).toBe(true);
  expect(shouldUseAquaMulticall(3)).toBe(true);
});

/** 已验证的 Aqua multicall(bytes[]) selector 必须保持稳定，避免 ABI 或编码意外漂移。 */
test("Aqua multicall 编码两个同 registry 的零 value 子调用", () => {
  const transaction = buildAquaMulticallTransaction(registry, [
    { to: registry, data: "0x12345678", value: 0n },
    { to: registry, data: "0x87654321", value: 0n },
  ]);
  expect(transaction.to).toBe(registry);
  expect(transaction.value).toBe(0n);
  expect(transaction.data.slice(0, 10)).toBe("0xac9650d8");
  const decoded = decodeFunctionData({ abi: AQUA_MULTICALL_ABI, data: transaction.data });
  expect(decoded.functionName).toBe("multicall");
  expect(decoded.args?.[0]).toEqual(["0x12345678", "0x87654321"]);
});

/** 共享 msg.value 的 delegatecall multicall 不能接受非 registry 或非零 value 子调用。 */
test("Aqua multicall 拒绝不足两个、跨合约和非零 value 子调用", () => {
  expect(() => buildAquaMulticallTransaction(registry, [{ to: registry, data: "0x12345678", value: 0n }])).toThrow("至少需要 2 个子调用");
  expect(() => buildAquaMulticallTransaction(registry, [
    { to: registry, data: "0x12345678", value: 0n },
    { to: "0x1111111111111111111111111111111111111111", data: "0x87654321", value: 0n },
  ])).toThrow("目标不是 registry");
  expect(() => buildAquaMulticallTransaction(registry, [
    { to: registry, data: "0x12345678", value: 0n },
    { to: registry, data: "0x87654321", value: 1n },
  ])).toThrow("value 必须为 0");
});
