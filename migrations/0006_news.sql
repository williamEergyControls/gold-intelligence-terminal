-- v3: news crawler (your RSS feeds + YouTube channels) — the Worker also creates these at runtime
CREATE TABLE IF NOT EXISTS news_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, url TEXT NOT NULL UNIQUE, name TEXT NOT NULL, topics TEXT NOT NULL DEFAULT 'markets', enabled INTEGER DEFAULT 1, favorite INTEGER DEFAULT 0, added_by TEXT, created_at INTEGER, last_fetch INTEGER, last_ok INTEGER, last_error TEXT, items INTEGER DEFAULT 0, fails INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS news_items (id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, published INTEGER NOT NULL, fetched INTEGER, summary_raw TEXT, thumb TEXT, topics TEXT, ai_summary TEXT, ai_json TEXT, ai_at INTEGER, sentiment TEXT);
CREATE INDEX IF NOT EXISTS idx_news_pub ON news_items(published DESC);
CREATE INDEX IF NOT EXISTS idx_news_src ON news_items(source_id, published DESC);
