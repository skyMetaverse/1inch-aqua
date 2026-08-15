/**
 * EMSH current 价格接口适配器。
 * 核心功能：按 1inch Aqua 页面请求方式获取 current，并从原始 JSON 文本提取 price 数字字面量，避免 JSON Number 提前损失精度。
 * 主要流程：获取 Bearer token -> 使用 wreq-js 请求 current -> 校验响应 -> 返回精确价格文本、接口时间戳和请求耗时。
 */
import { createTransport, fetch, type Transport } from "wreq-js";
import { getOneInchAuthToken } from "./oneinch-auth.ts";

const BASE_URL = "https://proxy-app.1inch.com/v2.0";
const BROWSER = "chrome_149";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

export interface CurrentPrice {
  priceText: string;
  timestamp: number;
  elapsedMs: number;
  rawResponse: string;
}

let transportPromise: Promise<Transport> | null = null;

function getTransport(): Promise<Transport> {
  transportPromise ??= createTransport({ browser: BROWSER, poolMaxIdlePerHost: 8 });
  return transportPromise;
}

function headers(token?: string): Record<string, string> {
  const result: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    referer: "https://1inch.com/",
    "user-agent": USER_AGENT,
    "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8",
  };
  if (token) result.authorization = `Bearer ${token}`;
  return result;
}

/**
 * 从 current 原始 JSON 文本提取价格字面量和时间戳。
 * 不使用 JSON.parse，确保服务端写出的长小数不会被客户端先变成 JavaScript Number。
 */
export function extractCurrentPrice(rawResponse: string): { priceText: string; timestamp: number } {
  const priceMatch = rawResponse.match(/"price"\s*:\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  const timestampMatch = rawResponse.match(/"timestamp"\s*:\s*(\d+)/);
  if (!priceMatch?.[1] || !timestampMatch?.[1]) throw new Error("EMSH current 响应缺少 price 或 timestamp");
  if (/[eE]/.test(priceMatch[1])) throw new Error("EMSH current 返回科学计数法价格，无法在无损模式下使用");
  const timestamp = Number(timestampMatch[1]);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("EMSH current 返回的 timestamp 无效");
  return { priceText: priceMatch[1], timestamp };
}

/**
 * 获取 pair current 价格。price 从原文数字 token 解析，不经 JSON.parse 转为 Number。
 * API 现状使用 JSON number；本模块保留数字字面量并记录原始响应，便于事后审计服务端精度。
 */
export async function getCurrentPrice(token0: string, token1: string, chainId: number): Promise<CurrentPrice> {
  const start = Date.now();
  const token = await getOneInchAuthToken();
  const response = await fetch(
    `${BASE_URL}/charts/v1.0/chart/tradingview/${token0}/${token1}/86400/${chainId}/current`,
    { transport: await getTransport(), headers: headers(token), method: "GET" },
  );
  const rawResponse = await response.text();
  if (response.status !== 200) throw new Error(`EMSH current 接口失败：HTTP ${response.status}`);
  const extracted = extractCurrentPrice(rawResponse);
  return { ...extracted, elapsedMs: Date.now() - start, rawResponse };
}
