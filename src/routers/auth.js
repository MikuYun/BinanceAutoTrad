/**
 * 认证相关路由 + 平台元信息。
 * 挂载：POST /api/auth/register | /login | /logout, GET /api/me, GET /api/meta/defaults
 */
import { HttpError, ok, requireAuth } from '../http.js';
import {
  register,
  login,
  userFromToken,
  destroySession,
  attachSession,
  detachSession,
  COOKIE_NAME,
  hasApiKey,
  publicUser,
} from '../auth.js';

/**
 * 尽力加载策略参数 schema；strategy 模块缺失时降级为空 schema，避免整个平台起不来。
 */
async function loadParamMeta() {
  try {
    const mod = await import('../strategy/params.js');
    if (typeof mod.paramsMeta === 'function') {
      const m = mod.paramsMeta();
      return { schema: m.schema || [], defaults: m.defaults || {} };
    }
    return { schema: mod.PARAM_SCHEMA || [], defaults: { ...(mod.DEFAULT_PARAMS || {}) } };
  } catch (e) {
    return { schema: [], defaults: {}, error: String((e && e.message) || e) };
  }
}

/** 尽力加载行情标的列表；行情模块缺失时返回空数组 */
async function loadSymbols() {
  try {
    const mod = await import('../binance/index.js');
    const feed = mod.getMarketFeed();
    const list = feed.symbols();
    return list.map((symbol) => {
      let price = 0;
      let change24hPct = 0;
      let atrPct = 0;
      try {
        const t = feed.ticker(symbol);
        price = t.price;
        change24hPct = t.change24hPct;
        atrPct = typeof feed.atrPct === 'function' ? feed.atrPct(symbol) : 0.02;
      } catch {
        /* 单个标的失败不影响列表 */
      }
      return { symbol, price, change24hPct, atrPct };
    });
  } catch {
    return [];
  }
}

export default function register_(app) {
  app.post('/api/auth/register', async (ctx) => {
    const body = ctx.body || {};
    const user = register(body.username, body.password);
    // 注册成功直接登录，减少一步操作
    const { token, maxAge } = login(body.username, body.password, ctx.req.headers['user-agent']);
    attachSession(ctx, token, maxAge);
    return { user };
  });

  app.post('/api/auth/login', async (ctx) => {
    const body = ctx.body || {};
    const { token, user, maxAge } = login(
      body.username,
      body.password,
      ctx.req.headers['user-agent'],
    );
    attachSession(ctx, token, maxAge);
    return { user };
  });

  app.post('/api/auth/logout', async (ctx) => {
    destroySession(ctx.cookies[COOKIE_NAME]);
    detachSession(ctx);
    return {};
  });

  app.get('/api/me', async (ctx) => {
    const u = requireAuth(ctx);
    return {
      id: u.id,
      username: u.username,
      createdAt: u.createdAt,
      hasApiKey: hasApiKey(u.id),
      mode: 'paper',
    };
  });

  app.get('/api/meta/defaults', async (ctx) => {
    requireAuth(ctx);
    const meta = await loadParamMeta();
    const symbols = await loadSymbols();
    return {
      params: { schema: meta.schema, defaults: meta.defaults },
      modes: [
        { value: 'paper', label: '模拟模式（不联网，本地模拟成交）' },
        { value: 'live', label: '实盘模式（调用币安真实接口）' },
      ],
      symbols: symbols.length ? symbols.map((s) => s.symbol) : ['BTCUSDT', 'ETHUSDT', 'HYPEUSDT'],
      symbolDetail: symbols,
      schemaWarning: meta.error || null,
    };
  });
}

/** 中间件：从 Cookie 解析当前用户注入 ctx.user（供 createServer 注册） */
export function authMiddleware(ctx) {
  const token = ctx.cookies[COOKIE_NAME];
  if (token) {
    ctx.user = userFromToken(token);
  } else {
    ctx.user = null;
  }
}

export { publicUser, HttpError };
