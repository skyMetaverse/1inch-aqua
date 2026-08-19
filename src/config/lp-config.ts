/**
 * 添加 LP 的 JSONC 配置模型与校验。
 * 核心功能：将解析后的未知 JSON 数据严格校验为链、交易对、余额比例、页面显示费率和价格区间配置。
 * 主要流程：检查对象结构和未知字段 -> 校验地址/百分比/区间规则 -> 输出不含运行时链上数据的配置对象。
 */

import { isAddress, type Address } from "viem";
import { parsePercentage, type RangeMode } from "../domain/fixed.ts";

export interface TokenConfig {
  symbol: string;
  address: Address;
  balancePercent: string;
}

export interface PositionConfig {
  /** 配置仓位的稳定标识；Bot 用它追踪动态重挂后的当前 strategyHash。 */
  id: string;
  pair: { tokens: [TokenConfig, TokenConfig] };
  fee: string;
  range: {
    mode: RangeMode;
    upperPercent?: string;
    lowerPercent?: string;
  };
}

export interface AddLpConfig {
  chainId: number;
  positions: PositionConfig[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 拒绝未知字段，防止拼写错误被悄悄忽略后创建错误仓位。 */
function requireOnlyKeys(value: Record<string, unknown>, allowed: string[], fieldName: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${fieldName} 包含不支持字段：${key}`);
    }
  }
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} 必须是非空字符串`);
  }
  return value.trim();
}

function requireOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, fieldName);
}

function parseToken(value: unknown, fieldName: string): TokenConfig {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} 必须是对象`);
  }
  requireOnlyKeys(value, ["symbol", "address", "balancePercent"], fieldName);
  const symbol = requireString(value.symbol, `${fieldName}.symbol`);
  const addressText = requireString(value.address, `${fieldName}.address`);
  if (!isAddress(addressText)) {
    throw new Error(`${fieldName}.address 不是有效 EVM 地址`);
  }
  const balancePercent = requireString(value.balancePercent, `${fieldName}.balancePercent`);
  const percentValue = parsePercentage(balancePercent, `${fieldName}.balancePercent`);
  if (percentValue > 100n * 10n ** 18n) {
    throw new Error(`${fieldName}.balancePercent 必须在 0% 到 100% 之间`);
  }
  return { symbol, address: addressText, balancePercent };
}

function parsePosition(value: unknown, index: number): PositionConfig {
  const fieldName = `positions[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${fieldName} 必须是对象`);
  }
  requireOnlyKeys(value, ["id", "pair", "fee", "range"], fieldName);
  const id = requireString(value.id, `${fieldName}.id`);
  if (!isRecord(value.pair)) {
    throw new Error(`${fieldName}.pair 必须是对象`);
  }
  requireOnlyKeys(value.pair, ["tokens"], `${fieldName}.pair`);
  if (!Array.isArray(value.pair.tokens) || value.pair.tokens.length !== 2) {
    throw new Error(`${fieldName}.pair.tokens 必须恰好包含两个 ERC20 代币`);
  }
  const token0 = parseToken(value.pair.tokens[0], `${fieldName}.pair.tokens[0]`);
  const token1 = parseToken(value.pair.tokens[1], `${fieldName}.pair.tokens[1]`);
  if (token0.address.toLowerCase() === token1.address.toLowerCase()) {
    throw new Error(`${fieldName}.pair.tokens 不能配置重复代币地址`);
  }

  const fee = requireString(value.fee, `${fieldName}.fee`);
  if (parsePercentage(fee, `${fieldName}.fee`) <= 0n) {
    throw new Error(`${fieldName}.fee 必须大于 0%`);
  }

  if (!isRecord(value.range)) {
    throw new Error(`${fieldName}.range 必须是对象`);
  }
  requireOnlyKeys(value.range, ["mode", "upperPercent", "lowerPercent"], `${fieldName}.range`);
  const mode = requireString(value.range.mode, `${fieldName}.range.mode`);
  if (mode !== "two-sided" && mode !== "upper" && mode !== "lower") {
    throw new Error(`${fieldName}.range.mode 只支持 two-sided、upper 或 lower`);
  }
  const upperPercent = requireOptionalString(value.range.upperPercent, `${fieldName}.range.upperPercent`);
  const lowerPercent = requireOptionalString(value.range.lowerPercent, `${fieldName}.range.lowerPercent`);
  const upperValue = upperPercent ? parsePercentage(upperPercent, `${fieldName}.range.upperPercent`) : 0n;
  const lowerValue = lowerPercent ? parsePercentage(lowerPercent, `${fieldName}.range.lowerPercent`) : 0n;

  if (mode === "two-sided" && (upperValue <= 0n || lowerValue <= 0n)) {
    throw new Error(`${fieldName} 双边模式必须同时配置大于 0% 的 upperPercent 和 lowerPercent`);
  }
  if (mode === "upper" && upperValue <= 0n) {
    throw new Error(`${fieldName} 上单边模式必须配置大于 0% 的 upperPercent`);
  }
  if (mode === "upper" && lowerValue !== 0n) {
    throw new Error(`${fieldName} 上单边模式不能配置非零 lowerPercent`);
  }
  if (mode === "lower" && (lowerValue <= 0n || lowerValue >= 100n * 10n ** 18n)) {
    throw new Error(`${fieldName} 下单边模式的 lowerPercent 必须大于 0% 且小于 100%`);
  }
  if (mode === "lower" && upperValue !== 0n) {
    throw new Error(`${fieldName} 下单边模式不能配置非零 upperPercent`);
  }

  return {
    id,
    pair: { tokens: [token0, token1] },
    fee,
    range: { mode, upperPercent, lowerPercent },
  };
}

/** 将 JSONC 解析结果规范化为严格的添加 LP 配置。 */
export function validateAddLpConfig(value: unknown): AddLpConfig {
  if (!isRecord(value)) {
    throw new Error("配置根节点必须是对象");
  }
  requireOnlyKeys(value, ["chainId", "positions"], "配置根节点");
  if (!Number.isInteger(value.chainId) || (value.chainId as number) <= 0) {
    throw new Error("chainId 必须是正整数");
  }
  if (!Array.isArray(value.positions) || value.positions.length === 0) {
    throw new Error("positions 必须是非空数组");
  }
  const positions = value.positions.map((position, index) => parsePosition(position, index));
  const ids = new Set<string>();
  for (const position of positions) {
    if (ids.has(position.id)) {
      throw new Error(`positions.id 不能重复：${position.id}`);
    }
    ids.add(position.id);
  }
  return {
    chainId: value.chainId as number,
    positions,
  };
}
