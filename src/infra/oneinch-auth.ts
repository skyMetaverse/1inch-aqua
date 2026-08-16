/**
 * 1inch 网页 API 认证缓存。
 * 核心功能：在进程内复用 auth/token 返回的 JWT，并在 exp 到期前提前刷新，避免每次轮询和每个 API 调用重复建立认证连接。
 * 主要流程：解析 JWT exp -> 缓存有效 token -> 提前刷新时合并并发请求 -> 将 token 交给 Aqua 与 EMSH API 调用方。
 */
import { createTransport, fetch, type Transport } from "wreq-js";

const BASE_URL = "https://proxy-app.1inch.com/v2.0";
const BROWSER = "chrome_149";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const REFRESH_AHEAD_MS = 60_000;
const AUTH_NETWORK_RETRY_COUNT = 2;

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

/** 从 JWT 未签名 payload 中只读取服务端签发的 exp；签名验证由服务端完成，本地仅用于决定何时刷新缓存。 */
export function parseJwtExpiryMs(token: string): number {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) throw new Error("1inch API access_token 不是可解析的 JWT");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new Error("1inch API access_token JWT payload 无法解析");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("1inch API access_token JWT payload 无效");
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= 0) throw new Error("1inch API access_token JWT 缺少有效 exp");
  return exp * 1000;
}

/**
 * 可注入刷新函数的 token 缓存，供单元测试精确验证到期边界与并发合并。
 * 刷新失败不覆盖现有 token；若旧 token 尚未进入提前刷新窗口，调用方仍会继续使用它。
 */
export class ExpiringBearerTokenCache {
  private cached: CachedToken | undefined;
  private refreshPromise: Promise<string> | undefined;

  constructor(
    private readonly refresh: () => Promise<string>,
    private readonly now: () => number = Date.now,
    private readonly refreshAheadMs = REFRESH_AHEAD_MS,
  ) {}

  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.now() > this.refreshAheadMs) return this.cached.value;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refresh().then((value) => {
      const expiresAtMs = parseJwtExpiryMs(value);
      if (expiresAtMs - this.now() <= this.refreshAheadMs) throw new Error("1inch API access_token 已过期或即将过期");
      this.cached = { value, expiresAtMs };
      return value;
    }).finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  /** 401/403 表示服务端不接受当前 token；立即移除而不是等待本地 exp，下一次 get 会单次刷新。 */
  invalidate(): void {
    this.cached = undefined;
  }
}

let transportPromise: Promise<Transport> | null = null;
export function getOneInchTransport(): Promise<Transport> {
  transportPromise ??= createTransport({ browser: BROWSER, poolMaxIdlePerHost: 8 });
  return transportPromise;
}

/** 获取新 token 时不携带 Bearer 头，避免缓存过期 token 影响认证端点。 */
async function requestAuthToken(): Promise<string> {
  let lastNetworkError: unknown;
  for (let attempt = 0; attempt <= AUTH_NETWORK_RETRY_COUNT; attempt += 1) {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(`${BASE_URL}/auth/token`, {
        transport: await getOneInchTransport(),
        headers: {
          accept: "application/json, text/plain, */*",
          referer: "https://1inch.com/",
          "user-agent": USER_AGENT,
          "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8",
        },
        method: "GET",
      });
    } catch (error) {
      lastNetworkError = error;
      if (attempt === AUTH_NETWORK_RETRY_COUNT) break;
      await new Promise<void>((resolve) => setTimeout(resolve, (attempt + 1) * 500));
      continue;
    }
    if (response.status !== 200) throw new Error(`获取 1inch API 认证 token 失败：HTTP ${response.status}`);
    const body = await response.json() as { access_token?: unknown };
    if (typeof body.access_token !== "string" || body.access_token === "") throw new Error("1inch API 认证响应缺少 access_token");
    return body.access_token;
  }
  const reason = lastNetworkError instanceof Error ? lastNetworkError.message.split("\n")[0]?.trim() : "未知错误";
  throw new Error(`获取 1inch API 认证 token 网络失败，已重试 ${AUTH_NETWORK_RETRY_COUNT} 次：${reason || "未知错误"}`);
}

const sharedTokenCache = new ExpiringBearerTokenCache(requestAuthToken);

/** Aqua 策略、Pair 与 EMSH current 共用同一进程内 Bearer token。 */
export function getOneInchAuthToken(): Promise<string> {
  return sharedTokenCache.get();
}

/**
 * 在同一共享 transport 上执行带认证请求。仅当服务端明确 401/403 时失效 JWT 并重试一次，避免将业务错误或限流错误误作认证刷新。
 */
export async function requestWithOneInchAuth<T extends { status: number }>(request: (token: string) => Promise<T>): Promise<T> {
  let response = await request(await sharedTokenCache.get());
  if (response.status !== 401 && response.status !== 403) return response;
  sharedTokenCache.invalidate();
  response = await request(await sharedTokenCache.get());
  return response;
}
