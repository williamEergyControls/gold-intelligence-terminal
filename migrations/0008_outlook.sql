-- v3.2: outlook engine + forecast ledger (the Worker also creates these at runtime)
CREATE TABLE IF NOT EXISTS ticks (ts INTEGER PRIMARY KEY, price REAL NOT NULL, src TEXT NOT NULL, src_ts INTEGER);
CREATE TABLE IF NOT EXISTS forecasts (made INTEGER NOT NULL, h TEXT NOT NULL, target INTEGER NOT NULL, base REAL NOT NULL, naive REAL NOT NULL, drift REAL NOT NULL, revert REAL NOT NULL, blend REAL NOT NULL, actual REAL, actual_ts INTEGER, PRIMARY KEY (made, h)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_fc_open ON forecasts(target) WHERE actual IS NULL;
CREATE TABLE IF NOT EXISTS forecast_daily (day TEXT NOT NULL, h TEXT NOT NULL, n INTEGER NOT NULL, mape_naive REAL, mape_drift REAL, mape_revert REAL, mape_blend REAL, hit_band REAL, hit5 REAL, bias REAL, PRIMARY KEY (day, h));
CREATE TABLE IF NOT EXISTS outlook_log (day TEXT PRIMARY KEY, ts INTEGER NOT NULL, econ REAL NOT NULL, gold REAL NOT NULL, stance TEXT NOT NULL, gold_px REAL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS insider_tx (acc TEXT NOT NULL, line INTEGER NOT NULL, ticker TEXT NOT NULL, filed INTEGER NOT NULL, tx_date INTEGER, who TEXT, code TEXT, ad TEXT, shares REAL, price REAL, PRIMARY KEY (acc, line));
CREATE INDEX IF NOT EXISTS idx_insider_filed ON insider_tx(filed DESC);
