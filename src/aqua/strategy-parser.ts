/**
 * Aqua 集中流动性旧策略解析。
 * 核心功能：从官方 API 返回的 strategyBytes 解码 Order 与 Aqua 指令，并提取真实的规范 sqrt/raw 价格区间。
 * 主要流程：解码 Order -> 解码 Aqua program -> 唯一集中流动性指令 -> 保留 sqrt 价格，按需平方得到历史 raw 审计值。
 */
import { AquaProgramBuilder, HexString, Order, instructions } from "@1inch/swap-vm-sdk";
import type { Hex } from "viem";

const SCALE = 10n ** 18n;

/**
 * 从集中流动性策略取得规范 tokenGt/tokenLt 的精确 sqrt 区间。
 * mixed-decimals pair 的两个 sqrt 值可能在平方回转后落入同一个 rawPrice，因此自动再平衡必须保留该层精度。
 */
export function parseConcentratedSqrtRange(strategyBytes: Hex): { sqrtPriceMin: bigint; sqrtPriceMax: bigint } {
  const order = Order.decode(new HexString(strategyBytes));
  const decodedInstructions = AquaProgramBuilder.decode(order.program).getInstructions();
  const matches = decodedInstructions.filter((instruction) => instruction.opcode.id === instructions.concentrate.concentrateGrowLiquidity2D.id);
  if (matches.length !== 1) throw new Error(`策略必须恰好包含一个集中流动性指令，实际=${matches.length}`);
  const args = matches[0]?.args as { sqrtPriceMin?: unknown; sqrtPriceMax?: unknown } | undefined;
  if (typeof args?.sqrtPriceMin !== "bigint" || typeof args.sqrtPriceMax !== "bigint") throw new Error("集中流动性指令参数无法解析");
  if (args.sqrtPriceMin <= 0n || args.sqrtPriceMin >= args.sqrtPriceMax) throw new Error("策略解析出的 sqrt 价格区间无效");
  return { sqrtPriceMin: args.sqrtPriceMin, sqrtPriceMax: args.sqrtPriceMax };
}

/**
 * 返回历史 raw 审计值，供同 decimals 的兼容读取使用。
 * 不得用于 mixed-decimals 策略的区间判断，因为 floor(square / 1e18) 会丢失窄区间信息。
 */
export function parseConcentratedRawRange(strategyBytes: Hex): { rawPriceMin: bigint; rawPriceMax: bigint } {
  const range = parseConcentratedSqrtRange(strategyBytes);
  return {
    rawPriceMin: (range.sqrtPriceMin * range.sqrtPriceMin) / SCALE,
    rawPriceMax: (range.sqrtPriceMax * range.sqrtPriceMax) / SCALE,
  };
}
