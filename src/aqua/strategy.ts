/**
 * Aqua 集中流动性策略构建模块。
 * 核心功能：将已校验的精确 raw 价格、费率和 token amount 转换为 SwapVM program、strategy hash 和 ship 交易。
 * 主要流程：校验 SDK 链地址 -> 构建 concentrate program -> 设置无损费率 -> 生成 Order -> 构建 registry ship calldata。
 */
import { randomBytes } from "node:crypto";
import {
  AquaXYCAmmStrategy,
  AQUA_SWAP_VM_CONTRACT_ADDRESSES,
  MakerTraits,
  Order,
} from "@1inch/swap-vm-sdk";
import { AQUA_CONTRACT_ADDRESSES, AquaProtocolContract, Address, HexString, NetworkEnum } from "@1inch/aqua-sdk";
import type { Address as ViemAddress, Hex } from "viem";
import { aquaFeeValueToBps } from "../domain/fixed.ts";

export interface BuiltStrategy {
  registry: ViemAddress;
  app: ViemAddress;
  strategyHash: Hex;
  strategy: Hex;
  ship: { to: ViemAddress; data: Hex; value: bigint };
  feeBps: number;
  salt: bigint;
}

/** 历史 rawPrice 与 decimals-aware sqrtPrice 两种 SDK 参数形态；新建 mixed-decimals 仓位必须使用 sqrt 形态。 */
type ConcentratedPriceBounds =
  | { rawPriceMin: bigint; rawPriceMax: bigint; sqrtPriceMin?: never; sqrtPriceMax?: never }
  | { sqrtPriceMin: bigint; sqrtPriceMax: bigint; rawPriceMin?: never; rawPriceMax?: never };

/**
 * 构建 ship 交易。所有金额、价格和 feeValue 均已在领域层精确校验。
 * feeBps 是 SDK 现有 API 的唯一 Number 边界，aquaFeeValueToBps 已验证其乘回 10^5 后与原始整数一致。
 */
export function buildConcentratedStrategy(parameters: {
  chainId: number;
  maker: ViemAddress;
  feeValue: bigint;
  amounts: Array<{ token: ViemAddress; amount: bigint }>;
  salt?: bigint;
} & ConcentratedPriceBounds): BuiltStrategy {
  let priceBounds: ConcentratedPriceBounds;
  if (parameters.sqrtPriceMin !== undefined || parameters.sqrtPriceMax !== undefined) {
    const sqrtPriceMin = parameters.sqrtPriceMin;
    const sqrtPriceMax = parameters.sqrtPriceMax;
    if (sqrtPriceMin === undefined || sqrtPriceMax === undefined || sqrtPriceMin <= 0n || sqrtPriceMin >= sqrtPriceMax) throw new Error("Aqua sqrtPrice 区间无效");
    priceBounds = { sqrtPriceMin, sqrtPriceMax };
  } else {
    const rawPriceMin = parameters.rawPriceMin;
    const rawPriceMax = parameters.rawPriceMax;
    if (rawPriceMin === undefined || rawPriceMax === undefined || rawPriceMin <= 0n || rawPriceMin >= rawPriceMax) throw new Error("Aqua rawPrice 区间无效");
    priceBounds = { rawPriceMin, rawPriceMax };
  }
  // 单边仓位需要把另一侧以 0 作为虚拟余额 ship；因此允许单项为零，但不能两个都为零。
  if (parameters.amounts.length !== 2 || parameters.amounts.some((item) => item.amount < 0n) || parameters.amounts.every((item) => item.amount === 0n)) {
    throw new Error("Aqua 集中流动性策略必须包含两个非负 ERC20 数量，且至少一侧大于零");
  }
  const network = parameters.chainId as NetworkEnum;
  const registry = AQUA_CONTRACT_ADDRESSES[network];
  const app = AQUA_SWAP_VM_CONTRACT_ADDRESSES[network];
  if (!registry || !app) throw new Error(`当前 SDK 不支持 chainId=${parameters.chainId} 的 Aqua 策略地址`);

  const feeBps = aquaFeeValueToBps(parameters.feeValue);
  // Aqua 已 dock 的 strategyHash 不能原地重开；新建时使用 64 位加密随机 salt，恢复时复用已持久化 salt 保证不会生成第二个策略 hash。
  const salt = parameters.salt ?? BigInt(`0x${randomBytes(8).toString("hex")}`);
  if (salt < 0n || salt > (2n ** 64n - 1n)) throw new Error("策略 salt 必须是 uint64");
  // sqrtPrice 保留 decimals 归一化后的小数精度；rawPrice 仅保留给已存在的同 decimals 调用兼容层。
  const program = AquaXYCAmmStrategy.newConcentrate(priceBounds).withFeeTokenIn(feeBps).withSalt(salt).build();
  const order = Order.new({ maker: new Address(parameters.maker), program, traits: MakerTraits.default() });
  const strategy = order.encode();
  const aqua = new AquaProtocolContract(registry);
  const shipTx = aqua.ship({
    app,
    strategy,
    amountsAndTokens: parameters.amounts.map((item) => ({ token: new Address(item.token), amount: item.amount })),
  });

  return {
    registry: registry.toString() as ViemAddress,
    app: app.toString() as ViemAddress,
    strategyHash: AquaProtocolContract.calculateStrategyHash(strategy).toString() as Hex,
    strategy: strategy.toString() as Hex,
    ship: { to: shipTx.to.toString() as ViemAddress, data: shipTx.data.toString() as Hex, value: shipTx.value },
    feeBps,
    salt,
  };
}
