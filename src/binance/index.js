/**
 * 币安适配层出口。
 *
 * - getMarketFeed(): 行情源。默认使用「币安实时行情」（liveMarket），
 *   币安不可达时 liveMarket 内部自动降级为模拟价，不会白屏。
 *   如需强制纯模拟，设 BINANCE_FEED=mock。
 * - getExchange(mode): 'paper' → 本地撮合；'live' → 真实下单。
 * - loadCredentials(userId): 从库里解密该用户的 API Key（只在服务端用）。
 */
import { mockMarket } from './mockMarket.js';
import { liveMarket, start as startLiveMarket } from './liveMarket.js';
import { paperExchange } from './paper.js';
import { liveExchange } from './live.js';
import { get, all } from '../db.js';
import { decrypt } from '../crypto.js';

let feed = null;

/** 行情源单例 */
export function getMarketFeed() {
  if (feed) return feed;
  feed = process.env.BINANCE_FEED === 'mock' ? mockMarket : liveMarket;
  return feed;
}

/** 启动行情后台刷新（server 启动后调用一次） */
export function startMarket() {
  const f = getMarketFeed();
  if (f && typeof f.start === 'function') f.start();
  return f;
}

/** 交易所适配器 */
export function getExchange(mode) {
  return mode === 'live' ? liveExchange : paperExchange;
}

/**
 * 解密某个用户的 API Key（取最新一条已验证的）。
 * @param {string} userId
 * @returns {{apiKey:string, apiSecret:string, id:string}|null}
 */
export function loadCredentials(userId) {
  const row = get(
    `SELECT * FROM api_keys WHERE user_id = ? AND status != 'incomplete'
     ORDER BY (status = 'verified') DESC, created_at DESC LIMIT 1`,
    userId,
  );
  if (!row) return null;
  try {
    const apiKey = decrypt(row.key_enc);
    const apiSecret = decrypt(row.secret_enc);
    // 没有 Secret 就无法签名，当作未配置处理，避免后续请求全部报签名错
    if (!apiKey || !apiSecret) return null;
    return { id: row.id, apiKey, apiSecret };
  } catch {
    return null;
  }
}

/** 列出用户的 key 记录（不含明文） */
export function listKeyRows(userId) {
  return all('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', userId);
}

/** 周期性推进模拟行情（仅 mock 源需要；server 定时器调用） */
export function tickMarket() {
  if (feed && typeof feed.tickAll === 'function') feed.tickAll();
}

export { mockMarket, liveMarket, paperExchange, liveExchange, startLiveMarket };
