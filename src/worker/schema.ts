import type { Env } from './types';

/* runs once per isolate. every statement is idempotent (IF NOT EXISTS),
   so it is safe against a DB that was built by the migrations/ folder,
   by hand in D1 Studio, or by an older version of this file. */
const DDL = [
  `CREATE TABLE IF NOT EXISTS price_snapshots (ts INTEGER NOT NULL, symbol TEXT NOT NULL, price REAL NOT NULL, source TEXT NOT NULL, PRIMARY KEY (ts, symbol))`,
  `CREATE INDEX IF NOT EXISTS idx_snap_symbol ON price_snapshots(symbol, ts DESC)`,
  `CREATE TABLE IF NOT EXISTS provider_health (provider TEXT PRIMARY KEY, last_success INTEGER, last_failure INTEGER, latency_ms INTEGER, status TEXT)`,
  `CREATE TABLE IF NOT EXISTS ml_models (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, trained_at INTEGER NOT NULL, weights TEXT NOT NULL, metrics TEXT NOT NULL, active INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS predictions (ts INTEGER NOT NULL, horizon_days INTEGER NOT NULL, p_up REAL NOT NULL, direction TEXT NOT NULL, regime TEXT, agents TEXT, PRIMARY KEY (ts, horizon_days))`,
  `CREATE TABLE IF NOT EXISTS prediction_outcomes (ts INTEGER NOT NULL, horizon_days INTEGER NOT NULL, realized_ret REAL, correct INTEGER, PRIMARY KEY (ts, horizon_days))`,
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT DEFAULT 'operator', created_at INTEGER NOT NULL, login_attempts INTEGER DEFAULT 0, locked_until INTEGER DEFAULT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  // daily_bars was written by ml/pipeline.ts but never declared here — a fresh DB would silently drop every bar
  `CREATE TABLE IF NOT EXISTS daily_bars (symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL, PRIMARY KEY (symbol, date))`,
  // admin live-API probe history (pruned to 14 days by the daily cron)
  `CREATE TABLE IF NOT EXISTS api_probes (ts INTEGER NOT NULL, provider TEXT NOT NULL, ok INTEGER NOT NULL, http INTEGER, latency_ms INTEGER, sample TEXT, detail TEXT, PRIMARY KEY (ts, provider))`,
  `CREATE INDEX IF NOT EXISTS idx_probe_provider ON api_probes(provider, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at)`,
  // ---- time-series warehouse (store/ingest.ts) ----
  `CREATE TABLE IF NOT EXISTS series_points (id TEXT NOT NULL, ts INTEGER NOT NULL, v REAL NOT NULL, PRIMARY KEY (id, ts)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS series_meta (id TEXT PRIMARY KEY, label TEXT, cls TEXT, kind TEXT, unit TEXT, freq TEXT, source TEXT, src_id TEXT, points INTEGER, first_ts INTEGER, last_ts INTEGER, last_v REAL, prev_v REAL, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS ingest_units (key TEXT PRIMARY KEY, fetched_at INTEGER, ok_at INTEGER, error TEXT, last_rows INTEGER, last_ms INTEGER, last_ts INTEGER, fails INTEGER DEFAULT 0)`,
  // computed analytics (vol snapshots, strip) — D1 instead of KV: no 1,000 writes/day cap
  `CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL)`,
];

let done = false;
let ddlDone = false;
let roleTries = 0;
export async function ensureSchema(env: Env): Promise<void> {
  if (done) return;
  if (!ddlDone) { await env.DB.batch(DDL.map(q => env.DB.prepare(q))); ddlDone = true; }

  // migrations/0003_auth.sql created users WITHOUT a role column. if the table came
  // from that file, add the column, otherwise nobody can ever reach the admin routes.
  try {
    const cols = await env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>();
    if (!(cols.results ?? []).some(c => c.name === 'role')) {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'operator'`).run();
    }
    // "first user is admin" invariant: if NO admin exists, the earliest account gets it.
    await env.DB.prepare(
      `UPDATE users SET role='admin' WHERE id=(SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin')`
    ).run();
    done = true;
  } catch (e) {
    console.error('SCHEMA_ROLE_FIX_FAIL', String((e as Error)?.message ?? e).slice(0, 160));
    if (++roleTries >= 3) done = true; // stop hammering D1; the error stays in the logs
  }
}
