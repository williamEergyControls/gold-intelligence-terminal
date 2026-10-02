-- 0004: tables the worker already uses but no migration declared,
-- plus the admin live-API probe log. all idempotent.
CREATE TABLE IF NOT EXISTS daily_bars (
  symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL,
  PRIMARY KEY (symbol, date));
CREATE TABLE IF NOT EXISTS api_probes (
  ts INTEGER NOT NULL, provider TEXT NOT NULL, ok INTEGER NOT NULL,
  http INTEGER, latency_ms INTEGER, sample TEXT, detail TEXT,
  PRIMARY KEY (ts, provider));
CREATE INDEX IF NOT EXISTS idx_probe_provider ON api_probes(provider, ts DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);
-- users.role is added at runtime by src/worker/schema.ts (ALTER only if missing),
-- because SQLite has no ADD COLUMN IF NOT EXISTS and a failed migration blocks deploys.
