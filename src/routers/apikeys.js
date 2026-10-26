/**
 * API Key 路由。
 *
 * GET    /api/apikeys               列表（不含明文，只有掩码）
 * POST   /api/apikeys               新增 { label, apiKey, apiSecret }，AES-256-GCM 加密落库
 * POST   /api/apikeys/:id/verify    用币安账户接口验证密钥是否可用 + 权限
 * DELETE /api/apikeys/:id           删除
 *
 * 安全红线：
 *   1. 明文 secret 只在内存里用一次，绝不写日志、绝不回传；
 *   2. 返回给前端的一律是掩码 + 状态；
 *   3. 验证失败不抛 500，返回 { status:'error', error:'中文原因' }，前端好展示。
 */
import { HttpError, requireAuth } from '../http.js';
import { all, get, run } from '../db.js';
import { encrypt, decrypt, maskKey, randomId } from '../crypto.js';
import { loadCredentials } from '../binance/index.js';
import * as rest from '../binance/rest.js';
import { isNetworkError } from '../binance/rest.js';

/** 只有 Key 没有 Secret 时的统一提示 */
const MISSING_SECRET_MSG =
  '缺少 API Secret：币安账户接口必须用 Secret 签名，只填 Key 无法读取余额。请补填 Secret 后重新保存';

/** 币安 API Key 形如 64 位字母数字，Secret 同长度；这里做宽松校验 */
function assertKeyLike(v, label) {
  const s = String(v || '').trim();
  if (s.length < 16 || s.length > 128 || !/^[A-Za-z0-9+/=_-]+$/.test(s)) {
    throw new HttpError(400, 'BAD_KEY', `${label}格式不正确（应为 16-128 位字母数字）`);
  }
  return s;
}

function shapeRow(row) {
  return {
    id: row.id,
    label: row.label || '未命名',
    masked: row.masked || '••••',
    status: row.status || 'unverified',
    lastVerified: row.last_verified || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
  };
}

export default function register(app) {
  /* ---------------- 列表 ---------------- */
  app.get('/api/apikeys', async (ctx) => {
    const u = requireAuth(ctx);
    const rows = all(
      'SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
      u.id,
    );
    return rows.map(shapeRow);
  });

  /* ---------------- 新增 ---------------- */
  app.post('/api/apikeys', async (ctx) => {
    const u = requireAuth(ctx);
    const body = ctx.body || {};
    const label = String(body.label || '').trim().slice(0, 40) || '未命名';
    const apiKey = assertKeyLike(body.apiKey, 'API Key');
    // Secret 允许暂时留空：用户可以先把 Key 存进来，之后再补 Secret。
    // 币安所有账户类私有接口都要用 Secret 做 HMAC 签名，只有 Key 查不到余额。
    const rawSecret = String(body.apiSecret || '').trim();
    const hasSecret = rawSecret.length > 0;
    const apiSecret = hasSecret ? assertKeyLike(rawSecret, 'API Secret') : '';
    const status = hasSecret ? 'unverified' : 'incomplete';
    const lastError = hasSecret ? null : MISSING_SECRET_MSG;

    // 同一用户重复粘贴同一个 Key 时更新而不是堆叠
    const dup = all('SELECT * FROM api_keys WHERE user_id = ?', u.id).find((r) => {
      try {
        return decryptLoose(r.key_enc) === apiKey;
      } catch {
        return false;
      }
    });

    const now = Date.now();
    const masked = maskKey(apiKey);

    if (dup) {
      run(
        `UPDATE api_keys SET label = ?, key_enc = ?, secret_enc = ?, masked = ?,
           status = ?, last_error = ? WHERE id = ?`,
        label,
        encrypt(apiKey),
        hasSecret ? encrypt(apiSecret) : '',
        masked,
        status,
        lastError,
        dup.id,
      );
      const row = get('SELECT * FROM api_keys WHERE id = ?', dup.id);
      return { ...shapeRow(row), updated: true };
    }

    const id = randomId('k');
    run(
      `INSERT INTO api_keys (id, user_id, label, key_enc, secret_enc, masked, status, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      u.id,
      label,
      encrypt(apiKey),
      hasSecret ? encrypt(apiSecret) : '',
      masked,
      status,
      lastError,
      now,
    );
    const row = get('SELECT * FROM api_keys WHERE id = ?', id);
    return { ...shapeRow(row), updated: false };
  });

  /* ---------------- 验证 ---------------- */
  app.post('/api/apikeys/:id/verify', async (ctx) => {
    const u = requireAuth(ctx);
    const id = String(ctx.params.id || '');
    const row = get('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', id, u.id);
    if (!row) throw new HttpError(404, 'KEY_NOT_FOUND', '该 API Key 不存在');
    if (row.status === 'incomplete') {
      return { status: 'incomplete', error: MISSING_SECRET_MSG, missingSecret: true };
    }

    const creds = loadCredentials(u.id);
    if (!creds || creds.id !== id) {
      // 极端情况：解密失败
      run(
        "UPDATE api_keys SET status = 'error', last_error = ? WHERE id = ?",
        '密钥解密失败，请重新添加',
        id,
      );
      return { status: 'error', error: '密钥解密失败，请删除后重新添加' };
    }

    try {
      const acc = await rest.accountInfo(creds);
      const total = Number(acc && acc.totalWalletBalance) || 0;
      run(
        "UPDATE api_keys SET status = 'verified', last_verified = ?, last_error = NULL WHERE id = ?",
        Date.now(),
        id,
      );
      return {
        status: 'verified',
        equity: round(total, 4),
        message: `验证通过，合约账户权益 ${round(total, 4)} USDT`,
      };
    } catch (err) {
      const msg = explainError(err);
      run(
        "UPDATE api_keys SET status = 'error', last_verified = ?, last_error = ? WHERE id = ?",
        Date.now(),
        msg,
        id,
      );
      return {
        status: 'error',
        error: msg,
        networkDown: isNetworkError(err),
      };
    }
  });

  /* ---------------- 删除 ---------------- */
  app.del('/api/apikeys/:id', async (ctx) => {
    const u = requireAuth(ctx);
    const id = String(ctx.params.id || '');
    const row = get('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', id, u.id);
    if (!row) throw new HttpError(404, 'KEY_NOT_FOUND', '该 API Key 不存在');

    // 有实盘机器人在跑时禁止删除，避免下单中途失去凭据
    const busy = all(
      "SELECT id, name FROM robots WHERE user_id = ? AND mode = 'live' AND status = 'running'",
      u.id,
    );
    if (busy.length) {
      throw new HttpError(
        409,
        'ROBOT_RUNNING',
        `还有 ${busy.length} 个实盘机器人正在运行，请先停止再删除密钥`,
      );
    }
    run('DELETE FROM api_keys WHERE id = ?', id);
    return { deleted: true, id };
  });
}

/** 把币安错误翻译成用户能看懂的中文 */
function explainError(err) {
  if (!err) return '未知错误';
  if (isNetworkError(err)) {
    return '无法连接币安服务器（本机网络不通或被墙），请配置代理后重试';
  }
  const code = err.binanceCode;
  if (code === -2015) return 'API Key 或 Secret 错误，或密钥没有合约账户读取权限';
  if (code === -1022) return '签名校验失败：Secret 不正确';
  if (code === -1021) return '时间戳超出 recvWindow，请校准本机时间';
  if (code === -2014) return 'API Key 格式错误';
  if (code === -4046) return '无需重复设置该参数';
  if (code === -1003) return '请求过于频繁，已被限频';
  return (err && err.message) || String(err);
}

function decryptLoose(blob) {
  try {
    return decrypt(blob);
  } catch {
    return null;
  }
}

function round(v, d) {
  return Number.isFinite(v) ? Math.round(v * Math.pow(10, d)) / Math.pow(10, d) : 0;
}
