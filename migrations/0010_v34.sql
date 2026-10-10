-- v3.4: podcast digests + chart builder tables. Idempotent (IF NOT EXISTS) so it is safe before or after deploy.
-- The three new columns (users.pro_until, news_sources.cls, news_items.themes) are added by the Worker at runtime
-- (schema.ts ADD_COLS, checked with PRAGMA): an ALTER here would fail and block later migrations once the Worker ran first.
CREATE TABLE IF NOT EXISTS yt_digest (vid TEXT PRIMARY KEY, item_id TEXT, source_id INTEGER, title TEXT, url TEXT, published INTEGER, status TEXT NOT NULL, mode TEXT, chunks TEXT, notes TEXT, idx INTEGER DEFAULT 0, n INTEGER DEFAULT 0, chars INTEGER, summary TEXT, engine TEXT, err TEXT, tries INTEGER DEFAULT 0, created INTEGER, updated INTEGER);
CREATE INDEX IF NOT EXISTS idx_ytd_status ON yt_digest(status, published DESC);
CREATE TABLE IF NOT EXISTS user_charts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, share TEXT UNIQUE, created INTEGER, updated INTEGER);
CREATE INDEX IF NOT EXISTS idx_uc_user ON user_charts(user_id, updated DESC);
CREATE INDEX IF NOT EXISTS idx_fl_h_made ON forecast_log(h, made);
CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- (the cls backfill also runs at runtime, right after the column is added)
-- UPDATE news_sources SET cls = CASE WHEN kind = 'youtube' AND url NOT LIKE '%UC9ijza42jVR3T6b8bColgvg' AND url NOT LIKE '%UCrp_UI8XtuYfpiqluWLD7Lw' AND url NOT LIKE '%UCIALMKvObZNtJ6AmdCLP7Lg' AND url NOT LIKE '%UCEAZeUIeJs0IjQiqTCdVSIg' AND url NOT LIKE '%UChqUTb7kYRX8-EiaN3XFrSQ' THEN 'independent' ELSE 'mainstream' END WHERE cls IS NULL;
