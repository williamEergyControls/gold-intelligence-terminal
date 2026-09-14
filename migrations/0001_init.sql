CREATE TABLE IF NOT EXISTS price_snapshots (
  ts INTEGER NOT NULL, symbol TEXT NOT NULL, price REAL NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (ts, symbol));
CREATE INDEX IF NOT EXISTS idx_snap_symbol ON price_snapshots(symbol, ts DESC);
CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY, last_success INTEGER, last_failure INTEGER,
  latency_ms INTEGER, status TEXT);
