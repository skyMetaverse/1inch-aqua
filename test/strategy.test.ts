/**
 * Aqua 策略构建回归测试。
 * 核心功能：验证 Bun 运行时可以加载 SwapVM SDK，并锁定随机与固定资金快照下的 strategy hash 行为。
 * 主要流程：使用公开地址和固定精确价格构建策略 -> 校验交易目标、hash 格式、随机唯一性与恢复确定性。
 */
import { expect, test } from "bun:test";
import { parseConcentratedSqrtRange } from "../src/aqua/strategy-parser.ts";
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

test("sqrtPrice 参数可构建 mixed-decimals 集中流动性策略", () => {
  const strategy = buildConcentratedStrategy({
    chainId: 1,
    maker: "0x01162202AC4A4C686FE95B946E4833b8869CF961",
    sqrtPriceMin: 11_516_882_336n,
    sqrtPriceMax: 11_520_338_956n,
    feeValue: 10_000n,
    amounts: [
      { token: "0x111111111117dc0aa78b770fa6a738034120c302", amount: 1n },
      { token: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", amount: 1n },
    ],
    salt: 1n,
  });
  expect(strategy.strategyHash).toMatch(/^0x[0-9a-f]{64}$/i);
  expect(strategy.salt).toBe(1n);
  const decoded = parseConcentratedSqrtRange(strategy.strategy);
  expect(decoded.sqrtPriceMin).toBe(11_516_882_336n);
  expect(decoded.sqrtPriceMax).toBe(11_520_338_956n);
});

/** dock 后冻结相同余额和 salt 必须重建相同策略；金额不参与 strategyHash，但会改变 ship calldata，因此恢复仍须锁定金额。 */
test("固定钱包资金快照可确定性重建策略并锁定 ship calldata", () => {
  const base = {
    chainId: 1,
    maker: "0x01162202AC4A4C686FE95B946E4833b8869CF961" as const,
    sqrtPriceMin: 11_516_882_336n,
    sqrtPriceMax: 11_520_338_956n,
    feeValue: 10_000n,
    salt: 987_654n,
  };
  const first = buildConcentratedStrategy({ ...base, amounts: [
    { token: "0x111111111117dc0aa78b770fa6a738034120c302" as const, amount: 123n },
    { token: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599" as const, amount: 456n },
  ] });
  const restored = buildConcentratedStrategy({ ...base, amounts: [
    { token: "0x111111111117dc0aa78b770fa6a738034120c302" as const, amount: 123n },
    { token: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599" as const, amount: 456n },
  ] });
  const changedBalance = buildConcentratedStrategy({ ...base, amounts: [
    { token: "0x111111111117dc0aa78b770fa6a738034120c302" as const, amount: 124n },
    { token: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599" as const, amount: 456n },
  ] });
  expect(restored.strategyHash).toBe(first.strategyHash);
  expect(restored.ship.data).toBe(first.ship.data);
  expect(changedBalance.strategyHash).toBe(first.strategyHash);
  expect(changedBalance.ship.data).not.toBe(first.ship.data);
});
