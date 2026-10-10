import type { Env } from './types';
import { FX_DDL } from './forecast/features';

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
  // hot cache (cache.ts) — moved off KV in v3.1: KV Free allows 1,000 writes/day, D1 Free 100,000
  `CREATE TABLE IF NOT EXISTS cache_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER NOT NULL, ttl INTEGER NOT NULL)`,
  // ---- outlook + forecast ledger (outlook/*, forecast/ledger.ts) ----
  `CREATE TABLE IF NOT EXISTS ticks (ts INTEGER PRIMARY KEY, price REAL NOT NULL, src TEXT NOT NULL, src_ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS outlook_log (day TEXT PRIMARY KEY, ts INTEGER NOT NULL, econ REAL NOT NULL, gold REAL NOT NULL, stance TEXT NOT NULL, gold_px REAL, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS insider_tx (acc TEXT NOT NULL, line INTEGER NOT NULL, ticker TEXT NOT NULL, filed INTEGER NOT NULL, tx_date INTEGER, who TEXT, code TEXT, ad TEXT, shares REAL, price REAL, PRIMARY KEY (acc, line))`,
  `CREATE INDEX IF NOT EXISTS idx_insider_filed ON insider_tx(filed DESC)`,
  // ---- v3.3: ledger v2 (5 models), feature table, evolution log ----
  `CREATE TABLE IF NOT EXISTS forecast_log (made INTEGER NOT NULL, h TEXT NOT NULL, target INTEGER NOT NULL, base REAL NOT NULL, naive REAL NOT NULL, drift REAL, revert REAL, signal REAL, evo REAL, blend REAL NOT NULL, actual REAL, actual_ts INTEGER, PRIMARY KEY (made, h)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_fl_open ON forecast_log(target) WHERE actual IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_fl_h_made ON forecast_log(h, made)`,
  `CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS forecast_stats (day TEXT NOT NULL, h TEXT NOT NULL, n INTEGER NOT NULL, mape_naive REAL, mape_drift REAL, mape_revert REAL, mape_signal REAL, mape_evo REAL, mape_blend REAL, hit_band REAL, hit5 REAL, bias REAL, PRIMARY KEY (day, h))`,
  FX_DDL,
  `CREATE TABLE IF NOT EXISTS evo_log (day TEXT NOT NULL, h TEXT NOT NULL, gen INTEGER, evals INTEGER, accepted INTEGER, best_fit REAL, med_fit REAL, champ_hk REAL, promoted INTEGER, gates TEXT, feat_use TEXT, PRIMARY KEY (day, h))`,
  // ---- news crawler (news/crawler.ts) ----
  `CREATE TABLE IF NOT EXISTS news_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, url TEXT NOT NULL UNIQUE, name TEXT NOT NULL, topics TEXT NOT NULL DEFAULT 'markets', enabled INTEGER DEFAULT 1, favorite INTEGER DEFAULT 0, added_by TEXT, created_at INTEGER, last_fetch INTEGER, last_ok INTEGER, last_error TEXT, items INTEGER DEFAULT 0, fails INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS news_items (id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, published INTEGER NOT NULL, fetched INTEGER, summary_raw TEXT, thumb TEXT, topics TEXT, ai_summary TEXT, ai_json TEXT, ai_at INTEGER, sentiment TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_news_pub ON news_items(published DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_news_src ON news_items(source_id, published DESC)`,
  // ---- v3.4: podcast/video digests (news/transcripts.ts), saved charts (chart builder) ----
  // transcript chunks live here only until the digest is written, then they are deleted
  `CREATE TABLE IF NOT EXISTS yt_digest (vid TEXT PRIMARY KEY, item_id TEXT, source_id INTEGER, title TEXT, url TEXT, published INTEGER, status TEXT NOT NULL, mode TEXT, chunks TEXT, notes TEXT, idx INTEGER DEFAULT 0, n INTEGER DEFAULT 0, chars INTEGER, summary TEXT, engine TEXT, err TEXT, tries INTEGER DEFAULT 0, created INTEGER, updated INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_ytd_status ON yt_digest(status, published DESC)`,
  `CREATE TABLE IF NOT EXISTS user_charts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, share TEXT UNIQUE, created INTEGER, updated INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_uc_user ON user_charts(user_id, updated DESC)`,
];

/* columns added after a table first shipped: [table, column, type]. checked with PRAGMA once per schema version. */
const ADD_COLS: [string, string, string][] = [
  ['users', 'role', `TEXT DEFAULT 'operator'`],
  ['users', 'pro_until', 'INTEGER DEFAULT NULL'],          // v3.4 pro tier expiry
  ['news_sources', 'cls', 'TEXT DEFAULT NULL'],            // v3.4 independent | mainstream (narrative radar)
  ['news_items', 'themes', 'TEXT DEFAULT NULL'],           // v3.4 canonical + AI themes, comma list
];
/* the five big-network YouTube channels in the v3 defaults count as mainstream; any other YouTube channel is independent */
export const MAINSTREAM_YT = ['UC9ijza42jVR3T6b8bColgvg', 'UCrp_UI8XtuYfpiqluWLD7Lw', 'UCIALMKvObZNtJ6AmdCLP7Lg', 'UCEAZeUIeJs0IjQiqTCdVSIg', 'UChqUTb7kYRX8-EiaN3XFrSQ'];

/* bump when DDL changes: a cold isolate then costs 1 query (version check) instead of ~40 statements,
   which kept every cron run and request under the Free plan's 50 queries per invocation */
export const SCHEMA_VER = 'v3.4-2';
let done = false;
let tries = 0;
export async function ensureSchema(env: Env): Promise<void> {
  if (done) return;
  try {
    const r = await env.DB.prepare(`SELECT v FROM schema_meta WHERE k='ver'`).first<{ v: string }>();
    if (r?.v === SCHEMA_VER) { done = true; return; }
  } catch { /* table missing on a fresh DB → run the DDL */ }
  try {
    await env.DB.batch(DDL.map(q => env.DB.prepare(q)));
    // migrations/0003_auth.sql created users WITHOUT a role column; later versions add more (ADD_COLS)
    const tables = [...new Set(ADD_COLS.map(c => c[0]))];
    const have = await env.DB.batch(tables.map(t => env.DB.prepare(`PRAGMA table_info(${t})`)));
    for (const [t, c, ty] of ADD_COLS) {
      const cols = (have[tables.indexOf(t)].results ?? []) as { name: string }[];
      if (!cols.some(x => x.name === c)) await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${ty}`).run();
    }
    // sources from before v3.4: RSS and the big-network channels = mainstream, other YouTube = independent
    await env.DB.prepare(`UPDATE news_sources SET cls = CASE WHEN kind='youtube' AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE news_sources.url LIKE '%' || j.value) THEN 'independent' ELSE 'mainstream' END WHERE cls IS NULL`).bind(JSON.stringify(MAINSTREAM_YT)).run();
    // "first user is admin" invariant: if NO admin exists, the earliest account gets it.
    await env.DB.prepare(`UPDATE users SET role='admin' WHERE id=(SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin')`).run();
    await env.DB.prepare(`INSERT INTO schema_meta (k, v) VALUES ('ver', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(SCHEMA_VER).run();
    done = true;
  } catch (e) {
    console.error('SCHEMA_FAIL', String((e as Error)?.message ?? e).slice(0, 160));
    if (++tries >= 3) done = true; // stop hammering D1; the error stays in the logs
  }
}
