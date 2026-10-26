/**
 * SQLite 数据访问层。
 * 使用 Node 24 内置的 node:sqlite，零第三方依赖。
 * 所有 SQL 一律参数绑定，禁止字符串拼接。
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

export const db = new DatabaseSync(join(DATA_DIR, 'app.db'));

// WAL 提升并发读性能；外键约束打开
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT,
  key_enc TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  masked TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unverified',
  last_verified INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS robots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'paper',
  status TEXT NOT NULL DEFAULT 'stopped',
  params_json TEXT NOT NULL,
  state_json TEXT,
  paper_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  last_tick INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_robots_user ON robots(user_id);

-- 模拟盘「账户钱包」：一个用户一个共享钱包，所有模拟机器人从这里占用保证金。
-- 这与币安 U 本位全仓账户一致：余额属于账户，不属于单个机器人。
CREATE TABLE IF NOT EXISTS paper_accounts (
  user_id TEXT PRIMARY KEY,
  balance REAL NOT NULL DEFAULT 0,
  initial_balance REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0,
  fee_paid REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  robot_id TEXT NOT NULL,
  client_id TEXT UNIQUE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL,
  avg_price REAL,
  status TEXT NOT NULL,
  reduce_only INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  exchange_order_id TEXT,
  fee REAL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_robot ON orders(robot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS equity_curve (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  robot_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  equity REAL NOT NULL,
  price REAL,
  position_qty REAL
);
CREATE INDEX IF NOT EXISTS idx_equity_robot ON equity_curve(robot_id, ts);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  robot_id TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_robot ON events(robot_id, ts);

/* 账户级权益快照：概览页的权益曲线用这张表，而不是单机器人曲线。
   一个用户一个 mode 一条时间线（模拟盘 / 实盘分开记）。 */
CREATE TABLE IF NOT EXISTS account_equity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  ts INTEGER NOT NULL,
  equity REAL NOT NULL,
  wallet_balance REAL,
  unrealized_pnl REAL,
  realized_pnl REAL
);
CREATE INDEX IF NOT EXISTS idx_acct_equity ON account_equity(user_id, mode, ts);

/* 每日开盘基准：今日盈亏 = 当前权益 − 当日基准。
   基准在每天第一次访问时写入（取昨天最后一条快照，没有则取初始入金），
   用户手动改模拟余额（入金/出金）时同步重置基准，避免把入金算成盈利。 */
CREATE TABLE IF NOT EXISTS account_daily (
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  day TEXT NOT NULL,
  start_equity REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, mode, day)
);
`);

/* 老库升级：orders 增加 realized_pnl 列（已实现盈亏），用于精确统计今日/累计收益。
   CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，所以这里单独 ALTER 并容错。 */
try {
  const cols = db.prepare('PRAGMA table_info(orders)').all();
  const has = cols.some((c) => String(c.name) === 'realized_pnl');
  if (!has) db.exec('ALTER TABLE orders ADD COLUMN realized_pnl REAL DEFAULT 0');
} catch {
  /* 升级失败不影响主流程，统计会退化为不含已实现盈亏 */
}

/** 查询多行 */
export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

/** 查询单行 */
export function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}

/** 执行写入，返回 { changes, lastInsertRowid } */
export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

/** 事务包裹：fn 抛异常则整体回滚 */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时忽略，保留原始异常 */
    }
    throw e;
  }
}

/** 清理过期会话（启动时调一次即可） */
export function purgeExpiredSessions(now = Date.now()) {
  return run('DELETE FROM sessions WHERE expires_at < ?', now).changes;
}
