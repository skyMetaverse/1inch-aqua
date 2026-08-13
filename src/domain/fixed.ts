/**
 * 添加 LP 的无损定点数领域工具。
 * 核心功能：解析百分比和十进制价格、按余额比例取整、计算非对称区间，并处理 Aqua 规范地址顺序下的价格反向。
 * 主要流程：所有输入先转换为 bigint 定点值 -> 进行乘除和边界校验 -> 仅在日志展示时格式化为文本。
 */

export const FIXED_SCALE = 10n ** 18n;
const HUNDRED_PERCENT = 100n * FIXED_SCALE;

/** 区间在用户可读报价方向上的模式。 */
export type RangeMode = "two-sided" | "upper" | "lower";

/** 用户可读价格区间，均为 1e18 定点数。 */
export interface DisplayPriceRange {
  current: bigint;
  min: bigint;
  max: bigint;
}

/** Aqua SDK 所需的规范地址价格区间，均为 1e18 定点数。 */
export interface AquaPriceRange {
  rawPriceMin: bigint;
  rawPriceMax: bigint;
  isDisplayOrderCanonical: boolean;
}

/**
 * 解析无符号十进制文本到指定精度。
 * 不允许指数写法、负数或超过精度的小数，避免静默截断造成交易参数变化。
 */
export function parseDecimal(text: string, decimals: number, fieldName: string): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new Error(`${fieldName} 的精度参数无效`);
  }
  const normalized = text.trim();
  const match = normalized.match(/^(?:0|[1-9]\d*)(?:\.(\d+))?$/);
  if (!match) {
    throw new Error(`${fieldName} 必须是非负十进制文本，不能使用指数写法`);
  }

  const [integerText, fractionText = ""] = normalized.split(".");
  if (fractionText.length > decimals) {
    throw new Error(`${fieldName} 小数位超过允许的 ${decimals} 位，拒绝截断`);
  }
  const integer = integerText ?? "0";
  return BigInt(integer) * 10n ** BigInt(decimals) + BigInt(fractionText.padEnd(decimals, "0") || "0");
}

/** 解析带 % 的文本；返回百分比数值本身的 1e18 定点表示，例如 0.001% -> 10^15。 */
export function parsePercentage(text: string, fieldName: string): bigint {
  const normalized = text.trim();
  if (!normalized.endsWith("%")) {
    throw new Error(`${fieldName} 必须使用带 % 的字符串，例如 "0.001%"`);
  }
  return parseDecimal(normalized.slice(0, -1), 18, fieldName);
}

/** 将 1e18 定点值格式化为不带无意义尾随零的十进制文本。 */
export function formatFixed(value: bigint, decimals = 18): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const integer = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${integer.toString()}${fraction ? `.${fraction}` : ""}`;
}

/**
 * 将 1e18 定点价格转换为倒数报价，同样返回 1e18 定点值。
 * 仅用于日志双向展示；向下取整且明确保留 raw 价格审计行，避免展示舍入影响真实策略参数。
 */
export function invertFixedPrice(price: bigint): bigint {
  if (price <= 0n) throw new Error("倒数价格必须大于零");
  return (FIXED_SCALE * FIXED_SCALE) / price;
}

/** 按余额百分比计算投入数量，并向下取整到代币 raw 单位。 */
export function calculatePercentAmount(rawBalance: bigint, balancePercent: bigint): bigint {
  if (rawBalance < 0n) {
    throw new Error("代币余额不能为负数");
  }
  if (balancePercent < 0n || balancePercent > HUNDRED_PERCENT) {
    throw new Error("余额百分比必须在 0% 到 100% 之间");
  }
  return (rawBalance * balancePercent) / HUNDRED_PERCENT;
}

/**
 * 基于 current 价格计算用户可读方向的上下不对称区间。
 * lowerPercent 达到 100% 会使下界为零，因此必须拒绝；upperPercent 不设业务上限。
 */
export function calculateDisplayRange(
  current: bigint,
  mode: RangeMode,
  upperPercent: bigint | undefined,
  lowerPercent: bigint | undefined,
): DisplayPriceRange {
  if (current <= 0n) {
    throw new Error("current 价格必须大于零");
  }
  const upper = upperPercent ?? 0n;
  const lower = lowerPercent ?? 0n;
  if (upper < 0n || lower < 0n) {
    throw new Error("价格浮动百分比不能为负数");
  }

  if (mode === "two-sided" && (upper === 0n || lower === 0n)) {
    throw new Error("双边模式必须同时配置大于 0% 的 upperPercent 和 lowerPercent");
  }
  if (mode === "upper" && upper === 0n) {
    throw new Error("上单边模式必须配置大于 0% 的 upperPercent");
  }
  if (mode === "lower" && (lower === 0n || lower >= HUNDRED_PERCENT)) {
    throw new Error("下单边模式的 lowerPercent 必须大于 0% 且小于 100%");
  }

  const max = mode === "lower" ? current : (current * (HUNDRED_PERCENT + upper)) / HUNDRED_PERCENT;
  const min = mode === "upper" ? current : (current * (HUNDRED_PERCENT - lower)) / HUNDRED_PERCENT;
  if (min <= 0n || min >= max) {
    throw new Error("计算后的价格区间无效：必须满足 0 < priceMin < priceMax");
  }
  return { current, min, max };
}

/**
 * 将用户 token 顺序下的价格区间转换为 Aqua 的 tokenGt/tokenLt 规范价格。
 * displayToken0 < displayToken1 时报价方向已经等于 tokenGt/tokenLt；反向时取倒数且交换上下界。
 */
export function convertDisplayRangeToAquaRange(
  displayToken0: string,
  displayToken1: string,
  displayRange: DisplayPriceRange,
): AquaPriceRange {
  const canonical = displayToken0.toLowerCase() < displayToken1.toLowerCase();
  if (canonical) {
    return {
      rawPriceMin: displayRange.min,
      rawPriceMax: displayRange.max,
      isDisplayOrderCanonical: true,
    };
  }

  // raw P 均为 1e18 精度，倒数计算为 1e36 / P；上下界反转是价格倒数的单调递减性质。
  const rawPriceMin = (FIXED_SCALE * FIXED_SCALE) / displayRange.max;
  const rawPriceMax = (FIXED_SCALE * FIXED_SCALE) / displayRange.min;
  if (rawPriceMin <= 0n || rawPriceMin >= rawPriceMax) {
    throw new Error("反向转换后的 Aqua 价格区间无效");
  }
  return { rawPriceMin, rawPriceMax, isDisplayOrderCanonical: false };
}

/**
 * 将 Aqua 规范 tokenGt/tokenLt 的 raw 区间转换回 API token 顺序的展示区间。
 * 旧策略解码得到的是规范地址方向；该转换只用于判断 current 是否越界，必须与创建时的反向规则完全对称。
 */
export function convertAquaRangeToDisplayRange(
  displayToken0: string,
  displayToken1: string,
  aquaRange: { rawPriceMin: bigint; rawPriceMax: bigint },
): Pick<DisplayPriceRange, "min" | "max"> {
  if (aquaRange.rawPriceMin <= 0n || aquaRange.rawPriceMin >= aquaRange.rawPriceMax) throw new Error("Aqua raw 价格区间无效");
  if (displayToken0.toLowerCase() < displayToken1.toLowerCase()) return { min: aquaRange.rawPriceMin, max: aquaRange.rawPriceMax };
  const min = (FIXED_SCALE * FIXED_SCALE) / aquaRange.rawPriceMax;
  const max = (FIXED_SCALE * FIXED_SCALE) / aquaRange.rawPriceMin;
  if (min <= 0n || min >= max) throw new Error("反向展示价格区间无效");
  return { min, max };
}

/**
 * 将页面显示费率转换为 SDK FlatFee 的内部整数值。
 * SDK 编码为 feePercent * 10^7，例如 0.001% 必须精确得到 10000。
 */
export function percentageToAquaFeeValue(feePercent: bigint): bigint {
  if (feePercent < 0n) {
    throw new Error("费率不能为负数");
  }
  const divisor = 10n ** 11n;
  if (feePercent % divisor !== 0n) {
    throw new Error("费率无法被当前 Aqua SDK 的 10^-7% 精度精确表达");
  }
  const value = feePercent / divisor;
  if (value > 1_000_000_000n) {
    throw new Error("费率不能超过 100%");
  }
  return value;
}

/**
 * 将 SDK 内部 fee 值转换为 withFeeTokenIn 所需的 bps 数字。
 * 此处是唯一 Number 边界：fee 值范围不超过 10^9，整数转换无损，随后反向校验保证 SDK 编码完全一致。
 */
export function aquaFeeValueToBps(feeValue: bigint): number {
  if (feeValue < 0n || feeValue > 1_000_000_000n) {
    throw new Error("Aqua 内部费率值超出 uint32/100% 范围");
  }
  const bps = Number(feeValue) / 100_000;
  if (!Number.isFinite(bps) || BigInt(bps * 100_000) !== feeValue) {
    throw new Error("费率无法无损转换为 Aqua SDK 的 bps 参数");
  }
  return bps;
}
