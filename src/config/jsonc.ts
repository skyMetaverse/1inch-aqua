/** JSONC 配置文件读取模块：解析带中文注释的 JSONC 并拒绝语法错误，供添加 LP 脚本使用。 */
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

export function readJsoncFile(path: string): unknown {
  const errors: Array<{ error: number; offset: number; length: number }> = [];
  const value = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(`JSONC 配置语法错误：错误代码=${first?.error ?? "unknown"}，位置=${first?.offset ?? 0}`);
  }
  return value;
}
