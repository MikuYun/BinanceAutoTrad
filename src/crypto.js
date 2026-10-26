/**
 * 加密 / 哈希工具。
 * - API Key 用 AES-256-GCM 加密落库，格式 'v1.<ivB64>.<tagB64>.<ctB64>'
 * - 密码用 scrypt + 每用户随机盐，校验用 timingSafeEqual
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { MASTER_KEY } from './config.js';

const ALGO = 'aes-256-gcm';

/**
 * 加密明文。返回可直接存库的字符串。
 * @param {string} plain
 * @returns {string}
 */
export function encrypt(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('加密内容不能为空');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, MASTER_KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

/**
 * 解密。
 * @param {string} blob
 * @returns {string}
 */
export function decrypt(blob) {
  if (typeof blob !== 'string') throw new Error('密文格式错误');
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('密文格式错误');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const decipher = createDecipheriv(ALGO, MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * 脱敏：只保留首 4 位与末 4 位。
 * @param {string} k
 * @returns {string}
 */
export function maskKey(k) {
  if (typeof k !== 'string' || k.length === 0) return '';
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}${'*'.repeat(Math.min(16, k.length - 8))}${k.slice(-4)}`;
}

/**
 * 哈希密码，格式 'scrypt$<saltHex>$<hashHex>'
 * @param {string} pw
 * @returns {string}
 */
export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * 校验密码，时间恒定比较，避免时序泄露。
 * @param {string} pw
 * @param {string} stored
 * @returns {boolean}
 */
export function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let actual;
  try {
    actual = scryptSync(pw, salt, expected.length);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * 生成带前缀的随机 id。
 * @param {string} [prefix]
 * @returns {string}
 */
export function randomId(prefix = '') {
  const id = randomUUID().replace(/-/g, '');
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * HMAC-SHA256 十六进制签名（币安 REST 签名用）。
 * @param {string} secret
 * @param {string} payload
 * @returns {string}
 */
export function hmacSha256Hex(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * SHA-256 十六进制摘要。
 * @param {string} s
 * @returns {string}
 */
export function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}
