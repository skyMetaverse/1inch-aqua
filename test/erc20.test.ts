/**
 * ERC20 授权决策回归测试。
 * 核心功能：验证授权是否覆盖本次投入，而非假设每种 ERC20 都会把 MAX_UINT256 原样存储；所有非零不足额度统一先清零。
 * 主要流程：构造确定性 allowance 与所需投入 -> 生成 approve 步骤 -> 断言覆盖判断、目标额度和通用兼容分支。
 */
import { expect, test } from "bun:test";
import { buildMaximumApprovalSteps, hasSufficientAllowance, MAX_UINT256, readTokenState } from "../src/infra/erc20.ts";

const registry = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a" as const;
const UINT96_MAX = (1n << 96n) - 1n;

test("零授权不足本次投入时尝试 uint256 最大授权", () => {
  const steps = buildMaximumApprovalSteps(0n, 2n, registry);
  expect(steps).toHaveLength(1);
  expect(steps[0]?.amount).toBe(MAX_UINT256);
  expect(steps[0]?.reason).toBe("尝试设置 ERC20 最大授权");
});

test("现有授权覆盖本次投入时不重复 approve", () => {
  expect(buildMaximumApprovalSteps(100n, 100n, registry)).toEqual([]);
  expect(buildMaximumApprovalSteps(MAX_UINT256, 1n, registry)).toEqual([]);
});

test("UNI 截断后的 uint96 allowance 仍覆盖本次投入", () => {
  const requiredAmount = 157_986_313_486_549_166_218n;
  expect(hasSufficientAllowance(UINT96_MAX, requiredAmount)).toBe(true);
  expect(buildMaximumApprovalSteps(UINT96_MAX, requiredAmount, registry)).toEqual([]);
});

test("任意 token 的非零不足授权统一先清零再尝试最大授权", () => {
  const steps = buildMaximumApprovalSteps(9n, 10n, registry);
  expect(steps).toHaveLength(2);
  expect(steps[0]?.amount).toBe(0n);
  expect(steps[0]?.reason).toBe("当前授权不足且非零，先清零以兼容 ERC20 授权限制");
  expect(steps[1]?.amount).toBe(MAX_UINT256);
});

test("负数 allowance 或所需额度被拒绝", () => {
  expect(() => hasSufficientAllowance(-1n, 0n)).toThrow("不能为负数");
  expect(() => hasSufficientAllowance(0n, -1n)).toThrow("不能为负数");
});

test("token 状态读取按顺序执行并在临时限流后重试", async () => {
  const calls: string[] = [];
  let balanceAttempts = 0;
  const client = {
    async readContract(parameters: unknown): Promise<unknown> {
      const functionName = (parameters as { functionName: string }).functionName;
      calls.push(functionName);
      if (functionName === "decimals") return 18n;
      if (functionName === "balanceOf") {
        balanceAttempts += 1;
        if (balanceAttempts === 1) throw new Error("cu limit exceeded");
        return 42n;
      }
      if (functionName === "allowance") return 84n;
      throw new Error("未预期的读取函数");
    },
  };
  const state = await readTokenState(client, "0x111111111117dc0aa78b770fa6a738034120c302", "0x01162202AC4A4C686FE95B946E4833b8869CF961", registry, 0);
  expect(state).toEqual({ decimals: 18, balance: 42n, allowance: 84n });
  expect(calls).toEqual(["decimals", "balanceOf", "balanceOf", "allowance"]);
});

test("token 状态读取重试后仍失败时终止", async () => {
  const client = { readContract: async (): Promise<unknown> => { throw new Error("cu limit exceeded"); } };
  await expect(readTokenState(client, "0x111111111117dc0aa78b770fa6a738034120c302", "0x01162202AC4A4C686FE95B946E4833b8869CF961", registry, 0)).rejects.toThrow("已重试 2 次");
});
