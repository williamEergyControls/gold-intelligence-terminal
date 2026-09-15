CREATE TABLE IF NOT EXISTS ml_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, trained_at INTEGER NOT NULL,
  weights TEXT NOT NULL, metrics TEXT NOT NULL, active INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS predictions (
  ts INTEGER NOT NULL, horizon_days INTEGER NOT NULL,
  p_up REAL NOT NULL, direction TEXT NOT NULL, regime TEXT, agents TEXT,
  PRIMARY KEY (ts, horizon_days));
CREATE TABLE IF NOT EXISTS prediction_outcomes (
  ts INTEGER NOT NULL, horizon_days INTEGER NOT NULL,
  realized_ret REAL, correct INTEGER,
  PRIMARY KEY (ts, horizon_days));
