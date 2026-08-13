/**
 * 自动再平衡状态文件回归测试。
 * 核心功能：验证计划原子保存后可恢复，损坏状态会在自动交易前被拒绝。
 * 主要流程：创建临时文件 -> 保存计划 -> 读取断言 -> 写入坏 JSON -> 断言错误。
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireRebalanceLock, loadRebalanceState, saveRebalanceState, type PersistedPlan } from "../src/infra/rebalance-state.ts";

const directory = join(import.meta.dir, ".tmp-rebalance-state");
const path = join(directory, "state.json");
const plan: PersistedPlan = { logicalPositionKey: "1:maker:app:a:b", sourceStrategyHash: "0x01", sourceStrategyBytes: "0x03", sourceApp: "0x02", tokens: ["0xa", "0xb"], sourceCurrentRaw: ["10", "20"], targetMode: "two-sided", targetAmountsRaw: ["10", "20"], targetRawPriceMin: "100", targetRawPriceMax: "200", fee: "0.001%", salt: "1", shipStrategyHash: "0x04", decisionReason: "测试", createdAt: 1, updatedAt: 1, stage: "PLAN_PERSISTED" };

function cleanup(): void { if (existsSync(directory)) rmSync(directory, { recursive: true, force: true }); }

test("原子保存的计划可恢复且锁阻止第二进程", () => {
  cleanup();
  try {
    saveRebalanceState(path, { version: 1, plans: { [plan.logicalPositionKey]: plan }, observations: {} });
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

test("损坏状态文件在执行前被拒绝", () => {
  cleanup(); mkdirSync(directory, { recursive: true }); writeFileSync(path, "{", "utf8");
  expect(() => loadRebalanceState(path)).toThrow("无法解析");
  cleanup();
});
