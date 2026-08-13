/**
 * Aqua 策略构建回归测试。
 * 核心功能：验证 Bun 运行时可以加载 SwapVM SDK，且 0.001% 费率与随机 salt 能生成不同的可 ship 策略。
 * 主要流程：使用公开地址和固定精确价格构建两次策略 -> 校验交易目标、hash 格式与策略唯一性。
 */
import { expect, test } from "bun:test";
import { buildConcentratedStrategy } from "../src/aqua/strategy.ts";

test("构建 0.001% Aqua 集中流动性 ship 策略", () => {
  const input = {
    chainId: 1,
    maker: "0x01162202AC4A4C686FE95B946E4833b8869CF961" as const,
    rawPriceMin: 80_000_000_000_000_000n,
    rawPriceMax: 90_000_000_000_000_000n,
    feeValue: 10_000n,
    amounts: [
      { token: "0x111111111117dc0aa78b770fa6a738034120c302" as const, amount: 1n },
      { token: "0xdac17f958d2ee523a2206206994597c13d831ec7" as const, amount: 1n },
    ],
  };
  const first = buildConcentratedStrategy(input);
  const second = buildConcentratedStrategy(input);

  expect(first.feeBps).toBe(0.1);
  expect(first.ship.to).toBe("0x1111113ccf1426a8e30e2bff5e005d929bf6a90a");
  expect(first.ship.value).toBe(0n);
  expect(first.strategyHash).toMatch(/^0x[0-9a-f]{64}$/i);
  expect(first.strategyHash).not.toBe(second.strategyHash);
  expect(first.salt).not.toBe(second.salt);
});
