/**
 * ERC20 最大授权决策回归测试。
 * 核心功能：验证标准代币直接最大授权、已最大授权跳过，以及 Ethereum 主网 USDT 的非零 allowance 清零序列。
 * 主要流程：构造确定性 allowance 状态 -> 生成 approve 步骤 -> 断言目标额度、交易数量和兼容原因。
 */
import { expect, test } from "bun:test";
import { buildMaximumApprovalSteps, ETHEREUM_USDT, MAX_UINT256 } from "./erc20.ts";

const registry = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a" as const;
const oneInch = "0x111111111117dc0aa78b770fa6a738034120c302" as const;

test("标准 ERC20 非最大 allowance 直接设为最大值", () => {
  const steps = buildMaximumApprovalSteps(1, oneInch, 1n, registry);
  expect(steps).toHaveLength(1);
  expect(steps[0]?.amount).toBe(MAX_UINT256);
});

test("已是最大授权时不生成 approve", () => {
  expect(buildMaximumApprovalSteps(1, oneInch, MAX_UINT256, registry)).toEqual([]);
});

test("Ethereum 主网 USDT 的非零 allowance 必须先清零", () => {
  const steps = buildMaximumApprovalSteps(1, ETHEREUM_USDT, 1n, registry);
  expect(steps).toHaveLength(2);
  expect(steps[0]?.amount).toBe(0n);
  expect(steps[1]?.amount).toBe(MAX_UINT256);
});

test("Ethereum 主网 USDT 的零 allowance 可直接最大授权", () => {
  const steps = buildMaximumApprovalSteps(1, ETHEREUM_USDT, 0n, registry);
  expect(steps).toHaveLength(1);
  expect(steps[0]?.amount).toBe(MAX_UINT256);
});
