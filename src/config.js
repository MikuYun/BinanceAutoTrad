/**
 * 全局配置。
 * 所有可调项集中在这里，避免散落在业务代码中。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = join(ROOT, 'data');
export const STATIC_DIR = join(ROOT, 'src', 'static');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

/**
 * 主加密密钥。
 * 优先读环境变量 BT_MASTER_KEY（64 位 hex）。
 * 否则读 data/master.key；不存在则生成一次并落盘（文件权限 0600）。
 * 这样 API Key 在数据库里始终是密文，且密钥不在代码里。
 */
function loadMasterKey() {
  const fromEnv = process.env.BT_MASTER_KEY;
  if (fromEnv && /^[0-9a-fA-F]{64}$/.test(fromEnv)) {
    return Buffer.from(fromEnv, 'hex');
  }
  const keyFile = join(DATA_DIR, 'master.key');
  if (existsSync(keyFile)) {
    const hex = readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  }
  const buf = randomBytes(32);
  writeFileSync(keyFile, buf.toString('hex'), { mode: 0o600 });
  return buf;
}

export const MASTER_KEY = loadMasterKey();

export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || '127.0.0.1';

/**
 * 部署前缀（子路径）。
 * 例如把本站挂在 https://example.com/biance_trae/ 下时设置 BASE_PATH=/biance_trae：
 *   - nginx 用 `location ^~ /biance_trae/ { proxy_pass http://127.0.0.1:8797; }`
 *     （proxy_pass 不带 URI 部分，保留前缀原样转发给后端）
 *   - 后端自动把这个前缀从请求路径上剥掉（/biance_trae/api/x → /api/x），
 *     并让登录 Cookie 的 Path 带上前缀，避免与同域其他站点互相干扰。
 * 留空表示部署在域名根路径。
 */
export const BASE_PATH = (() => {
  const raw = String(process.env.BASE_PATH || '').trim();
  if (!raw) return '';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '');
})();

export const BINANCE = {
  // U 本位合约 REST 根地址
  baseUrl: process.env.BINANCE_BASE_URL || 'https://fapi.binance.com',
  // 网络超时：本机可能屏蔽了币安域名，8 秒必须放弃
  timeoutMs: Number(process.env.BINANCE_TIMEOUT_MS || 8000),
  /**
   * 签名请求的有效期窗口（毫秒）。
   * 原来硬编码 5000，经代理链路（服务器上挂着 mihomo）时单次往返可能超过 5 秒，
   * 于是币安直接报 -1021「Timestamp for this request is outside of the recvWindow」。
   * 现在可通过环境变量 BINANCE_RECV_WINDOW 调到 60000，并且每次 -1021 都会
   * 强制重新校准服务器时间戳（见 src/binance/rest.js）。
   */
  recvWindow: clampInt(process.env.BINANCE_RECV_WINDOW, 5000, 1000, 60000),
  /**
   * 与币安服务器时间对齐的刷新周期（毫秒）。
   * 本地时钟与币安服务器偏差超过 recvWindow 就会出现 -1021 / -1022，
   * 因此后台每隔这么久重新校准一次，而不是等报错才校准。
   */
  timeSyncIntervalMs: clampInt(process.env.BINANCE_TIME_SYNC_MS, 60000, 10000, 600000),
};

/** 读取一个整数环境变量并夹到 [min,max] 区间 */
function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export const SESSION_TTL_SEC = 7 * 24 * 3600;

/**
 * 实盘下单总开关（安全闸）。
 * 默认关闭：即使已经验证过 API Key，也不会向真实账户发送任何下单/撤单请求。
 * 必须在启动前显式设置环境变量 LIVE_TRADING=1 才会放开。
 * 这样「误点启动」「看错模式」都不会造成真实资金变动。
 */
export const TRADING = {
  liveEnabled: process.env.LIVE_TRADING === '1',
};

export const PAPER = {
  // 模拟盘单边手续费率（币安 U 本位吃单约 0.04%，这里取保守值）
  feeRate: 0.0005,
  // 模拟成交滑点
  slippagePct: 0.0002,
  // 模拟行情推进 / 机器人 tick 间隔
  tickIntervalMs: Number(process.env.TICK_INTERVAL_MS || 5000),
};

// 默认报价币，用于展示
export const QUOTE = 'USDT';
