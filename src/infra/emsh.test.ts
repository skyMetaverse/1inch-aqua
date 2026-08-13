/**
 * EMSH current 原文响应解析回归测试。
 * 核心功能：验证价格长小数保持为文本而不经 JSON.parse 转成浮点数，并拒绝科学计数法。
 * 主要流程：传入固定原始 JSON -> 提取价格字面量与时间戳 -> 断言精度和异常边界。
 */
import { expect, test } from "bun:test";
import { extractCurrentPrice } from "./emsh.ts";

test("保留 EMSH price 原始长小数字面量", () => {
  const value = extractCurrentPrice('{"data":{"result":{"timestamp":1786590299,"price":0.083131772471243631234567890}}}');
  expect(value.priceText).toBe("0.083131772471243631234567890");
  expect(value.timestamp).toBe(1786590299);
});

test("拒绝 EMSH 科学计数法价格", () => {
  expect(() => extractCurrentPrice('{"data":{"result":{"timestamp":1786590299,"price":1e-8}}}')).toThrow("科学计数法");
});
