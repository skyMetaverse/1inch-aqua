/**
 * 添加 LP JSONC 配置校验回归测试。
 * 核心功能：验证带中文注释的配置能解析，且单边模式的资产比例约束会在广播前拒绝错误输入。
 * 主要流程：写入临时 JSONC -> 解析与结构校验 -> 断言规范对象或预期错误。
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsoncFile } from "../src/config/jsonc.ts";
import { validateAddLpConfig } from "../src/config/lp-config.ts";

const base = `{
  // 中文注释和尾随逗号都应受支持
  "chainId": 1,
  "positions": [{
    "id": "main-position",
    "pair": { "tokens": [
      { "symbol": "A", "address": "0x111111111117dc0aa78b770fa6a738034120c302", "balancePercent": "30%" },
      { "symbol": "B", "address": "0xdac17f958d2ee523a2206206994597c13d831ec7", "balancePercent": "50%" },
    ] },
    "fee": "0.001%",
    "range": { "mode": "two-sided", "upperPercent": "10%", "lowerPercent": "5%" },
  }],
}`;

test("解析带中文注释和尾随逗号的添加 LP JSONC", () => {
  const directory = mkdtempSync(join(tmpdir(), "aqua-jsonc-"));
  const path = join(directory, "lp.jsonc");
  try {
    writeFileSync(path, base, "utf8");
    const config = validateAddLpConfig(readJsoncFile(path));
    expect(config.chainId).toBe(1);
    expect(config.positions).toHaveLength(1);
    expect(config.positions[0]?.id).toBe("main-position");
    expect(config.positions[0]?.fee).toBe("0.001%");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** 配置槽位 id 是 Bot 长期对账依据，重复时不能让缺口补仓关联到不确定模板。 */
test("拒绝重复的配置仓位 id", () => {
  expect(() => validateAddLpConfig({ chainId: 1, positions: [
    { id: "same", pair: { tokens: [{ symbol: "A", address: "0x111111111117dc0aa78b770fa6a738034120c302", balancePercent: "100%" }, { symbol: "B", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", balancePercent: "0%" }] }, fee: "0.001%", range: { mode: "upper", upperPercent: "1%" } },
    { id: "same", pair: { tokens: [{ symbol: "A", address: "0x111111111117dc0aa78b770fa6a738034120c302", balancePercent: "0%" }, { symbol: "B", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", balancePercent: "100%" }] }, fee: "0.001%", range: { mode: "lower", lowerPercent: "1%" } },
  ] })).toThrow("positions.id 不能重复");
});

test("上单边拒绝 token1 非零余额比例", () => {
  const directory = mkdtempSync(join(tmpdir(), "aqua-jsonc-"));
  const path = join(directory, "lp.jsonc");
  try {
    writeFileSync(path, base.replace('"mode": "two-sided", "upperPercent": "10%", "lowerPercent": "5%"', '"mode": "upper", "upperPercent": "10%", "lowerPercent": "1%"'), "utf8");
    expect(() => validateAddLpConfig(readJsoncFile(path))).toThrow("上单边模式不能配置非零 lowerPercent");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
