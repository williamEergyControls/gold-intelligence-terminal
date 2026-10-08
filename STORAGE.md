# Data Storage: D1 Time-Series Warehouse

## Logic (scan cycle)

```
                every 10 min (the */5 cron alternates: :05 :15 :25 … = ingest, :00 :10 … = UI warm)
 ┌────────────┐   ┌──────────────────────────┐   ┌───────────────────────────────┐   ┌──────────────┐
 │ INIT       │ → │ POLL                     │ → │ EVALUATE                      │ → │ PUBLISH      │
 │ 1 query:   │   │ due units, round-robin   │   │ parse → [id, date, value]     │   │ 3 statements │
 │ unit state │   │ across sources, ≤ budget │   │ backfill once, then a recent  │   │ (json_each   │
 │            │   │ sequential per host      │   │ window overwritten in place   │   │  bulk upsert)│
 └────────────┘   └──────────────────────────┘   └───────────────────────────────┘   └──────┬───────┘
                                                                                             │
                 then: rebuild ONE vol class (missing first, else rotate by slot) + cross snapshot ◀┘
 readers (/api/vol, /api/series, /api/ml/strip, ML pipeline, bootstrap macro) = 1 D1 read, no upstream call
```

SCADA analogy: each **unit** is one poll (one HTTP request) with its own scan class
(`cadenceMin`). A unit can return several tags (Frankfurter returns 8 FX pairs, CoinGecko
returns price + market cap). Every tag is a **series** keyed by id.

## Tables

| Table | Key | What |
|-------|-----|------|
| `series_points` | (id, ts) `WITHOUT ROWID` | one value per series per observation date (UTC midnight ms). "series X since T" = one range scan |
| `series_meta` | id | label, class, kind, unit, source, points, first/last date, last/prev value |
| `ingest_units` | key | last fetch, last success, last error, consecutive fails, newest date stored |
| `snapshots` | key | computed JSON (`vol:rates`, `vol:fx`, … `vol:x`). D1 instead of KV: no 1,000 writes/day cap |

## Why this shape

| Problem before | Fix |
|----------------|-----|
| Every page view or cron rebuild re-downloaded 2 years of history from Yahoo/FRED | history stored once, only the recent window re-fetched |
| ML pipeline: 15 upstream calls per hourly run (train + predict + grade each loaded inputs) | reads the warehouse (1 query); falls back to live only while backfilling |
| KV Free = 1,000 writes/day, already near the cap | computed results go to D1 `snapshots`; KV keeps only small hot state |
| Workers Free = 50 subrequests and ~50 D1 queries per invocation | ingest spends ≤ `INGEST_BUDGET` (10) upstream calls and 4 D1 statements per cycle, whatever the row count |
| Yahoo 429s when 10+ calls fire at once | sequential per host, hosts in parallel; round-robin so one blocked host never starves the rest |
| Missing key burned the whole budget | units without a resolved key fail fast with no request and back off |

## Data rules

| Rule | Why |
|------|-----|
| one row per series per **observation date** (UTC midnight ms), upsert in place | revisions and today's moving bar overwrite, never duplicate |
| Yahoo dates computed in the **exchange time zone** (`exchangeTimezoneName`), not today's `gmtoffset` | a winter backfill no longer shifts every summer bar by a day |
| no Saturday/Sunday rows for exchange-traded series | weekend prints added fake zero-return days (vol −9%, ML 5-bar horizon < 5 sessions) |
| futures prints after 18:00 exchange time → next session date | Sunday-evening GC/CL trading belongs to Monday |
| monthly math by **calendar month** (t vs t−12), never array position | a skipped CPI release must not turn YoY into a 13-month change |
| units stamped with the **cycle start**, 2-min due grace | a 30-min unit really polls every 30 min (was 40) |

## CPU budget (Workers Free ≈ 10 ms)

- one vol class per cycle; each class rebuilt hourly by rotation, so a class that hits the CPU limit can never block the others
- GARCH α/β refit at most once a day (coarse 30-point grid, ≤ 250 obs); other runs reuse the cached fit and only run the O(n) variance recursion (13 series ≈ 2.4 ms vs ≈ 36 ms cold full fit)
- admin **REBUILD VOL SNAPSHOTS** posts one class per request

## Capacity

| Item | Number |
|------|--------|
| Series | 58 (45 poll units) |
| Backfill | ≈ 26,000 rows once (2 y daily, 15 y monthly CPI, 1 y stablecoins) |
| Growth | ≈ 90 rows/day |
| Row size | ≈ 40 bytes → ≈ 1.3 MB/year |
| D1 Free limit | 500 MB per database: decades of headroom. No retention on `series_points` |
| Upstream calls | ≈ 40/hour steady state; backfill completes in ≈ 50 min (5 cycles) |

## Cadence (scan classes)

| Source | Units | Every | Notes |
|--------|-------|-------|-------|
| Yahoo (indices, ETFs, futures, vol indices) | 20 | 30 or 60 min | today's live print overwrites today's bar |
| CoinGecko | 6 | 60 min | public API, 365-day history limit |
| FRED daily (yields, policy rates) | 10 | 6–12 h | 10-day overlap re-fetched for revisions |
| FRED monthly (CPI/PPI insurance + components) | 8 | 24 h | 100-day overlap for revisions |
| Frankfurter (ECB) | 1 (8 pairs) | 6 h | one call returns every pair |

## Operate

- Admin → DATABASE + KV → **Time-series warehouse**: every unit, points, range, last error, fails.
- **RUN INGEST NOW** = one cycle on demand. **REBUILD VOL SNAPSHOTS** = recompute from stored data, no upstream calls.
- Raise throughput on Workers Paid: set `INGEST_BUDGET` in `wrangler.jsonc` (max 40).

## Next step, if intraday ticks are ever stored

Intraday (5-min) data for 60 series would be ≈ 17,000 rows/day ≈ 250 MB/year. At that point keep
90 days hot in D1 and roll older partitions to R2 as daily NDJSON/Parquet files. Not needed for
the daily/monthly data stored today.
