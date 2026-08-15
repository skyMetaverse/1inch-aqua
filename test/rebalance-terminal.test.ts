/**
 * 自动再平衡终端面板回归测试。
 * 核心功能：验证完整/紧凑表格的表头与数据按显示宽度对齐，近期事件有界，并在非 TTY 回退为无 ANSI 输出。
 * 主要流程：使用可捕获的假终端 writer 注入策略快照和事件 -> 渲染 -> 去除 ANSI 后断言列宽与内容。
 */
import { expect, test } from "bun:test";
import { RebalanceTerminalDashboard, displayWidth, type RebalanceTerminalWriter } from "../src/infra/rebalance-terminal.ts";

class MemoryTerminal implements RebalanceTerminalWriter {
  chunks: string[] = [];

  constructor(readonly isTTY: boolean, readonly columns: number) {}

  /** 假终端只捕获面板输出，不访问真实 stdout，确保测试可重复且不会污染测试报告。 */
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
}

/** 去掉 ANSI 控制序列后按真实可见文本检查列宽。 */
function visible(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function addRows(dashboard: RebalanceTerminalDashboard): void {
  dashboard.beginSnapshot(2);
  dashboard.upsert({
    strategyHash: "0x3c4c6f3c8a6965d13084ceb385ffde6485660276a57677024d9d399c251901c0",
    pair: "1INCH/USDT",
    current: "0.08293339141264562",
    min: "0.08290044792982399",
    max: "0.082950218060724931",
    outside: "0%",
    breach: "0/3",
    deviation: "0.1088%",
    status: "KEEP",
    reason: "当前价格仍在旧策略区间内",
  });
  dashboard.upsert({
    strategyHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pair: "1INCH/WBTC",
    current: "0.00000152",
    min: "0.00000150",
    max: "0.00000155",
    outside: "1.28%",
    breach: "2/3",
    deviation: "0.0710%",
    status: "WARN",
    reason: "价格越界尚未满足连续确认或额外偏离阈值",
  });
}

/** 宽终端的策略表必须使用同一列宽渲染表头和每一行，中文原因不能让第二行右移。 */
test("宽终端面板的中文表头和策略行严格对齐", () => {
  const terminal = new MemoryTerminal(true, 180);
  const dashboard = new RebalanceTerminalDashboard(terminal, false);
  addRows(dashboard);
  dashboard.addEvent("WARN", "策略持续越界，等待第 3 次确认");
  dashboard.render();
  const lines = visible(terminal.chunks.join("")).split("\n");
  const headerIndex = lines.findIndex((line) => line.includes("状态/原因"));
  expect(headerIndex).toBeGreaterThanOrEqual(0);
  const header = lines[headerIndex] ?? "";
  const firstRow = lines[headerIndex + 2] ?? "";
  const secondRow = lines[headerIndex + 3] ?? "";
  expect(displayWidth(firstRow)).toBe(displayWidth(header));
  expect(displayWidth(secondRow)).toBe(displayWidth(header));
  expect(firstRow).toContain("0.08293339141264562");
  expect(firstRow).toContain("0.08290044792982399 至 0.082950218060724931");
  expect(secondRow).toContain("1.28%");
  expect(secondRow).toContain("0.0710%");
  expect(firstRow).not.toContain("0.0829333914...");
  expect(firstRow).not.toContain("0.1088...");
});

/** 窄终端自动改用逐策略详情块，所有关键价格保持完整，不以省略号换取单行表格。 */
test("窄终端面板完整显示逐策略价格详情", () => {
  const terminal = new MemoryTerminal(true, 100);
  const dashboard = new RebalanceTerminalDashboard(terminal, false);
  addRows(dashboard);
  dashboard.render();
  const output = visible(terminal.chunks.join(""));
  expect(output).toContain("当前价格  : 0.08293339141264562");
  expect(output).toContain("价格区间  : 0.08290044792982399 至 0.082950218060724931");
  expect(output).toContain("越界      : 1.28%");
  expect(output).toContain("价差      : 0.0710%");
  expect(output).not.toContain(".082933~");
});

/** 普通监控行不应刷事件区，交易阶段必须进入近期事件，保证值守时先看到真实资金动作。 */
test("近期事件过滤普通监控并保留交易阶段", () => {
  const terminal = new MemoryTerminal(true, 160);
  const dashboard = new RebalanceTerminalDashboard(terminal, false);
  expect(dashboard.recordAuditMessage("监控 strategyHash=0xabc，越界=0%，决定=keep")).toBe(false);
  expect(dashboard.recordAuditMessage("dock 已广播：strategyHash=0xabc，交易哈希=0xdef")).toBe(true);
  dashboard.render();
  const output = visible(terminal.chunks.join(""));
  expect(output).toContain("dock 已广播");
  expect(output).not.toContain("监控 strategyHash");
});

/** 近期事件是固定容量队列，且非 TTY 必须完全不写 ANSI 控制字符，保证管道日志可用。 */
test("近期事件有界且非 TTY 不渲染", () => {
  const terminal = new MemoryTerminal(true, 160);
  const dashboard = new RebalanceTerminalDashboard(terminal, false);
  for (let index = 0; index < 10; index += 1) dashboard.addEvent("INFO", `事件-${index}`);
  dashboard.render();
  const output = visible(terminal.chunks.join(""));
  expect(output).not.toContain("事件-0");
  expect(output).toContain("事件-9");

  const redirected = new MemoryTerminal(false, 160);
  const redirectedDashboard = new RebalanceTerminalDashboard(redirected, false);
  redirectedDashboard.beginSnapshot(1);
  redirectedDashboard.render();
  expect(redirected.chunks).toHaveLength(0);
});
