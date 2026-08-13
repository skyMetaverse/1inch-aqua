/**
 * 自动再平衡配置的回归测试。
 * 核心功能：验证 5 bp 默认配置可解析，并拒绝未知字段和不安全的比例阈值。
 * 主要流程：构造 JSON 对象 -> 严格校验 -> 断言配置或错误消息。
 */
import { expect, test } from "bun:test";
import { validateRebalanceConfig } from "../src/config/rebalance-config.ts";

const validConfig = {
  chainId: 1,
  polling: { intervalSeconds: 30, stableSnapshotsRequired: 3, maxCurrentPriceAgeSeconds: 120 },
  market: { maxPairPriceDeviationPercent: "0.20%", minimumPairVolumeUsd: "1000", minimumPairSwaps: 1 },
  rebalance: { fee: "0.001%", singleSidedWidth: "0.05%", twoSidedHalfWidth: "0.05%", recenterExcess: "0.03%", cooldownSeconds: 900, convertToTwoSidedMinValueRatioBps: 8000 },
  runtime: { stateFile: "state/rebalance-state.json" },
};

test("解析 5 bp 自动再平衡配置", () => {
  const config = validateRebalanceConfig(validConfig);
  expect(config.rebalance.singleSidedWidth).toBe("0.05%");
  expect(config.rebalance.convertToTwoSidedMinValueRatioBps).toBe(8000);
});

test("拒绝未知字段和超过 100% 的转双边比例", () => {
  expect(() => validateRebalanceConfig({ ...validConfig, extra: true })).toThrow("不支持字段");
  expect(() => validateRebalanceConfig({ ...validConfig, rebalance: { ...validConfig.rebalance, convertToTwoSidedMinValueRatioBps: 10001 } })).toThrow("不能超过 10000");
});
