/**
 * 自动再平衡进程生命周期回归测试。
 * 核心功能：验证收到 SIGINT/SIGTERM 时只执行一次清理回调，并实际释放自动再平衡进程锁。
 * 主要流程：用内存 EventEmitter 模拟进程信号 -> 触发信号 -> 断言清理入口调用与锁文件可重新获取。
 */
import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { installRebalanceTerminationHandler } from "../src/app/rebalance-bot.ts";
import { acquireRebalanceLock } from "../src/infra/rebalance-state.ts";

const lockDirectory = join(import.meta.dir, ".tmp-rebalance-lifecycle");
const lockStateFile = join(lockDirectory, "state.json");

/** 清理测试使用的锁目录，避免该回归测试自身留下误导性的 lock 文件。 */
function cleanupLockDirectory(): void {
  if (existsSync(lockDirectory)) rmSync(lockDirectory, { recursive: true, force: true });
}

/** 模拟 Ctrl+C 后必须执行清理；重复信号不能重复释放同一把锁。 */
test("SIGINT 触发一次终止清理并在移除处理器后失效", () => {
  const signals = new EventEmitter();
  const received: string[] = [];
  const remove = installRebalanceTerminationHandler(signals, (signal) => received.push(signal));

  signals.emit("SIGINT", "SIGINT");
  signals.emit("SIGTERM", "SIGTERM");
  expect(received).toEqual(["SIGINT"]);

  remove();
  signals.emit("SIGINT", "SIGINT");
  expect(received).toEqual(["SIGINT"]);
});

/** SIGINT 的清理回调必须释放真实锁文件，否则下一个 Bot 仍会误报“正在运行”。 */
test("SIGINT 清理后同一 stateFile 的锁可重新获取", () => {
  cleanupLockDirectory();
  const signals = new EventEmitter();
  const release = acquireRebalanceLock(lockStateFile);
  const remove = installRebalanceTerminationHandler(signals, () => release());
  try {
    signals.emit("SIGINT", "SIGINT");
    const nextRelease = acquireRebalanceLock(lockStateFile);
    nextRelease();
  } finally {
    remove();
    cleanupLockDirectory();
  }
});

/** SIGTERM 也必须走同一条清理路径，适配服务管理器或容器停止进程。 */
test("SIGTERM 触发终止清理", () => {
  const signals = new EventEmitter();
  const received: string[] = [];
  installRebalanceTerminationHandler(signals, (signal) => received.push(signal));

  signals.emit("SIGTERM", "SIGTERM");
  expect(received).toEqual(["SIGTERM"]);
});
