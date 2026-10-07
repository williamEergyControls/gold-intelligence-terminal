-- v3.1: hot cache moved from KV (Free: 1,000 writes/day) to D1 (Free: 100,000 row writes/day).
-- one row per cache key, overwritten in place; rows are kept as the last good value during outages.
CREATE TABLE IF NOT EXISTS cache_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER NOT NULL, ttl INTEGER NOT NULL);
