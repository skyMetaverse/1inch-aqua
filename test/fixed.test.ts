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
  convertAquaSqrtRangeToDisplayRange,
  convertDisplayRangeToAquaRange,
  convertDisplayRangeToAquaSqrtRange,
  FIXED_SCALE,
  invertFixedPrice,
  parseDecimalFloor,
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

test("EMSH 超过 18 位价格向下量化并记录舍弃部分", () => {
  const result = parseDecimalFloor("0.0000000000000000012345", 18, "EMSH current");
  expect(result.value).toBe(1n);
  expect(result.truncated).toBe(true);
  expect(result.discardedFraction).toBe("2345");
  expect(parseDecimalFloor("1.2300", 18, "EMSH current").truncated).toBe(false);
});

test("EMSH 价格向下量化为零时拒绝", () => {
  expect(() => parseDecimalFloor("0.0000000000000000009", 18, "EMSH current")).toThrow("量化到 18 位后必须大于零");
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

test("mixed-decimals 区间使用 sqrtPrice 保留 1INCH/WBTC 的窄区间", () => {
  const oneInch = "0x111111111117dc0aa78b770fa6a738034120c302";
  const wbtc = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
  const range = { current: 1_327_182_096_733n, min: 1_326_385_787_474n, max: 1_327_182_096_733n };
  const aquaRange = convertDisplayRangeToAquaSqrtRange(oneInch, 18, wbtc, 8, range);
  // 旧 rawPrice 直接编码会是 1.3e12；正确 sqrt 约为 1.15e10，且仍区分 6bp 边界。
  expect(aquaRange.sqrtPriceMin).toBeLessThan(aquaRange.sqrtPriceMax);
  expect(aquaRange.sqrtPriceMax).toBe(11_520_338_956n);
  const recovered = convertAquaSqrtRangeToDisplayRange(oneInch, 18, wbtc, 8, aquaRange);
  expect(recovered.min).toBeLessThan(recovered.max);
  const minError = range.min > recovered.min ? range.min - recovered.min : recovered.min - range.min;
  const maxError = range.max > recovered.max ? range.max - recovered.max : recovered.max - range.max;
  expect(minError).toBeLessThan(1_000n);
  expect(maxError).toBeLessThan(1_000n);
});

test("mixed-decimals 反向 token 顺序仍按人类报价恢复区间", () => {
  const usdt = "0xdac17f958d2ee523a2206206994597c13d831ec7";
  const oneInch = "0x111111111117dc0aa78b770fa6a738034120c302";
  const range = { current: 83_418_000_000_000_000n, min: 83_376_291_000_000_000n, max: 83_459_709_000_000_000n };
  const aquaRange = convertDisplayRangeToAquaSqrtRange(usdt, 6, oneInch, 18, range);
  const recovered = convertAquaSqrtRangeToDisplayRange(usdt, 6, oneInch, 18, aquaRange);
  expect(aquaRange.isDisplayOrderCanonical).toBe(false);
  expect(recovered.min).toBeLessThan(recovered.max);
  const minError = range.min > recovered.min ? range.min - recovered.min : recovered.min - range.min;
  const maxError = range.max > recovered.max ? range.max - recovered.max : recovered.max - range.max;
  expect(minError).toBeLessThan(1_000_000n);
  expect(maxError).toBeLessThan(1_000_000n);
});

test("下浮 100% 被拒绝，防止生成零价格", () => {
  expect(() => calculateDisplayRange(FIXED_SCALE, "lower", undefined, parsePercentage("100%", "lower"))).toThrow("小于 100%");
});

test("倒数展示价格按 1e18 定点精确换向", () => {
  expect(invertFixedPrice(FIXED_SCALE * 4n)).toBe(FIXED_SCALE / 4n);
  expect(invertFixedPrice(FIXED_SCALE / 4n)).toBe(FIXED_SCALE * 4n);
  expect(() => invertFixedPrice(0n)).toThrow("必须大于零");
});
