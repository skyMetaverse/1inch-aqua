/**
 * 添加 LP 的统一中文运行日志模块。
 * 核心功能：按跨平台安全文件名创建每次运行日志，并将固定 info 格式同时写入终端和文件。
 * 主要流程：创建 logs 文件 -> 格式化毫秒时间戳 -> 逐行安全落盘和输出。
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Logger {
  readonly filePath: string;
  info(message: string): void;
}

function timestamp(forFileName: boolean): string {
  const now = new Date();
  const pad = (value: number, length = 2): string => String(value).padStart(length, "0");
  const separator = forFileName ? "-" : ":";
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${separator}${pad(now.getMinutes())}${separator}${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

/** 创建一次运行唯一的日志文件；文件名不用冒号以兼容 Windows。 */
export function createLogger(directory = "logs"): Logger {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const filePath = join(directory, `${timestamp(true)}.log`);
  writeFileSync(filePath, "", { encoding: "utf8", flag: "wx" });
  return {
    filePath,
    info(message: string): void {
      const line = `${timestamp(false)} [info]: ${message}`;
      process.stdout.write(`${line}\n`);
      appendFileSync(filePath, `${line}\n`, "utf8");
    },
  };
}

/** 供脚本启动前错误使用同一时间格式；此时尚未有安全创建的日志文件。 */
export function formatLogLine(message: string): string {
  return `${timestamp(false)} [info]: ${message}`;
}
