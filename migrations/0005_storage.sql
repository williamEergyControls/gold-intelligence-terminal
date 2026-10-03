-- 0005: time-series warehouse + computed snapshots (see src/worker/store/*)
-- one row per series per observation date. WITHOUT ROWID = PK is the storage order,
-- so "series X since T" is a single range scan.
CREATE TABLE IF NOT EXISTS series_points (
  id TEXT NOT NULL, ts INTEGER NOT NULL, v REAL NOT NULL,
  PRIMARY KEY (id, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS series_meta (
  id TEXT PRIMARY KEY, label TEXT, cls TEXT, kind TEXT, unit TEXT, freq TEXT,
  source TEXT, src_id TEXT, points INTEGER, first_ts INTEGER, last_ts INTEGER,
  last_v REAL, prev_v REAL, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS ingest_units (
  key TEXT PRIMARY KEY, fetched_at INTEGER, ok_at INTEGER, error TEXT,
  last_rows INTEGER, last_ms INTEGER, last_ts INTEGER, fails INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS snapshots (
  key TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL);
