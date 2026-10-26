/**
 * 币安 U 本位合约 REST 客户端。
 *
 * 关键约束：
 *   1. 每次请求都有硬超时（AbortController），绝不无限等待；
 *   2. 网络错误统一包装成 BinanceError，带上「网络不可达」的可读中文提示；
 *   3. 只对**幂等**请求做有限次网络重试（GET 查询 / DELETE 撤单）。
 *      下单（POST /fapi/v1/order）**绝不自动重试** —— 超时并不代表没成交，
 *      重复提交会造成真实资金上的重复开仓。防重复由 clientOrderId 幂等 + 下单前查重解决。
 *   4. 签名时间戳始终以币安服务器为准：定时后台校准 + 遇到 -1021 强制重校准重试。
 */
import { hmacSha256Hex } from '../crypto.js';
import { BINANCE } from '../config.js';

export class BinanceError extends Error {
  /**
   * @param {string} message
   * @param {object} [extra]
   */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'BinanceError';
    this.code = extra.code || 'BINANCE_ERROR';
    this.status = extra.status || 0;
    this.network = Boolean(extra.network);
    this.binanceCode = extra.binanceCode;
  }
}

/** 是否是「网络不可达」类错误（用于前端展示降级提示） */
export function isNetworkError(err) {
  return Boolean(err && (err.network || err.name === 'AbortError'));
}

/* ------------------------------------------------------------------ *
 * 服务器时间校准
 *
 * 币安签名接口要求 timestamp 与服务器时间差在 recvWindow 内。
 * 本机时钟与币安服务器存在数百毫秒到数秒的偏差，且首次请求
 * 经过代理时延很高（实测 3 秒），直接用 Date.now() 会稳定报
 * -1021 Timestamp outside of the recvWindow。
 * 因此这里维护一个全局偏移量：offset = serverTime - 本地时间。
 *
 * 2026-10-26：本地时钟漂移 + 代理链路抖动会同时出现「账户页能读、
 * 机器人后台报 -1021」的诡异现象（账户页刚好在窗口内、机器人刚好在
 * 窗口外）。所以改成三层保护：
 *   ① 每个请求签名前都检查偏移是否过期（默认 60 秒）；
 *   ② 后台定时器常驻校准；
 *   ③ 任何签名请求遇到 -1021/-1022 都强制重新校准后重试一次。
 * ------------------------------------------------------------------ */
let timeOffsetMs = 0;
let timeOffsetAt = 0;
/** 时间偏移多久算过期（毫秒），由 config 决定 */


/** 同步服务器时间（取一次 /fapi/v1/time，用往返中点估算偏移） */
export async function syncTime() {
  const t0 = Date.now();
  const data = await request({ path: '/fapi/v1/time', timeoutMs: Math.max(BINANCE.timeoutMs, 10000) });
  const t1 = Date.now();
  const serverTime = Number(data && data.serverTime);
  if (!Number.isFinite(serverTime) || serverTime <= 0) throw new BinanceError('币安未返回服务器时间', { code: 'BAD_TIME' });
  const rtt = t1 - t0;
  timeOffsetMs = serverTime - Math.round((t0 + t1) / 2);
  timeOffsetAt = Date.now();
  return { offsetMs: timeOffsetMs, rttMs: rtt, recvWindow: BINANCE.recvWindow };
}

/** 当前可用于签名的币安时间戳 */
export function binanceTimestamp(forceSync = false) {
  if (!forceSync && Date.now() - timeOffsetAt > BINANCE.timeSyncIntervalMs) return null;
  return Date.now() + timeOffsetMs;
}

/** 当前时间偏移信息（供 /api/market/health 之类诊断用） */
export function timeDrift() {
  return {
    offsetMs: Math.round(timeOffsetMs),
    syncedAt: timeOffsetAt,
    ageMs: timeOffsetAt ? Date.now() - timeOffsetAt : null,
    recvWindow: BINANCE.recvWindow,
  };
}

/** 保证偏移量是最新的 */
async function ensureTimeSync(force = false) {
  if (!force && timeOffsetAt && Date.now() - timeOffsetAt <= BINANCE.timeSyncIntervalMs) return;
  try {
    await syncTime();
  } catch {
    // 同步失败就沿用旧偏移（首次失败则用本地时间），后续 -1021 会再重试
    if (!timeOffsetAt) timeOffsetAt = Date.now();
  }
}

let timeSyncTimer = null;

/** 启动后台定时校准（幂等，进程退出时定时器不会阻止退出） */
export function startTimeSync() {
  if (timeSyncTimer) return;
  const run = () => {
    ensureTimeSync(true).catch(() => {});
  };
  run();
  timeSyncTimer = setInterval(run, BINANCE.timeSyncIntervalMs);
  timeSyncTimer.unref?.();
}

/** 停止后台定时校准 */
export function stopTimeSync() {
  if (timeSyncTimer) {
    clearInterval(timeSyncTimer);
    timeSyncTimer = null;
  }
}

/**
 * 单次请求（不含重试）。
 * @param {object} opts
 * @param {string} opts.path        例如 '/fapi/v1/ticker/24hr'
 * @param {'GET'|'POST'|'DELETE'|'PUT'} [opts.method]
 * @param {object} [opts.query]     查询参数
 * @param {object} [opts.form]      POST 表单
 * @param {object} [opts.credentials] { apiKey, apiSecret } 需要签名的接口
 * @param {boolean} [opts.signed]
 * @param {number} [opts.timeoutMs]
 */
async function requestOnce(opts) {
  const {
    path,
    method = 'GET',
    query = {},
    form = null,
    credentials = null,
    signed = false,
    timeoutMs = BINANCE.timeoutMs,
  } = opts;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }

  const headers = { Accept: 'application/json' };
  let body;

  // POST/PUT 的表单字段必须在**签名之前**并入 params，否则币安会用完整 body
  // 重新计算签名，与服务端签的那份对不上，直接报 -1022 Signature for this request is not valid。
  const isBodyMethod = method !== 'GET' && method !== 'DELETE';
  if (isBodyMethod && form) {
    for (const [k, v] of Object.entries(form)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
  }

  if (signed) {
    if (!credentials || !credentials.apiKey || !credentials.apiSecret) {
      throw new BinanceError('未配置有效的 API Key / Secret', { code: 'NO_CREDENTIALS' });
    }
    // 每次签名前确认时间偏移是新鲜的（默认 60 秒内），避免 -1021
    await ensureTimeSync();
    params.set('timestamp', String(Date.now() + timeOffsetMs));
    params.set('recvWindow', String(BINANCE.recvWindow));
    const payload = params.toString();
    const signature = hmacSha256Hex(credentials.apiSecret, payload);
    // signature 必须是最后一个字段，且不参与签名
    params.set('signature', signature);
    headers['X-MBX-APIKEY'] = credentials.apiKey;
  } else if (credentials && credentials.apiKey) {
    headers['X-MBX-APIKEY'] = credentials.apiKey;
  }

  let url = `${BINANCE.baseUrl}${path}`;
  const payloadString = params.toString();

  if (!isBodyMethod) {
    if (payloadString) url += `?${payloadString}`;
  } else {
    body = payloadString;
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    throw new BinanceError(
      aborted
        ? `连接币安超时（${timeoutMs}ms）。本机可能无法访问 fapi.binance.com，请检查网络或代理。`
        : `无法连接币安：${(err && err.message) || err}`,
      { code: aborted ? 'BINANCE_TIMEOUT' : 'BINANCE_UNREACHABLE', network: true },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new BinanceError(`币安返回了非 JSON 内容（HTTP ${res.status}）`, {
      status: res.status,
      code: 'BAD_RESPONSE',
    });
  }

  if (!res.ok) {
    const msg = (data && data.msg) || `HTTP ${res.status}`;
    const code = (data && data.code) || 0;
    throw new BinanceError(`币安接口错误：${msg}`, {
      status: res.status,
      binanceCode: code,
      code: code === -2015 ? 'BAD_API_KEY' : 'BINANCE_REJECTED',
    });
  }

  return data;
}

/* ------------------------------------------------------------------ *
 * 网络重试：只对幂等请求做，绝不重试下单
 * ------------------------------------------------------------------ */
const RETRY_MAX = 3;
const RETRY_BASE_MS = 400;

/** 只对这些「本身幂等、重发无副作用」的请求做网络重试 */
function isRetryable(opts) {
  const method = (opts.method || 'GET').toUpperCase();
  if (method === 'GET') return true;
  // DELETE /fapi/v1/order 撤单是幂等的：重复撤单只会报「订单不存在」，不会造成资金损失。
  if (method === 'DELETE' && String(opts.path || '').includes('/order')) return true;
  return false;
}

/**
 * 带网络重试的请求入口。
 * 专治代理链路 2~3% 的随机握手失败（context deadline exceeded / fetch failed）。
 * 重试上限 3 次、退避 400/800/1600ms，最多多花约 3 秒。
 * 下单（POST）永不自动重试：超时不等于没成交，重复提交会真实重复开仓。
 */
export async function request(opts) {
  const retryable = isRetryable(opts) && opts.retry !== false;
  const max = retryable ? RETRY_MAX : 1;
  let lastErr;
  for (let attempt = 1; attempt <= max; attempt += 1) {
    try {
      return await requestOnce(opts);
    } catch (err) {
      lastErr = err;
      const isNet = err && err.network;
      if (!isNet || attempt === max) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

/** 无需签名的公开接口 */
export function publicGet(path, query, timeoutMs) {
  return request({ path, query, timeoutMs });
}

/**
 * 签名请求的时间戳漂移重试。
 * -1021（时间戳不在 recvWindow 内）与 -1022（签名校验失败）都可能由
 * 本地时钟漂移引起：只要本地时间戳偏移一变，签名本身也会变。
 * 这里强制重新校准币安服务器时间后重试一次。
 */
async function signedRequestWithRetry(makeOpts) {
  try {
    return await request(makeOpts());
  } catch (err) {
    const code = err && err.binanceCode;
    if (code === -1021 || code === -1022) {
      await ensureTimeSync(true);
      return request(makeOpts());
    }
    throw err;
  }
}

/** 需要签名的私有接口 */
export function signedGet(path, query, credentials, timeoutMs) {
  return signedRequestWithRetry(() => ({ path, query, credentials, signed: true, timeoutMs }));
}

/** 需要签名的 POST */
export function signedPost(path, form, credentials, timeoutMs) {
  return signedRequestWithRetry(() => ({ path, method: 'POST', form, credentials, signed: true, timeoutMs }));
}

/** 需要签名的 DELETE */
export function signedDelete(path, form, credentials, timeoutMs) {
  return signedRequestWithRetry(() => ({ path, method: 'DELETE', form, credentials, signed: true, timeoutMs }));
}

/* ------------------------------------------------------------------ *
 * 具体接口封装
 * ------------------------------------------------------------------ */

/** 服务器时间（用于确认网络可达） */
export function ping() {
  return publicGet('/fapi/v1/ping', {});
}

/**
 * 交易规则。
 *
 * exchangeInfo 是币安最大的公开响应（约 1.1MB、1000+ 合约），走代理时经常比普通
 * 接口慢好几倍。用默认 8s/20s 阈值容易判成超时，一超时就退回兜底规则 → 精度不对
 * → -1111。所以这里单独给一个更长的超时。
 */
export function exchangeInfo(timeoutMs) {
  return publicGet('/fapi/v1/exchangeInfo', {}, timeoutMs || Math.max(BINANCE.timeoutMs || 8000, 30000));
}

/** 24h ticker */
export function ticker24h(symbol) {
  return publicGet('/fapi/v1/ticker/24hr', symbol ? { symbol } : {});
}

/**
 * 全市场最新价（一次请求拿回所有永续合约的最新成交价）。
 * 返回 [{ symbol, price, time }]，约 100KB。
 */
export function tickerAllPrice() {
  return publicGet('/fapi/v1/ticker/price', {});
}

/** 全市场 24h 行情（含涨跌幅与成交额），约 500KB，响应慢，给更长超时 */
export function tickerAll24h(timeoutMs = 20000) {
  return publicGet('/fapi/v1/ticker/24hr', {}, timeoutMs);
}

/** 最新标记价 */
export function markPrice(symbol) {
  return publicGet('/fapi/v1/premiumIndex', symbol ? { symbol } : {});
}

/** K 线 */
export function klines(symbol, interval = '1h', limit = 200) {
  return publicGet('/fapi/v1/klines', { symbol, interval, limit });
}

/** 账户信息（需要签名） */
export function accountInfo(credentials) {
  return signedGet('/fapi/v2/account', {}, credentials);
}

/** 持仓风险（需要签名） */
export function positionRisk(credentials, symbol) {
  return signedGet('/fapi/v2/positionRisk', symbol ? { symbol } : {}, credentials);
}

/** 当前挂单（需要签名） */
export function openOrders(credentials, symbol) {
  return signedGet('/fapi/v1/openOrders', symbol ? { symbol } : {}, credentials);
}

/** 下单（需要签名） */
export function newOrder(credentials, order) {
  return signedPost('/fapi/v1/order', order, credentials);
}

/**
 * 撤单（需要签名）。
 * 可以按 exchange orderId 撤，也可以按 origClientOrderId 撤（二者传一个）。
 */
export function cancelOrder(credentials, symbol, orderIdOrClientId, byClientId = false) {
  const form = byClientId
    ? { symbol, origClientOrderId: orderIdOrClientId }
    : { symbol, orderId: orderIdOrClientId };
  return signedDelete('/fapi/v1/order', form, credentials);
}

/** 设置杠杆（需要签名） */
export function setLeverage(credentials, symbol, leverage) {
  return signedPost('/fapi/v1/leverage', { symbol, leverage }, credentials);
}

/** 币安服务器时间（毫秒） */
export async function serverTime() {
  const d = await publicGet('/fapi/v1/time', {});
  return Number(d && d.serverTime) || 0;
}

/**
 * 查询单个订单（需要签名）。
 * 用 clientOrderId（origClientOrderId）查最方便：我们自己生成的订单号是确定性的，
 * 网络超时后可以用它回查「这笔到底成交没有」，从而避免重复下单。
 */
export function queryOrder(credentials, symbol, clientOrderId) {
  return signedGet('/fapi/v1/order', { symbol, origClientOrderId: clientOrderId }, credentials);
}

/** 撤销某个交易对的全部挂单（需要签名） */
export function cancelAllOpenOrders(credentials, symbol) {
  return signedDelete('/fapi/v1/allOpenOrders', { symbol }, credentials);
}

/**
 * 资金流水（需要签名）。用于统计真实已实现盈亏。
 * @param {object} credentials
 * @param {{symbol?:string, incomeType?:string, startTime?:number, limit?:number}} [opts]
 */
export function income(credentials, opts = {}) {
  const query = {};
  if (opts.symbol) query.symbol = opts.symbol;
  if (opts.incomeType) query.incomeType = opts.incomeType;
  if (opts.startTime) query.startTime = opts.startTime;
  query.limit = opts.limit || 100;
  return signedGet('/fapi/v1/income', query, credentials);
}
