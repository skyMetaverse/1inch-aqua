/**
 * 自动再平衡的纯领域决策。
 * 核心功能：基于已校验的 API 余额、旧区间和 current 价格，判断保持、重挂单边、转双边或阻止。
 * 主要流程：识别源模式与当前资产状态 -> 校验市场门槛 -> 判断部分成交转双边或价格越界 -> 输出无副作用决定。
 */
import { FIXED_SCALE, type DisplayPriceRange } from "./fixed.ts";

export type RebalanceMode = "upper" | "lower" | "two-sided";
export type RebalanceDecision = { action: "keep"; reason: string } | { action: "rehang"; targetMode: RebalanceMode; reason: string } | { action: "block"; reason: string };
export interface BalanceSnapshot { initial: [bigint, bigint]; current: [bigint, bigint]; usd: [number, number]; }

/** 以创建时余额识别原策略模式，避免将单边部分成交的双余额误当为原双边。 */
export function classifySourceMode(initial: [bigint, bigint]): RebalanceMode | null {
  if (initial[0] > 0n && initial[1] === 0n) return "upper";
  if (initial[0] === 0n && initial[1] > 0n) return "lower";
  if (initial[0] > 0n && initial[1] > 0n) return "two-sided";
  return null;
}

/** 当前两侧是否都有可部署 raw 余额。 */
export function hasBothCurrentBalances(current: [bigint, bigint]): boolean { return current[0] > 0n && current[1] > 0n; }

/** 小侧 USD / 大侧 USD 是否达到配置比例；USD 仅用于运营分配判断，不能用于交易金额计算。 */
export function isNearEqualUsd(usd: [number, number], minValueRatioBps: number): boolean {
  if (!Number.isSafeInteger(minValueRatioBps) || minValueRatioBps <= 0 || minValueRatioBps > 10_000) throw new Error("接近等值比例 bps 无效");
  if (!usd.every((value) => Number.isFinite(value) && value > 0)) return false;
  return Math.min(...usd) / Math.max(...usd) >= minValueRatioBps / 10_000;
}

/** current 在区间外时计算相对最近边界的精确百分比；区间内返回 0。 */
export function outsideDistancePercent(current: bigint, range: DisplayPriceRange): bigint {
  if (current <= 0n || range.min <= 0n || range.min >= range.max) throw new Error("价格区间参数无效");
  if (current < range.min) return ((range.min - current) * 100n * FIXED_SCALE) / range.min;
  if (current > range.max) return ((current - range.max) * 100n * FIXED_SCALE) / range.max;
  return 0n;
}

/** 比较两个 1e18 定点价格的相对偏离百分比，以第一个价格为基准。 */
export function relativePriceDeviationPercent(reference: bigint, compared: bigint): bigint {
  if (reference <= 0n || compared <= 0n) throw new Error("价格必须大于零");
  const difference = reference > compared ? reference - compared : compared - reference;
  return (difference * 100n * FIXED_SCALE) / reference;
}

/**
 * 输出唯一的重挂决策。市场门槛、连续越界和冷却由调用方先快照化后传入，避免领域层依赖时钟或网络。
 * illiquidity 是 API 明确要求立即重挂的状态，因此跳过价格越界门槛，但新策略模式仍依据当前余额选择，不能假设旧单边方向仍有资金。
 * 单边部分成交后，接近等值优先转双边；未接近等值时只在需要重挂时保留 USD 较大一侧。
 */
export function decideRebalance(input: {
  balances: BalanceSnapshot;
  currentPrice: bigint;
  oldRange: DisplayPriceRange;
  marketHealthy: boolean;
  stableBreach: boolean;
  cooldownElapsed: boolean;
  recenterExcessPercent: bigint;
  minValueRatioBps: number;
  forceRehangReason?: string;
}): RebalanceDecision {
  const sourceMode = classifySourceMode(input.balances.initial);
  if (!sourceMode) return { action: "block", reason: "策略初始两侧余额均为零，无法识别源模式" };
  if (input.balances.current.some((value) => value < 0n)) return { action: "block", reason: "策略当前 raw 余额不能为负数" };
  if (input.balances.current[0] === 0n && input.balances.current[1] === 0n) return { action: "block", reason: "策略当前两侧余额均为零" };

  const bothCurrent = hasBothCurrentBalances(input.balances.current);
  if (input.forceRehangReason) {
    if (bothCurrent && sourceMode !== "two-sided" && isNearEqualUsd(input.balances.usd, input.minValueRatioBps)) {
      return { action: "rehang", targetMode: "two-sided", reason: input.forceRehangReason };
    }
    if (bothCurrent) {
      const targetMode: RebalanceMode = input.balances.usd[0] >= input.balances.usd[1] ? "upper" : "lower";
      return { action: "rehang", targetMode, reason: input.forceRehangReason };
    }
    return { action: "rehang", targetMode: input.balances.current[0] > 0n ? "upper" : "lower", reason: input.forceRehangReason };
  }

  // 成交量不再作为门槛；此处只在 Pair 最少 swaps 或 Pair/EMSH 交叉校验失败时阻止自动交易。
  if (!input.marketHealthy) return { action: "keep", reason: "Pair swaps 或价格交叉校验未通过，保持当前策略" };
  if (!input.cooldownElapsed) return { action: "keep", reason: "仍处于重挂冷却期" };

  if (sourceMode !== "two-sided" && bothCurrent && isNearEqualUsd(input.balances.usd, input.minValueRatioBps)) {
    return { action: "rehang", targetMode: "two-sided", reason: "单边部分成交后两侧 USD 价值已接近，切换为双边" };
  }

  const outside = outsideDistancePercent(input.currentPrice, input.oldRange);
  if (outside <= input.recenterExcessPercent || !input.stableBreach) {
    return { action: "keep", reason: outside === 0n ? "当前价格仍在旧策略区间内" : "价格越界尚未满足连续确认或额外偏离阈值" };
  }

  if (sourceMode === "two-sided" && bothCurrent) return { action: "rehang", targetMode: "two-sided", reason: "双边策略持续偏离旧区间，按当前价格居中重挂" };
  if (bothCurrent) {
    const targetMode: RebalanceMode = input.balances.usd[0] >= input.balances.usd[1] ? "upper" : "lower";
    return { action: "rehang", targetMode, reason: "单边部分成交后两侧价值未接近，保留价值较大一侧重挂单边" };
  }
  return { action: "rehang", targetMode: input.balances.current[0] > 0n ? "upper" : "lower", reason: "策略持续偏离旧区间，按当前持仓重挂单边" };
}
