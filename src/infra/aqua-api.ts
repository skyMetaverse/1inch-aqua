/**
 * 1inch Aqua 网页端 API 适配器。
 * 核心功能：获取认证 token、完整读取 maker active 策略、批量读取 Pair 市场信息，并严格校验外部响应。
 * 主要流程：复用浏览器指纹 transport -> 获取短期 Bearer token -> 请求 API -> 规范化为 Bot 快照。
 */
import { createTransport, fetch, type Transport } from "wreq-js";
import { getOneInchAuthToken } from "./oneinch-auth.ts";
import { isAddress, type Address, type Hex } from "viem";

const BASE_URL = "https://proxy-app.1inch.com/v2.0";
const BROWSER = "chrome_149";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const PAGE_SIZE = 100;
let transportPromise: Promise<Transport> | null = null;

export interface ApiTokenBalance { raw: bigint; usd: number; }
export interface ApiStrategyToken { address: Address; symbol: string; decimals: number; initialBalance: ApiTokenBalance; currentBalance: ApiTokenBalance; }
export interface ApiStrategy { chainId: number; maker: Address; app: Address; strategyHash: Hex; strategyBytes: Hex; openedAt: number; tokens: [ApiStrategyToken, ApiStrategyToken]; classification: { type: string; state: string; feePercent: number }; performance: { volumeUsd: number; feesUsd: number }; }
export interface PairMarket { token0: Address; token1: Address; lastPrice: number; volumeUsd: number; swaps: number; diffPercent1h: number; diffPercent24h: number; diffPercent7d: number; }

function headers(token?: string): Record<string, string> { return { accept: "application/json, text/plain, */*", referer: "https://1inch.com/", "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8", ...(token ? { authorization: `Bearer ${token}` } : {}) }; }
function getTransport(): Promise<Transport> { transportPromise ??= createTransport({ browser: BROWSER, poolMaxIdlePerHost: 8 }); return transportPromise; }
function record(value: unknown, field: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} 必须是对象`); return value as Record<string, unknown>; }
function address(value: unknown, field: string): Address { if (typeof value !== "string" || !isAddress(value)) throw new Error(`${field} 不是有效 EVM 地址`); return value; }
function hex(value: unknown, field: string): Hex { if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error(`${field} 不是非空十六进制字符串`); return value as Hex; }
function hash(value: unknown, field: string): Hex { const result = hex(value, field); if (result.length !== 66) throw new Error(`${field} 必须是 bytes32`); return result; }
function finite(value: unknown, field: string, allowZero = true): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) throw new Error(`${field} 必须是${allowZero ? "非负" : "正"}有限数字`); return value; }
/** Pair 涨跌幅允许正负，且仅用于日志背景，不能套用余额/交易量的非负约束。 */
function signedFinite(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} 必须是有限数字`); return value; }
function integer(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} 必须是非负安全整数`); return value as number; }
function raw(value: unknown, field: string): bigint { if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${field} 必须是非负整数字符串`); return BigInt(value); }
function tokenBalance(value: unknown, field: string): ApiTokenBalance { const item = record(value, field); return { raw: raw(item.raw, `${field}.raw`), usd: finite(item.usd, `${field}.usd`) }; }

/** 将策略接口的原始 JSON 转换为严格快照，字段缺失时拒绝自动交易。 */
export function parseApiStrategy(value: unknown): ApiStrategy {
  const item = record(value, "策略项");
  const tokensRaw = item.tokens;
  if (!Array.isArray(tokensRaw) || tokensRaw.length !== 2) throw new Error("策略 tokens 必须恰好为两个");
  const tokens = tokensRaw.map((value, index) => {
    const token = record(value, `策略 token[${index}]`); const meta = record(token.meta, `策略 token[${index}].meta`);
    const symbol = meta.symbol; if (typeof symbol !== "string" || symbol.trim() === "") throw new Error(`策略 token[${index}].meta.symbol 必须是非空字符串`);
    const decimals = meta.decimals; if (!Number.isSafeInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 255) throw new Error(`策略 token[${index}].meta.decimals 无效`);
    return { address: address(token.address, `策略 token[${index}].address`), symbol: symbol.trim(), decimals: decimals as number, initialBalance: tokenBalance(token.initialBalance, `策略 token[${index}].initialBalance`), currentBalance: tokenBalance(token.currentBalance, `策略 token[${index}].currentBalance`) };
  }) as [ApiStrategyToken, ApiStrategyToken];
  if (tokens[0].address.toLowerCase() === tokens[1].address.toLowerCase()) throw new Error("策略 tokens 不能重复");
  const classification = record(item.classification, "策略 classification"); const performance = record(item.performance, "策略 performance");
  const volume = record(performance.volume, "策略 performance.volume"); const fees = record(performance.fees, "策略 performance.fees"); const totalVolume = record(volume.total, "策略 performance.volume.total"); const totalFees = record(fees.total, "策略 performance.fees.total");
  const type = classification.type; const state = classification.state;
  if (typeof type !== "string" || typeof state !== "string") throw new Error("策略 classification.type/state 必须是字符串");
  return { chainId: integer(item.chainId, "策略 chainId"), maker: address(item.maker, "策略 maker"), app: address(item.app, "策略 app"), strategyHash: hash(item.strategyHash, "策略 strategyHash"), strategyBytes: hex(item.strategyBytes, "策略 strategyBytes"), openedAt: integer(item.openedAt, "策略 openedAt"), tokens, classification: { type, state, feePercent: finite(classification.feePercent, "策略 classification.feePercent") }, performance: { volumeUsd: finite(totalVolume.usd, "策略 performance.volume.total.usd"), feesUsd: finite(totalFees.usd, "策略 performance.fees.total.usd") } };
}

/** 严格解析 Pair API 响应；lastPrice 用于价格交叉校验，volumeUsd 仅作日志观察。 */
export function parsePairMarket(value: unknown): PairMarket {
  const item = record(value, "Pair 市场项");
  return { token0: address(item.token0, "Pair token0"), token1: address(item.token1, "Pair token1"), lastPrice: finite(item.lastPrice, "Pair lastPrice", false), volumeUsd: finite(item.volumeUsd, "Pair volumeUsd"), swaps: integer(item.swaps, "Pair swaps"), diffPercent1h: signedFinite(item.diffPercent1h, "Pair diffPercent1h"), diffPercent24h: signedFinite(item.diffPercent24h, "Pair diffPercent24h"), diffPercent7d: signedFinite(item.diffPercent7d, "Pair diffPercent7d") };
}

/** 获取 maker 全部 open 策略；未知 cursor 语义时拒绝继续，绝不漏监控后自动交易。 */
export async function getActiveStrategies(maker: Address, chainId: number): Promise<ApiStrategy[]> {
  const token = await getOneInchAuthToken(); const query = new URLSearchParams({ status: "open", limit: String(PAGE_SIZE), chainId: String(chainId) });
  const response = await fetch(`${BASE_URL}/aqua/v1.0/strategies/makers/${maker}?${query}`, { transport: await getTransport(), headers: headers(token), method: "GET" });
  if (response.status !== 200) throw new Error(`查询活跃 LP 仓位失败：HTTP ${response.status}`);
  const data = record(await response.json(), "策略响应"); if (!Array.isArray(data.items)) throw new Error("策略响应缺少 items 数组");
  if (data.nextCursor !== null && data.nextCursor !== undefined) throw new Error("策略 API 返回 nextCursor，当前版本未验证分页参数，已停止自动交易");
  if (data.items.length >= PAGE_SIZE) throw new Error(`策略 API 返回达到 limit=${PAGE_SIZE}，无法确认是否遗漏仓位，已停止自动交易`);
  return data.items.map(parseApiStrategy);
}

/** 批量查询 Pair 市场数据；响应必须与请求 pair 一一对应，防止错配市场阈值。 */
export async function getPairMarkets(chainId: number, pairs: Array<[Address, Address]>): Promise<PairMarket[]> {
  if (pairs.length === 0) return [];
  const token = await getOneInchAuthToken(); const response = await fetch(`${BASE_URL}/bff/v1.0/tokens-market/${chainId}/pair`, { transport: await getTransport(), headers: { ...headers(token), "content-type": "application/json" }, method: "POST", body: JSON.stringify({ pairs }) });
  if (response.status !== 200 && response.status !== 201) throw new Error(`查询 Pair 市场失败：HTTP ${response.status}`);
  const data = await response.json(); if (!Array.isArray(data) || data.length !== pairs.length) throw new Error("Pair 市场响应数量与请求不一致");
  const result = data.map(parsePairMarket);
  for (const [index, pair] of pairs.entries()) { const market = result[index]; if (!market || market.token0.toLowerCase() !== pair[0].toLowerCase() || market.token1.toLowerCase() !== pair[1].toLowerCase()) throw new Error(`Pair 市场响应第 ${index + 1} 项与请求地址顺序不一致`); }
  return result;
}
