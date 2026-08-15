/**
 * 自动再平衡状态文件回归测试。
 * 核心功能：验证计划原子保存、v2 升级与 post-dock 钱包资金冻结约束，损坏状态会在自动交易前被拒绝。
 * 主要流程：创建临时文件 -> 保存/迁移计划 -> 读取断言 -> 写入坏 JSON 或矛盾资金 -> 断言错误。
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireRebalanceLock, loadRebalanceState, saveRebalanceState, type PersistedPlan } from "../src/infra/rebalance-state.ts";

const directory = join(import.meta.dir, ".tmp-rebalance-state");
const path = join(directory, "state.json");
const plan: PersistedPlan = { logicalPositionKey: "1:maker:app:a:b", sourceStrategyHash: "0x01", sourceStrategyBytes: "0x03", sourceApp: "0x02", tokens: ["0xa", "0xb"], sourceCurrentRaw: ["10", "20"], targetMode: "two-sided", walletBalancesRaw: ["10", "20"], targetAmountsRaw: ["10", "20"], walletSnapshotAt: 1, targetSqrtPriceMin: "100", targetSqrtPriceMax: "200", fee: "0.001%", salt: "1", shipStrategyHash: "0x04", shipFundingSource: "WALLET_SNAPSHOT", decisionReason: "测试", createdAt: 1, updatedAt: 1, stage: "SHIP_PREPARED" };

function cleanup(): void { if (existsSync(directory)) rmSync(directory, { recursive: true, force: true }); }

test("原子保存的计划可恢复且锁阻止第二进程", () => {
  cleanup();
  try {
    saveRebalanceState(path, { version: 3, plans: { [plan.logicalPositionKey]: plan }, observations: {} });
    expect(loadRebalanceState(path).plans[plan.logicalPositionKey]).toEqual(plan);
    const release = acquireRebalanceLock(path);
    try {
      expect(() => acquireRebalanceLock(path)).toThrow("正在运行");
    } finally {
      release();
    }
  } finally {
    cleanup();
  }
});

/** v2 的 dock 已确认计划必须丢弃旧 API 目标金额，等待 v3 在 dock 后读取钱包实际余额。 */
test("v2 dock 已确认计划升级后不再携带 API ship 金额", () => {
  cleanup();
  mkdirSync(directory, { recursive: true });
  const legacy = { ...plan, stage: "DOCK_VERIFIED", targetAmountsRaw: ["10", "20"], salt: "1", shipStrategyHash: "0x04" };
  writeFileSync(path, JSON.stringify({ version: 2, plans: { [plan.logicalPositionKey]: legacy }, observations: {} }), "utf8");
  const loaded = loadRebalanceState(path);
  const migrated = loaded.plans[plan.logicalPositionKey];
  expect(loaded.version).toBe(3);
  expect(migrated?.targetAmountsRaw).toBeUndefined();
  expect(migrated?.salt).toBeUndefined();
  expect(migrated?.shipStrategyHash).toBeUndefined();
  expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(3);
  cleanup();
});

/** post-dock 冻结字段必须严格对应模式和钱包快照，避免手工改 state 后改变 ship 方向或金额。 */
/** v2 已进入 SHIP_SENT 的计划必须保留其原有 calldata 输入，仅用于等待同一笔已广播交易完成。 */
test("v2 已发送 ship 的计划升级后保留旧金额与 hash", () => {
  cleanup();
  mkdirSync(directory, { recursive: true });
  const legacy = { ...plan, stage: "SHIP_SENT", shipTransactionHash: "0x1234", shipFundingSource: undefined, walletBalancesRaw: undefined, walletSnapshotAt: undefined };
  writeFileSync(path, JSON.stringify({ version: 2, plans: { [plan.logicalPositionKey]: legacy }, observations: {} }), "utf8");
  const migrated = loadRebalanceState(path).plans[plan.logicalPositionKey];
  expect(migrated?.shipFundingSource).toBe("LEGACY_API_SNAPSHOT");
  expect(migrated?.targetAmountsRaw).toEqual(["10", "20"]);
  expect(migrated?.salt).toBe("1");
  expect(migrated?.shipStrategyHash).toBe("0x04");
  cleanup();
});

/** post-dock 冻结字段必须严格对应模式和钱包快照，避免手工改 state 后改变 ship 方向或金额。 */
test("钱包资金冻结与目标金额不一致时拒绝恢复", () => {
  cleanup();
  try {
    const invalid = { ...plan, targetAmountsRaw: ["11", "20"] as [string, string] };
    saveRebalanceState(path, { version: 3, plans: { [plan.logicalPositionKey]: invalid }, observations: {} });
    expect(() => loadRebalanceState(path)).toThrow("钱包资金快照与投入额不一致");
  } finally {
    cleanup();
  }
});

test("v1 rawPrice 状态在执行前被拒绝，避免 mixed-decimals 计划被错误恢复", () => {
  cleanup();
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, plans: {}, observations: {} }), "utf8");
  expect(() => loadRebalanceState(path)).toThrow("v1 rawPrice 格式");
  cleanup();
});

test("损坏状态文件在执行前被拒绝", () => {
  cleanup(); mkdirSync(directory, { recursive: true }); writeFileSync(path, "{", "utf8");
  expect(() => loadRebalanceState(path)).toThrow("无法解析");
  cleanup();
});
