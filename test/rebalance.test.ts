/**
 * 自动再平衡领域决策回归测试。
 * 核心功能：锁定 open 策略状态的保守自动处理边界、单边部分成交转双边、持续越界重挂、冷却与市场门槛的安全行为。
 * 主要流程：构造确定性余额和 1e18 价格区间 -> 调用纯函数 -> 断言唯一动作。
 */
import { expect, test } from "bun:test";
import { buildLogicalPositionKey, deriveWalletShipAmounts, unsupportedStrategyReason } from "../src/app/rebalance-bot.ts";
import { decideRebalance, isNearEqualUsd, outsideDistancePercent } from "../src/domain/rebalance.ts";
import { FIXED_SCALE, parsePercentage } from "../src/domain/fixed.ts";

const range = { min: FIXED_SCALE * 99n, current: FIXED_SCALE * 100n, max: FIXED_SCALE * 101n };
const base = { currentPrice: FIXED_SCALE * 103n, oldRange: range, marketHealthy: true, stableBreach: true, cooldownElapsed: true, recenterExcessPercent: parsePercentage("0.03%", "excess"), minValueRatioBps: 8000 };
const maker = "0x01162202AC4A4C686FE95B946E4833b8869CF961" as const;
const app = "0x111111338c5091e8440b67b168bae16a668ac0de" as const;

/** status=open 不是 active 的同义词；未确认交易语义的 illiquidity 必须明确展示并阻止自动交易。 */
test("open concentrated 的 illiquidity 状态被保守阻止并说明原因", () => {
  const strategy = { maker, chainId: 1, app, classification: { type: "concentrated", state: "active", feePercent: 0.001 } };
  expect(unsupportedStrategyReason(strategy, maker, 1, app)).toBeNull();
  expect(unsupportedStrategyReason({ ...strategy, classification: { ...strategy.classification, state: "illiquidity" } }, maker, 1, app)).toContain("illiquidity 语义待确认");
  expect(unsupportedStrategyReason({ ...strategy, classification: { ...strategy.classification, state: "closed" } }, maker, 1, app)).toContain("策略状态=closed");
});

/** dock 确认后必须用钱包完整余额决定新策略投入，而不是继续使用旧策略 API 虚拟余额。 */
test("按目标模式从实际钱包余额导出全额 ship 金额", () => {
  const wallet: [bigint, bigint] = [123n, 456n];
  expect(deriveWalletShipAmounts(wallet, "upper")).toEqual([123n, 0n]);
  expect(deriveWalletShipAmounts(wallet, "lower")).toEqual([0n, 456n]);
  expect(deriveWalletShipAmounts(wallet, "two-sided")).toEqual([123n, 456n]);
  expect(() => deriveWalletShipAmounts([0n, 456n], "upper")).toThrow("token0 余额为零");
  expect(() => deriveWalletShipAmounts([123n, 0n], "two-sided")).toThrow("两侧余额必须均大于零");
});

test("同一 pair 的不同 strategyHash 使用独立逻辑仓位 key", () => {
  const base = { chainId: 1, maker: "0x01162202AC4A4C686FE95B946E4833b8869CF961" as const, app: "0x111111338c5091e8440b67b168bae16a668ac0de" as const, tokens: [{ address: "0x111111111117dc0aa78b770fa6a738034120c302" }, { address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984" }] as [{ address: `0x${string}` }, { address: `0x${string}` }] };
  const first = buildLogicalPositionKey({ ...base, strategyHash: `0x${"1".repeat(64)}` });
  const second = buildLogicalPositionKey({ ...base, strategyHash: `0x${"2".repeat(64)}` });
  expect(first).not.toBe(second);
  expect(first.endsWith(`:0x${"1".repeat(64)}`)).toBe(true);
  expect(second.endsWith(`:0x${"2".repeat(64)}`)).toBe(true);
});

test("单边部分成交且两侧价值达到 80% 时转双边", () => {
  const result = decideRebalance({ ...base, balances: { initial: [0n, 100n], current: [80n, 100n], usd: [80, 100] } });
  expect(result).toEqual({ action: "rehang", targetMode: "two-sided", reason: "单边部分成交后两侧 USD 价值已接近，切换为双边" });
});

test("单边部分成交但未接近等值且越界时保留较大资产单边", () => {
  const result = decideRebalance({ ...base, balances: { initial: [0n, 100n], current: [10n, 100n], usd: [10, 100] } });
  expect(result.action).toBe("rehang");
  if (result.action === "rehang") expect(result.targetMode).toBe("lower");
});

test("市场不健康或冷却期内保持当前策略", () => {
  const balances = { initial: [100n, 0n] as [bigint, bigint], current: [100n, 0n] as [bigint, bigint], usd: [100, 0] as [number, number] };
  expect(decideRebalance({ ...base, balances, marketHealthy: false }).action).toBe("keep");
  expect(decideRebalance({ ...base, balances, cooldownElapsed: false }).action).toBe("keep");
});

test("越界距离和 USD 接近阈值按边界精确判断", () => {
  expect(outsideDistancePercent(FIXED_SCALE * 102n, range)).toBe(parsePercentage("0.990099009900990099%", "distance"));
  expect(isNearEqualUsd([80, 100], 8000)).toBe(true);
  expect(isNearEqualUsd([79.99, 100], 8000)).toBe(false);
});
