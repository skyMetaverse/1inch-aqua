/**
 * Aqua 网页端 API 响应边界回归测试。
 * 核心功能：验证策略 raw 余额、Pair 负涨跌幅可被安全解析，字段漂移会在自动交易前拒绝。
 * 主要流程：构造与真实接口一致的 JSON -> 解析为严格快照 -> 断言结果或错误。
 */
import { expect, test } from "bun:test";
import { parseApiStrategy, parsePairMarket } from "../src/infra/aqua-api.ts";

const token0 = "0x111111111117dc0aa78b770fa6a738034120c302";
const token1 = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";
const strategy = {
  chainId: 1, maker: "0x01162202AC4A4C686FE95B946E4833b8869CF961", app: "0x111111338c5091e8440b67b168bae16a668ac0de",
  strategyHash: "0x168beda11a90dcc117126c2c322b184108a0bd1a90f861c75ee46f827a378f01", strategyBytes: "0x1234", openedAt: 1,
  tokens: [
    { address: token0, meta: { symbol: "1INCH", decimals: 18 }, initialBalance: { raw: "0", usd: 0 }, currentBalance: { raw: "0", usd: 0 } },
    { address: token1, meta: { symbol: "UNI", decimals: 18 }, initialBalance: { raw: "100", usd: 1 }, currentBalance: { raw: "99", usd: 1 } },
  ], classification: { type: "concentrated", state: "active", feePercent: 0.001 }, performance: { volume: { total: { usd: 0 } }, fees: { total: { usd: 0 } } },
};

test("策略 API 的 raw 余额保持 bigint，Pair 负涨跌幅允许记录", () => {
  expect(parseApiStrategy(strategy).tokens[1].currentBalance.raw).toBe(99n);
  const pair = parsePairMarket({ token0, token1, lastPrice: 0.023, volumeUsd: 1000, swaps: 1, diffPercent1h: 0, diffPercent24h: -2.1, diffPercent7d: 3 });
  expect(pair.diffPercent24h).toBe(-2.1);
});

test("策略 API 非法 raw 字段在自动交易前被拒绝", () => {
  expect(() => parseApiStrategy({ ...strategy, tokens: [{ ...strategy.tokens[0], currentBalance: { raw: "1.2", usd: 0 } }, strategy.tokens[1]] })).toThrow("非负整数字符串");
});
