/**
 * 自动再平衡 Bot 的 JSONC 配置校验。
 * 核心功能：将本地运行配置转为严格类型，拒绝未知字段和不安全的阈值，避免自动交易静默采用错误参数。
 * 主要流程：校验对象结构 -> 校验整数轮询参数 -> 解析百分比 bigint -> 返回规范化配置。
 */
import { parsePercentage } from "../domain/fixed.ts";

export interface RebalanceConfig {
  chainId: number;
  polling: { intervalSeconds: number; stableSnapshotsRequired: number; maxCurrentPriceAgeSeconds: number };
  market: { maxPairPriceDeviationPercent: string; minimumPairSwaps: number };
  rebalance: { fee: string; singleSidedWidth: string; twoSidedHalfWidth: string; recenterExcess: string; cooldownSeconds: number; convertToTwoSidedMinValueRatioBps: number };
  runtime: { stateFile: string };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, keys: string[], field: string): void { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${field} 包含不支持字段：${key}`); }
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${field} 必须是正整数`); return value as number; }
function stringValue(value: unknown, field: string): string { if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} 必须是非空字符串`); return value.trim(); }
function percent(value: unknown, field: string, allowZero = false): string { const text = stringValue(value, field); const parsed = parsePercentage(text, field); if (parsed < 0n || (!allowZero && parsed === 0n) || parsed >= 100n * 10n ** 18n) throw new Error(`${field} 必须大于 0% 且小于 100%`); return text; }

/** 严格校验 Bot 配置；所有核心百分比仍以字符串交给 bigint 领域层计算。 */
export function validateRebalanceConfig(value: unknown): RebalanceConfig {
  if (!isRecord(value)) throw new Error("配置根节点必须是对象");
  onlyKeys(value, ["chainId", "polling", "market", "rebalance", "runtime"], "配置根节点");
  const chainId = positiveInteger(value.chainId, "chainId");
  if (!isRecord(value.polling)) throw new Error("polling 必须是对象");
  onlyKeys(value.polling, ["intervalSeconds", "stableSnapshotsRequired", "maxCurrentPriceAgeSeconds"], "polling");
  if (!isRecord(value.market)) throw new Error("market 必须是对象");
  onlyKeys(value.market, ["maxPairPriceDeviationPercent", "minimumPairSwaps"], "market");
  if (!isRecord(value.rebalance)) throw new Error("rebalance 必须是对象");
  onlyKeys(value.rebalance, ["fee", "singleSidedWidth", "twoSidedHalfWidth", "recenterExcess", "cooldownSeconds", "convertToTwoSidedMinValueRatioBps"], "rebalance");
  if (!isRecord(value.runtime)) throw new Error("runtime 必须是对象");
  onlyKeys(value.runtime, ["stateFile"], "runtime");
  const ratio = positiveInteger(value.rebalance.convertToTwoSidedMinValueRatioBps, "rebalance.convertToTwoSidedMinValueRatioBps");
  if (ratio > 10_000) throw new Error("rebalance.convertToTwoSidedMinValueRatioBps 不能超过 10000");
  return {
    chainId,
    polling: { intervalSeconds: positiveInteger(value.polling.intervalSeconds, "polling.intervalSeconds"), stableSnapshotsRequired: positiveInteger(value.polling.stableSnapshotsRequired, "polling.stableSnapshotsRequired"), maxCurrentPriceAgeSeconds: positiveInteger(value.polling.maxCurrentPriceAgeSeconds, "polling.maxCurrentPriceAgeSeconds") },
    market: { maxPairPriceDeviationPercent: percent(value.market.maxPairPriceDeviationPercent, "market.maxPairPriceDeviationPercent"), minimumPairSwaps: positiveInteger(value.market.minimumPairSwaps, "market.minimumPairSwaps") },
    rebalance: { fee: percent(value.rebalance.fee, "rebalance.fee"), singleSidedWidth: percent(value.rebalance.singleSidedWidth, "rebalance.singleSidedWidth"), twoSidedHalfWidth: percent(value.rebalance.twoSidedHalfWidth, "rebalance.twoSidedHalfWidth"), recenterExcess: percent(value.rebalance.recenterExcess, "rebalance.recenterExcess"), cooldownSeconds: positiveInteger(value.rebalance.cooldownSeconds, "rebalance.cooldownSeconds"), convertToTwoSidedMinValueRatioBps: ratio },
    runtime: { stateFile: stringValue(value.runtime.stateFile, "runtime.stateFile") },
  };
}
