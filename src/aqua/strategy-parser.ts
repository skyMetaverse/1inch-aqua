/**
 * Aqua 集中流动性旧策略解析。
 * 核心功能：从官方 API 返回的 strategyBytes 解码 Order 与 Aqua 指令，并提取真实的规范 raw 价格区间。
 * 主要流程：解码 Order -> 解码 Aqua program -> 唯一集中流动性指令 -> sqrt 价格平方还原 raw 价格。
 */
import { AquaProgramBuilder, HexString, Order, instructions } from "@1inch/swap-vm-sdk";
import type { Hex } from "viem";

const SCALE = 10n ** 18n;

/**
 * 从集中流动性策略取得规范 tokenGt/tokenLt 的 raw 区间。
 * sqrtPrice 在 SDK 中由 bigint floor sqrt 构造，因此回转的 raw 下界可能比创建入参少不足 1 raw 单位；该值仅用于越界判断审计。
 */
export function parseConcentratedRawRange(strategyBytes: Hex): { rawPriceMin: bigint; rawPriceMax: bigint } {
  const order = Order.decode(new HexString(strategyBytes));
  const decodedInstructions = AquaProgramBuilder.decode(order.program).getInstructions();
  const matches = decodedInstructions.filter((instruction) => instruction.opcode.id === instructions.concentrate.concentrateGrowLiquidity2D.id);
  if (matches.length !== 1) throw new Error(`策略必须恰好包含一个集中流动性指令，实际=${matches.length}`);
  const args = matches[0]?.args as { sqrtPriceMin?: unknown; sqrtPriceMax?: unknown } | undefined;
  if (typeof args?.sqrtPriceMin !== "bigint" || typeof args.sqrtPriceMax !== "bigint") throw new Error("集中流动性指令参数无法解析");
  const rawPriceMin = (args.sqrtPriceMin * args.sqrtPriceMin) / SCALE;
  const rawPriceMax = (args.sqrtPriceMax * args.sqrtPriceMax) / SCALE;
  if (rawPriceMin <= 0n || rawPriceMin >= rawPriceMax) throw new Error("策略解析出的 raw 价格区间无效");
  return { rawPriceMin, rawPriceMax };
}
