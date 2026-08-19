/**
 * LP 配置创建编排回归测试。
 * 核心功能：验证 Bot 补足多个缺失配置槽位时使用一个 Aqua multicall ship。
 * 主要流程：注入两个已模拟 ship -> 断言均以批量模式准备 -> 断言只提交一次批量广播 -> 校验每个槽位返回其 strategyHash。
 */
import { expect, test } from "bun:test";
import { prepareConfiguredPositionShips, type PreparedShip } from "../src/app/add-lp.ts";
import type { PositionConfig } from "../src/config/lp-config.ts";

const positions = [{ id: "upper", pair: { tokens: [] }, fee: "0.001%", range: { mode: "upper", upperPercent: "1%" } }, { id: "lower", pair: { tokens: [] }, fee: "0.001%", range: { mode: "lower", lowerPercent: "1%" } }] as unknown as PositionConfig[];

/** 两个缺失槽位必须在准备完成后只发送一次 atomic multicall，不能退化为两笔单独 ship。 */
test("补足两个配置槽位时准备两个 ship 并只广播一次 multicall", async () => {
  const preparedBatchFlags: boolean[] = [];
  const broadcasts: PreparedShip[][] = [];
  const result = await prepareConfiguredPositionShips({
    positions,
    prepare: async (_position, index, batchShip) => {
      preparedBatchFlags.push(batchShip);
      return { index, built: { strategyHash: `0x${String(index + 1).repeat(64)}` } } as unknown as PreparedShip;
    },
    broadcast: async (ships) => { broadcasts.push([...ships]); },
  });

  expect(preparedBatchFlags).toEqual([true, true]);
  expect(broadcasts).toHaveLength(1);
  expect(broadcasts[0]?.map((ship) => ship.index)).toEqual([0, 1]);
  expect(result).toEqual([
    { positionId: "upper", strategyHash: `0x${"1".repeat(64)}` },
    { positionId: "lower", strategyHash: `0x${"2".repeat(64)}` },
  ]);
});
