/**
 * ERC20 读取与最大授权适配器。
 * 核心功能：读取 decimals、余额和 allowance，尝试最大授权并按本次投入额验证实际有效额度。
 * 主要流程：串行读取 token 状态并有限重试临时 RPC 错误 -> 判断本次投入是否已被覆盖 -> 非零不足授权先清零 -> 尝试最大授权 -> 回读实际 allowance。
 */
import { encodeFunctionData, type Address, type Hex } from "viem";

export const MAX_UINT256 = (1n << 256n) - 1n;
const READ_RETRY_COUNT = 2;
const READ_RETRY_DELAY_MS = 500;

export const ERC20_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export interface TokenState {
  decimals: number;
  balance: bigint;
  allowance: bigint;
}

/**
 * 对单个 RPC 读取进行有限重试。
 * 公共 RPC 可能短暂限流或网络抖动；重试后仍失败必须中止，不能用旧余额或猜测额度继续广播。
 */
async function readWithRetry<T>(read: () => Promise<T>, token: Address, fieldName: string, retryDelayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= READ_RETRY_COUNT; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (attempt === READ_RETRY_COUNT) break;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
  const reason = lastError instanceof Error ? lastError.message.split("\n")[0]?.trim() : "未知 RPC 错误";
  throw new Error(`token=${token} 读取 ${fieldName} 失败，已重试 ${READ_RETRY_COUNT} 次：${reason || "未知 RPC 错误"}`);
}

/**
 * 读取真实链上状态；单 token 内部调用串行执行，降低低额度 RPC 被并发 eth_call 限流的概率。
 * token 合约非标准或重试后仍读取失败时必须停止而非猜测精度。
 */
export async function readTokenState(
  publicClient: { readContract(parameters: unknown): Promise<unknown> },
  token: Address,
  owner: Address,
  spender: Address,
  retryDelayMs = READ_RETRY_DELAY_MS,
): Promise<TokenState> {
  const read = (parameters: unknown, fieldName: string) => readWithRetry(
    () => publicClient.readContract(parameters),
    token,
    fieldName,
    retryDelayMs,
  );
  const decimalsResult = await read({ address: token, abi: ERC20_ABI, functionName: "decimals" }, "decimals");
  const balanceResult = await read({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }, "balanceOf");
  const allowanceResult = await read({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] }, "allowance");
  const decimals = Number(decimalsResult);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(`token=${token} 返回无效 decimals`);
  return { decimals, balance: BigInt(balanceResult as bigint), allowance: BigInt(allowanceResult as bigint) };
}

/**
 * 判断链上实际 allowance 是否能覆盖本次策略可能 pull 的 raw amount。
 * ERC20 ABI 的 approve 参数是 uint256，但实现可采用较小内部存储或无限授权哨兵；不能把等于 MAX_UINT256 当作通用成功条件。
 */
export function hasSufficientAllowance(allowance: bigint, requiredAmount: bigint): boolean {
  if (allowance < 0n || requiredAmount < 0n) throw new Error("allowance 和所需授权额度不能为负数");
  return allowance >= requiredAmount;
}

/** 构建标准 ERC20 approve calldata。 */
export function buildApproveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] });
}

/**
 * 计算尝试最大授权所需的交易序列。
 * ERC20 中存在“旧额度非零时不允许直接修改”的实现；对所有非零不足额度统一先清零，避免维护基于 token 地址的兼容名单。
 */
export function buildMaximumApprovalSteps(
  currentAllowance: bigint,
  requiredAmount: bigint,
  spender: Address,
): Array<{ amount: bigint; data: Hex; reason: string }> {
  if (hasSufficientAllowance(currentAllowance, requiredAmount)) return [];
  if (currentAllowance !== 0n) {
    return [
      { amount: 0n, data: buildApproveData(spender, 0n), reason: "当前授权不足且非零，先清零以兼容 ERC20 授权限制" },
      { amount: MAX_UINT256, data: buildApproveData(spender, MAX_UINT256), reason: "尝试设置 ERC20 最大授权" },
    ];
  }
  return [{ amount: MAX_UINT256, data: buildApproveData(spender, MAX_UINT256), reason: "尝试设置 ERC20 最大授权" }];
}
