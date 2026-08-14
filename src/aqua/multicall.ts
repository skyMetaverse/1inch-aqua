/**
 * Aqua registry multicall 编码工具。
 * 核心功能：将多个同一 registry 的 dock 或 ship calldata 组装为 atomic multicall(bytes[]) 交易。
 * 主要流程：校验子调用目标和 value -> 编码 0xac9650d8 selector -> 返回可本地签名的单笔交易请求。
 */
import { encodeFunctionData, type Address, type Hex } from "viem";

/** Aqua registry 在主网已验证支持的 multicall(bytes[]) 最小 ABI。 */
export const AQUA_MULTICALL_ABI = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const;

export interface AquaMulticallChild {
  to: Address;
  data: Hex;
  value: bigint;
}

/**
 * 构造 Aqua registry 的原子批量交易。
 * Aqua dock/ship 已验证为 value=0；拒绝非零 value，避免 delegatecall multicall 共享 msg.value 时错误复用资金。
 */
export function buildAquaMulticallTransaction(registry: Address, children: readonly AquaMulticallChild[]): { to: Address; data: Hex; value: bigint } {
  if (children.length < 2) throw new Error("Aqua multicall 至少需要两个子调用");
  const normalizedRegistry = registry.toLowerCase();
  for (const [index, child] of children.entries()) {
    if (child.to.toLowerCase() !== normalizedRegistry) throw new Error(`Aqua multicall 子调用 ${index + 1} 的目标不是 registry`);
    if (child.value !== 0n) throw new Error(`Aqua multicall 子调用 ${index + 1} 的 value 必须为 0`);
    if (child.data === "0x") throw new Error(`Aqua multicall 子调用 ${index + 1} 的 calldata 不能为空`);
  }
  return {
    to: registry,
    data: encodeFunctionData({ abi: AQUA_MULTICALL_ABI, functionName: "multicall", args: [children.map((child) => child.data)] }),
    value: 0n,
  };
}
