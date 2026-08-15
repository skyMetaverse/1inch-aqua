/**
 * 1inch JWT 认证缓存回归测试。
 * 核心功能：保证一个进程内复用有效 token，在到期前提前刷新且并发调用不会重复请求认证端点。
 * 主要流程：构造带 exp 的无签名测试 JWT -> 推进可控时钟 -> 断言缓存、刷新与错误边界。
 */
import { expect, test } from "bun:test";
import { ExpiringBearerTokenCache, parseJwtExpiryMs } from "../src/infra/oneinch-auth.ts";

/** 仅构造 payload 用于本地缓存测试；token 不会发送到网络，签名字段不参与本地 exp 解析。 */
function testJwt(exp: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}

test("有效 JWT 在提前刷新窗口外复用，进入窗口才刷新", async () => {
  let now = 1_700_000_000_000;
  let requestCount = 0;
  const cache = new ExpiringBearerTokenCache(async () => testJwt(Math.floor((now + 3_600_000) / 1000) + ++requestCount), () => now, 60_000);
  const first = await cache.get();
  expect(await cache.get()).toBe(first);
  expect(requestCount).toBe(1);
  now += 3_541_000;
  const refreshed = await cache.get();
  expect(refreshed).not.toBe(first);
  expect(requestCount).toBe(2);
});

test("并发获取即将过期 token 时合并为一次认证请求", async () => {
  let requestCount = 0;
  const now = 1_700_000_000_000;
  const cache = new ExpiringBearerTokenCache(async () => {
    requestCount += 1;
    await Promise.resolve();
    return testJwt(Math.floor((now + 3_600_000) / 1000));
  }, () => now, 60_000);
  const tokens = await Promise.all([cache.get(), cache.get(), cache.get()]);
  expect(new Set(tokens).size).toBe(1);
  expect(requestCount).toBe(1);
});

test("缺少 exp 的认证 token 被拒绝，避免以猜测时长缓存", () => {
  expect(() => parseJwtExpiryMs("header.eyJzdWIiOiJ0ZXN0In0.signature")).toThrow("缺少有效 exp");
});
