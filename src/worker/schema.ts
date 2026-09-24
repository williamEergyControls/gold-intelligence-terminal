import type { Env } from './types';

const DDL = [
  `CREATE TABLE IF NOT EXISTS price_snapshots (ts INTEGER NOT NULL, symbol TEXT NOT NULL, price REAL NOT NULL, source TEXT NOT NULL, PRIMARY KEY (ts, symbol))`,
  `CREATE INDEX IF NOT EXISTS idx_snap_symbol ON price_snapshots(symbol, ts DESC)`,
  `CREATE TABLE IF NOT EXISTS provider_health (provider TEXT PRIMARY KEY, last_success INTEGER, last_failure INTEGER, latency_ms INTEGER, status TEXT)`,
  `CREATE TABLE IF NOT EXISTS ml_models (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, trained_at INTEGER NOT NULL, weights TEXT NOT NULL, metrics TEXT NOT NULL, active INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS predictions (ts INTEGER NOT NULL, horizon_days INTEGER NOT NULL, p_up REAL NOT NULL, direction TEXT NOT NULL, regime TEXT, agents TEXT, PRIMARY KEY (ts, horizon_days))`,
  `CREATE TABLE IF NOT EXISTS prediction_outcomes (ts INTEGER NOT NULL, horizon_days INTEGER NOT NULL, realized_ret REAL, correct INTEGER, PRIMARY KEY (ts, horizon_days))`,
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT DEFAULT 'operator', created_at INTEGER NOT NULL, login_attempts INTEGER DEFAULT 0, locked_until INTEGER DEFAULT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
];
let done = false;
export async function ensureSchema(env: Env): Promise<void> {
  if (done) return;
  await env.DB.batch(DDL.map(q => env.DB.prepare(q)));
  done = true;
}
