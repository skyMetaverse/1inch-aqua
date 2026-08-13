/**
 * 无损价格与费率计算的回归测试。
 * 核心功能：验证百分比、余额、非对称区间、地址反向价格和 0.001% 费率均在 bigint 定点模型中精确计算。
 * 主要流程：使用确定性文本输入 -> 调用纯领域函数 -> 断言 raw 结果和异常边界。
 */
import { expect, test } from "bun:test";
import {
  calculateDisplayRange,
  calculatePercentAmount,
  convertAquaRangeToDisplayRange,
  convertDisplayRangeToAquaRange,
  FIXED_SCALE,
  invertFixedPrice,
  parsePercentage,
  percentageToAquaFeeValue,
} from "../src/domain/fixed.ts";

test("0.001% 费率精确转换为 Aqua 内部值", () => {
  expect(percentageToAquaFeeValue(parsePercentage("0.001%", "fee"))).toBe(10_000n);
  expect(percentageToAquaFeeValue(parsePercentage("0.04%", "fee"))).toBe(400_000n);
  expect(() => percentageToAquaFeeValue(parsePercentage("0.00000001%", "fee"))).toThrow("无法被当前 Aqua SDK");
});

test("余额百分比向下取整且不超过余额", () => {
  expect(calculatePercentAmount(101n, parsePercentage("12.5%", "balancePercent"))).toBe(12n);
  expect(calculatePercentAmount(101n, parsePercentage("100%", "balancePercent"))).toBe(101n);
});

test("双边区间允许上下不对称", () => {
  const range = calculateDisplayRange(FIXED_SCALE * 3000n, "two-sided", parsePercentage("80%", "upper"), parsePercentage("30%", "lower"));
  expect(range.min).toBe(FIXED_SCALE * 2100n);
  expect(range.max).toBe(FIXED_SCALE * 5400n);
});

test("反向地址排序会精确翻转 Aqua raw 价格区间", () => {
  const range = calculateDisplayRange(FIXED_SCALE * 3000n, "two-sided", parsePercentage("10%", "upper"), parsePercentage("10%", "lower"));
  const token0 = "0xdac17f958d2ee523a2206206994597c13d831ec7";
  const token1 = "0x111111111117dc0aa78b770fa6a738034120c302";
  const aquaRange = convertDisplayRangeToAquaRange(token0, token1, range);
  expect(aquaRange.isDisplayOrderCanonical).toBe(false);
  expect(aquaRange.rawPriceMin).toBe((FIXED_SCALE * FIXED_SCALE) / range.max);
  expect(aquaRange.rawPriceMax).toBe((FIXED_SCALE * FIXED_SCALE) / range.min);
  const displayRange = convertAquaRangeToDisplayRange(token0, token1, aquaRange);
  // 两次整数倒数不可逆，但误差必须远小于策略区间，且恢复区间顺序必须正确。
  const minError = displayRange.min > range.min ? displayRange.min - range.min : range.min - displayRange.min;
  const maxError = displayRange.max > range.max ? displayRange.max - range.max : range.max - displayRange.max;
  expect(minError).toBeLessThan(10n ** 7n);
  expect(maxError).toBeLessThan(10n ** 7n);
  expect(displayRange.min).toBeLessThan(displayRange.max);
});

test("下浮 100% 被拒绝，防止生成零价格", () => {
  expect(() => calculateDisplayRange(FIXED_SCALE, "lower", undefined, parsePercentage("100%", "lower"))).toThrow("小于 100%");
});

test("倒数展示价格按 1e18 定点精确换向", () => {
  expect(invertFixedPrice(FIXED_SCALE * 4n)).toBe(FIXED_SCALE / 4n);
  expect(invertFixedPrice(FIXED_SCALE / 4n)).toBe(FIXED_SCALE * 4n);
  expect(() => invertFixedPrice(0n)).toThrow("必须大于零");
});
