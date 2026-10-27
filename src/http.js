/**
 * 极简 HTTP 框架。
 * 只依赖 node:http —— 路由匹配、body 解析、cookie、静态文件、统一错误信封。
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { STATIC_DIR, BASE_PATH } from './config.js';

const MAX_BODY = 1024 * 1024; // 1MB 请求体上限

/** 带 HTTP 状态码的业务异常 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * 路由表。
 * 每个方法是 (path, handler)。
 * path 支持 ':name' 形式参数。
 */
class Router {
  constructor() {
    /** @type {{method:string,segments:string[],handler:Function}[]} */
    this.routes = [];
    /** @type {Function[]} */
    this.middlewares = [];
  }
  /**
   * @param {string} method
   * @param {string} path
   * @param {Function} handler
   */
  add(method, path, handler) {
    const segments = path.split('/').filter(Boolean);
    this.routes.push({ method, segments, handler });
    return this;
  }
  get(path, handler) {
    return this.add('GET', path, handler);
  }
  post(path, handler) {
    return this.add('POST', path, handler);
  }
  patch(path, handler) {
    return this.add('PATCH', path, handler);
  }
  del(path, handler) {
    return this.add('DELETE', path, handler);
  }
  /** @param {Function} fn */
  use(fn) {
    this.middlewares.push(fn);
    return this;
  }
}

export const app = new Router();
app.Router = Router;

/** 注册子路由表：registerRouter(r => { r.get(...) }) 或传入函数 */
export function mount(registerFn) {
  const sub = new Router();
  registerFn(sub);
  for (const r of sub.routes) app.routes.push(r);
}

/**
 * 匹配路由并返回 {handler, params}
 * @param {string} method
 * @param {string} pathname
 */
function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of app.routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== parts.length) continue;
    const params = {};
    let hit = true;
    for (let i = 0; i < route.segments.length; i += 1) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(parts[i]);
      } else if (seg !== parts[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return { handler: route.handler, params };
  }
  return null;
}

/** 解析 cookie，返回普通对象 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const raw of header.split(';')) {
    const idx = raw.indexOf('=');
    if (idx < 0) continue;
    const k = raw.slice(0, idx).trim();
    const v = raw.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** 读取请求体（有上限），返回原始字符串 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'BODY_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 把原始 body 解析成对象。
 * 支持 application/json 与 form-urlencoded。
 */
function parseBody(raw, contentType) {
  if (!raw) return {};
  const ct = String(contentType || '').toLowerCase();
  try {
    if (ct.includes('application/json')) {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : {};
    }
    if (ct.includes('application/x-www-form-urlencoded')) {
      const out = {};
      for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
      return out;
    }
    // 无 content-type 时按 JSON 尝试，失败则当空对象
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'BAD_BODY', '请求体不是合法 JSON');
  }
}

/** 统一 JSON 响应 */
export function json(ctx, data, status = 200) {
  const payload = JSON.stringify(data);
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  ctx.res.end(payload);
}

/** 成功信封 */
export function ok(ctx, data = {}) {
  return json(ctx, { ok: true, data });
}

/** 失败信封 */
export function fail(ctx, status, code, message) {
  return json(ctx, { ok: false, error: { code, message } }, status);
}

/** 要求已登录，否则抛 401 */
export function requireAuth(ctx) {
  if (!ctx.user) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  return ctx.user;
}

/** 部署前缀下的 Cookie 默认 Path（子路径部署时避免同域站点互相干扰） */

const COOKIE_PATH = BASE_PATH || '/';

/** 当前请求是否走的是 HTTPS（直连 TLS，或反向代理透传的 X-Forwarded-Proto: https） */
export function isSecureRequest(ctx) {
  const sock = ctx && ctx.req && ctx.req.socket;
  if (sock && sock.encrypted) return true;
  const headers = (ctx && ctx.req && ctx.req.headers) || {};
  const proto = String(headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return proto === 'https';
}

/** 设置响应 Cookie */
export function setCookie(ctx, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || COOKIE_PATH}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) parts.push('Secure');
  const prev = ctx.res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(parts.join('; '));
  ctx.res.setHeader('Set-Cookie', list);
}

/** 清除 Cookie（opts 用于携带与设置时一致的 Path/Secure，否则浏览器不认为是同一个 Cookie） */
export function clearCookie(ctx, name, opts = {}) {
  setCookie(ctx, name, '', { ...opts, maxAge: 0 });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 静态文件服务，带回退到 index.html。
 * 必须做路径穿越防护。
 */
function serveStatic(ctx, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(rel).replace(/^([/\\])+/, '');
  const full = join(STATIC_DIR, safe);
  // 防目录穿越
  if (!full.startsWith(STATIC_DIR + sep) && full !== STATIC_DIR) {
    return fail(ctx, 403, 'FORBIDDEN', '禁止访问该路径');
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    // 前端 hash 路由，未知路径回退首页
    const index = join(STATIC_DIR, 'index.html');
    if (!existsSync(index)) {
      return fail(ctx, 503, 'STATIC_MISSING', '前端资源尚未就绪');
    }
    ctx.res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    return createReadStream(index).pipe(ctx.res);
  }
  ctx.res.writeHead(200, {
    'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  return createReadStream(full).pipe(ctx.res);
}

/** 创建 HTTP server（不监听） */
export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    let pathname = url.pathname;

    // 子路径部署：把 BASE_PATH 前缀剥掉，后续路由/静态文件逻辑无需感知前缀。
    // 例：BASE_PATH=/biance_trae，请求 /biance_trae/api/me → pathname=/api/me
    if (BASE_PATH) {
      if (pathname === BASE_PATH) {
        pathname = '/';
      } else if (pathname.startsWith(`${BASE_PATH}/`)) {
        pathname = pathname.slice(BASE_PATH.length);
      }
    }
    const ctx = {
      req,
      res,
      params: {},
      query: Object.fromEntries(url.searchParams.entries()),
      body: {},
      user: null,
      cookies: parseCookies(req.headers.cookie),
    };

    try {
      // 全局中间件（auth 模块用它注入 ctx.user）
      for (const mw of app.middlewares) {
        await mw(ctx);
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      if (pathname.startsWith('/api/')) {
        const route = matchRoute(req.method, pathname);
        if (!route) return fail(ctx, 404, 'NOT_FOUND', `接口不存在: ${req.method} ${pathname}`);
        if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
          const raw = await readBody(req);
          ctx.body = parseBody(raw, req.headers['content-type']);
        }
        ctx.params = route.params;
        const result = await route.handler(ctx);
        // handler 可以返回数据（自动包裹 ok），也可以自己调用 ok/fail
        if (result !== undefined && !res.headersSent) {
          return ok(ctx, result);
        }
        return undefined;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return fail(ctx, 405, 'METHOD_NOT_ALLOWED', '不支持的方法');
      }
      return serveStatic(ctx, pathname);
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* 已发送无法回滚 */
        }
        return undefined;
      }
      if (err instanceof HttpError) {
        return fail(ctx, err.status, err.code, err.message);
      }
      // 未预期异常：记录但绝不泄露内部细节
      console.error('[http] 未处理异常:', err && err.message);
      return fail(ctx, 500, 'INTERNAL_ERROR', '服务器内部错误');
    }
  });
}
