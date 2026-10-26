/**
 * 会话与账号。
 * - session token 存 sessions 表，Cookie 名 bt_sid
 * - 登录失败做了简单的内存限流（同用户名 5 次/分钟）
 */
import { all, get, run, purgeExpiredSessions } from './db.js';
import { hashPassword, verifyPassword, randomId } from './crypto.js';
import { SESSION_TTL_SEC } from './config.js';
import { HttpError, setCookie, clearCookie } from './http.js';

export const COOKIE_NAME = 'bt_sid';

// 登录失败计数：key = username，value = { count, resetAt }
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;

/** 简易限流检查 */
function checkRate(username) {
  const now = Date.now();
  const rec = loginAttempts.get(username);
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(username, { count: 0, resetAt: now + WINDOW_MS });
    return;
  }
  if (rec.count >= MAX_ATTEMPTS) {
    const wait = Math.ceil((rec.resetAt - now) / 1000);
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS', `尝试次数过多，请 ${wait} 秒后重试`);
  }
}

/** 记录一次失败 */
function recordFailure(username) {
  const now = Date.now();
  const rec = loginAttempts.get(username);
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(username, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  rec.count += 1;
}

/** 成功则清空计数 */
function clearFailures(username) {
  loginAttempts.delete(username);
}

/**
 * 用户名校验：3-32 位，字母数字下划线
 * @param {string} v
 */
export function assertUsername(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(v)) {
    throw new HttpError(400, 'BAD_USERNAME', '用户名需为 3-32 位字母、数字或下划线');
  }
  return v;
}

/**
 * 密码校验：至少 6 位
 * @param {string} v
 */
export function assertPassword(v) {
  if (typeof v !== 'string' || v.length < 6 || v.length > 128) {
    throw new HttpError(400, 'BAD_PASSWORD', '密码长度需为 6-128 位');
  }
  return v;
}

/** 对外暴露的用户对象（不含密码哈希） */
function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

/**
 * 注册。用户名重复抛 409。
 * @param {string} username
 * @param {string} password
 */
export function register(username, password) {
  const name = assertUsername(username);
  assertPassword(password);
  const exists = get('SELECT id FROM users WHERE username = ?', name);
  if (exists) throw new HttpError(409, 'USERNAME_TAKEN', '该用户名已被注册');
  const id = randomId('u');
  run(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    id,
    name,
    hashPassword(password),
    Date.now(),
  );
  return publicUser(get('SELECT * FROM users WHERE id = ?', id));
}

/**
 * 登录，返回 { token, user, maxAge }
 * @param {string} username
 * @param {string} password
 * @param {string} [ua]
 */
export function login(username, password, ua = '') {
  const name = assertUsername(username);
  checkRate(name);
  const row = get('SELECT * FROM users WHERE username = ?', name);
  if (!row || !verifyPassword(String(password || ''), row.password_hash)) {
    recordFailure(name);
    throw new HttpError(401, 'BAD_CREDENTIALS', '用户名或密码错误');
  }
  clearFailures(name);
  const token = randomId('s');
  const now = Date.now();
  run(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?, ?, ?, ?, ?)',
    token,
    row.id,
    now,
    now + SESSION_TTL_SEC * 1000,
    String(ua || '').slice(0, 200),
  );
  return { token, user: publicUser(row), maxAge: SESSION_TTL_SEC };
}

/**
 * 通过 token 找用户；过期返回 null。
 * @param {string} token
 */
export function userFromToken(token) {
  if (!token) return null;
  const row = get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
    token,
    Date.now(),
  );
  return publicUser(row);
}

/**
 * 销毁会话
 * @param {string} token
 */
export function destroySession(token) {
  if (!token) return;
  run('DELETE FROM sessions WHERE id = ?', token);
}

/**
 * 从 ctx 读当前用户（中间件已注入）。
 * @param {object} ctx
 */
export function currentUser(ctx) {
  return ctx.user;
}

/** 写登录 Cookie */
export function attachSession(ctx, token, maxAge) {
  setCookie(ctx, COOKIE_NAME, token, { maxAge, httpOnly: true, sameSite: 'Lax' });
}

/** 清登录 Cookie */
export function detachSession(ctx) {
  clearCookie(ctx, COOKIE_NAME);
}

/** 启动时清理过期会话 */
export function bootSessions() {
  return purgeExpiredSessions();
}

/** 该用户是否已配置 API Key */
export function hasApiKey(userId) {
  const row = get('SELECT id FROM api_keys WHERE user_id = ? LIMIT 1', userId);
  return Boolean(row);
}

export { publicUser, all as _all };
