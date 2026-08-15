/**
 * 自动再平衡 Bot 的交互式终端状态面板。
 * 核心功能：在 TTY 中原位刷新对齐的策略表和近期事件，同时让文件日志继续作为完整审计记录。
 * 主要流程：收集单轮策略快照 -> 固定列宽渲染 -> ANSI 刷新终端；非 TTY 时完全禁用，交给逐行日志降级输出。
 */

export type DashboardStatus = "KEEP" | "WARN" | "ACTION" | "BLOCK" | "PLAN";
export type DashboardEventKind = "INFO" | "WARN" | "ACTION" | "ERROR";

export interface RebalanceDashboardRow {
  strategyHash: string;
  pair: string;
  current: string;
  min: string;
  max: string;
  outside: string;
  breach: string;
  deviation: string;
  status: DashboardStatus;
  reason: string;
}

export interface RebalanceTerminalWriter {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(chunk: string): unknown;
}

interface DashboardEvent {
  time: string;
  kind: DashboardEventKind;
  message: string;
}

const ANSI = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
} as const;
const MAX_EVENTS = 8;

/** 使用本地时间生成面板和事件行的简短时间，避免重复完整日志时间戳挤占列宽。 */
function shortTime(date = new Date()): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, "0")).join(":");
}

/** 终端宽度按 East Asian 宽字符计算，确保中文表头和消息与 ASCII 数据列保持对齐。 */
export function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    width += (
      code >= 0x1100
      && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6))
    ) ? 2 : 1;
  }
  return width;
}

/** 按显示宽度截断，而不是按 JavaScript 字符串长度截断，避免截断后列错位。 */
function truncateDisplay(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  if (width <= 3) return ".".repeat(width);
  let result = "";
  let used = 0;
  for (const character of value) {
    const characterWidth = displayWidth(character);
    if (used + characterWidth > width - 3) break;
    result += character;
    used += characterWidth;
  }
  return `${result}...`;
}

/** 统一补齐每个单元格；所有列的表头和数据都经过同一个函数，避免视觉错位。 */
function cell(value: string, width: number): string {
  const truncated = truncateDisplay(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - displayWidth(truncated)))}`;
}

/** 仅缩短中间策略哈希，文件审计日志始终保留完整 hash。 */
function shortHash(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/** 窄终端将长价格文本压缩为可比较前缀；精确值仍在文件日志中保留。 */
function compactPrice(value: string): string {
  const normalized = value.replace(/^0\./, ".");
  return normalized.length <= 9 ? normalized : `${normalized.slice(0, 8)}~`;
}

function color(value: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${value}${ANSI.reset}` : value;
}

function statusColor(status: DashboardStatus): string {
  if (status === "KEEP") return ANSI.green;
  if (status === "WARN") return ANSI.yellow;
  if (status === "ACTION" || status === "PLAN") return ANSI.magenta;
  return ANSI.red;
}

function eventColor(kind: DashboardEventKind): string {
  if (kind === "INFO") return ANSI.cyan;
  if (kind === "WARN") return ANSI.yellow;
  if (kind === "ACTION") return ANSI.magenta;
  return ANSI.red;
}

/** 将 Bot 审计消息归类为有限的近期事件；普通每轮监控和区间行不重复占用事件区。 */
function auditEventKind(message: string): DashboardEventKind | null {
  if (/^(监控 strategyHash=|旧策略区间：|官方策略 API 返回 active 仓位数=|开始请求 EMSH current：|EMSH current 成功：)/.test(message)) return null;
  if (/(失败|错误|阻止|不一致|退出)/.test(message)) return "ERROR";
  if (/(已生成自动计划|dock|ship|恢复未完成计划|恢复 dock|恢复 ship|自动重挂完成)/.test(message)) return "ACTION";
  if (/(跳过|冷却|等待策略 API)/.test(message)) return "WARN";
  return "INFO";
}

/**
 * 仅在交互终端启用的状态面板。
 * 每轮先 beginSnapshot 清空旧行，随后 upsert 策略状态，最后 render 一次，避免 API 查询过程显示混合轮次数据。
 */
export class RebalanceTerminalDashboard {
  readonly enabled: boolean;
  private activeStrategies = 0;
  private rows = new Map<string, RebalanceDashboardRow>();
  private events: DashboardEvent[] = [];
  private updatedAt = shortTime();

  constructor(private readonly output: RebalanceTerminalWriter, private readonly useColor = process.env.NO_COLOR === undefined) {
    this.enabled = output.isTTY === true;
  }

  /** 开始一轮新快照，先清理不再从 API 返回的旧策略行。 */
  beginSnapshot(activeStrategies: number): void {
    this.activeStrategies = activeStrategies;
    this.rows.clear();
    this.updatedAt = shortTime();
  }

  /** 更新一条逻辑仓位的终端行；key 必须包含完整 strategyHash，防止同 pair 策略互相覆盖。 */
  upsert(row: RebalanceDashboardRow): void {
    this.rows.set(row.strategyHash.toLowerCase(), row);
  }

  /** 将重要运行事件加入固定容量队列，超出时只丢弃最旧的已展示事件。 */
  addEvent(kind: DashboardEventKind, message: string): void {
    this.events.push({ time: shortTime(), kind, message });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  /** 由审计 logger 调用；文件仍会记录全部消息，终端仅保留对操作有意义的事件。 */
  recordAuditMessage(message: string): boolean {
    const kind = auditEventKind(message);
    if (!kind) return false;
    this.addEvent(kind, message);
    return true;
  }

  /** 统计当前行的状态，帮助值守者先看总体风险而不是逐行数数。 */
  private statusSummary(): string {
    const counts: Record<DashboardStatus, number> = { KEEP: 0, WARN: 0, ACTION: 0, BLOCK: 0, PLAN: 0 };
    for (const row of this.rows.values()) counts[row.status] += 1;
    return `active=${this.activeStrategies} keep=${counts.KEEP} warn=${counts.WARN} action=${counts.ACTION + counts.PLAN} block=${counts.BLOCK}`;
  }

  private fullTable(width: number): string[] {
    const columns = [
      { header: "策略", width: 14, value: (row: RebalanceDashboardRow) => shortHash(row.strategyHash) },
      { header: "交易对", width: 18, value: (row: RebalanceDashboardRow) => row.pair },
      { header: "当前价格", width: 15, value: (row: RebalanceDashboardRow) => row.current },
      { header: "价格区间", width: 29, value: (row: RebalanceDashboardRow) => `${row.min}-${row.max}` },
      { header: "越界", width: 10, value: (row: RebalanceDashboardRow) => row.outside },
      { header: "连续", width: 7, value: (row: RebalanceDashboardRow) => row.breach },
      { header: "价差", width: 10, value: (row: RebalanceDashboardRow) => row.deviation },
      { header: "状态/原因", width: Math.max(18, width - 125), value: (row: RebalanceDashboardRow) => `[${row.status}] ${row.reason}` },
    ];
    const header = columns.map((column) => cell(column.header, column.width)).join("  ");
    const divider = "-".repeat(displayWidth(header));
    const rows = [...this.rows.values()].map((row) => columns.map((column, index) => {
      const value = cell(column.value(row), column.width);
      return index === columns.length - 1 ? color(value, statusColor(row.status), this.useColor) : value;
    }).join("  "));
    return [header, divider, ...rows];
  }

  private compactTable(): string[] {
    const columns = [
      { header: "策略", width: 14, value: (row: RebalanceDashboardRow) => shortHash(row.strategyHash) },
      { header: "交易对", width: 14, value: (row: RebalanceDashboardRow) => row.pair },
      { header: "当前/区间", width: 24, value: (row: RebalanceDashboardRow) => `${compactPrice(row.current)} ${compactPrice(row.min)}-${compactPrice(row.max)}` },
      { header: "越界", width: 9, value: (row: RebalanceDashboardRow) => row.outside },
      { header: "连续", width: 7, value: (row: RebalanceDashboardRow) => row.breach },
      { header: "状态", width: 12, value: (row: RebalanceDashboardRow) => `[${row.status}]` },
    ];
    const header = columns.map((column) => cell(column.header, column.width)).join("  ");
    const divider = "-".repeat(displayWidth(header));
    const rows = [...this.rows.values()].map((row) => columns.map((column, index) => {
      const value = cell(column.value(row), column.width);
      return index === columns.length - 1 ? color(value, statusColor(row.status), this.useColor) : value;
    }).join("  "));
    return [header, divider, ...rows];
  }

  /** 使用 ANSI 清屏原位刷新；只有 TTY 进入此分支，因此管道、CI 和文件重定向不会收到控制字符。 */
  render(): void {
    if (!this.enabled) return;
    const columns = this.output.columns ?? 120;
    const table = columns >= 145 ? this.fullTable(columns) : this.compactTable();
    const eventWidth = Math.max(40, columns - 2);
    const eventLines = this.events.length === 0
      ? [color("暂无关键事件", ANSI.dim, this.useColor)]
      : this.events.map((event) => color(`${event.time} [${event.kind}] ${truncateDisplay(event.message, eventWidth - 16)}`, eventColor(event.kind), this.useColor));
    const panel = [
      color(`Aqua Rebalance Bot  ${this.updatedAt}  ${this.statusSummary()}`, ANSI.cyan, this.useColor),
      "",
      ...table,
      "",
      "近期事件",
      ...eventLines,
      "",
      color("完整审计日志已写入 logs/；非 TTY 自动使用逐行日志。", ANSI.dim, this.useColor),
    ].join("\n");
    this.output.write(`\x1b[2J\x1b[H${panel}${ANSI.reset}`);
  }

    /** 正常退出时恢复 ANSI 样式并换行，避免 shell prompt 紧贴最后一帧面板。 */
  close(): void {
    if (this.enabled) this.output.write("\x1b[0m\n");
  }
}
