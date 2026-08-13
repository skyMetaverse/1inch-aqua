/**
 * ERC20 读取与最大授权适配器。
 * 核心功能：读取 decimals、余额和 allowance，构建最大授权交易，并处理 Ethereum 主网 USDT 的先清零再授权约束。
 * 主要流程：链上读取 token 状态 -> 判断最大授权状态 -> 生成一笔或两笔 approve 交易 -> 每笔确认后复查。
 */
import { encodeFunctionData, type Address, type Hex } from "viem";

export const MAX_UINT256 = (1n << 256n) - 1n;
export const ETHEREUM_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;

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

/** 读取真实链上状态；token 合约非标准或读取失败时必须停止而非猜测精度。 */
export async function readTokenState(
  publicClient: { readContract(parameters: unknown): Promise<unknown> },
  token: Address,
  owner: Address,
  spender: Address,
): Promise<TokenState> {
  const [decimalsResult, balanceResult, allowanceResult] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] }),
  ]);
  const decimals = Number(decimalsResult);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(`token=${token} 返回无效 decimals`);
  return { decimals, balance: BigInt(balanceResult as bigint), allowance: BigInt(allowanceResult as bigint) };
}

/** 构建标准 ERC20 approve calldata。 */
export function buildApproveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] });
}

/**
 * 计算最大授权所需的交易序列。
 * 仅对已确认的 Ethereum 主网 USDT 地址，在旧 allowance 非零时强制先清零；不能根据 symbol 推断此兼容性。
 */
export function buildMaximumApprovalSteps(chainId: number, token: Address, currentAllowance: bigint, spender: Address): Array<{ amount: bigint; data: Hex; reason: string }> {
  if (currentAllowance === MAX_UINT256) return [];
  const isEthereumUsdt = chainId === 1 && token.toLowerCase() === ETHEREUM_USDT.toLowerCase();
  if (isEthereumUsdt && currentAllowance !== 0n) {
    return [
      { amount: 0n, data: buildApproveData(spender, 0n), reason: "USDT 当前授权非零，先清零以兼容合约限制" },
      { amount: MAX_UINT256, data: buildApproveData(spender, MAX_UINT256), reason: "设置 USDT 最大授权" },
    ];
  }
  return [{ amount: MAX_UINT256, data: buildApproveData(spender, MAX_UINT256), reason: "设置 ERC20 最大授权" }];
}
