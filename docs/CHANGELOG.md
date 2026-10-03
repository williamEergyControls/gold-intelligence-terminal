# Changelog

## v2 · 2026-10-02 · volatility desk, warehouse, ML strip

**Logic**
```
 every 10 min (ingest slot)          every 10 min (warm slot)        hourly
 POLL  45 units, budget 10   ─┐      bootstrap → KV boot:15M        probes · sentiment · daily seed/prune
 STORE D1 series_points       │      + live macro from warehouse    ML predict/grade (inputs from warehouse)
 EVAL  1 vol class + cross   ─┘
 PUBLISH snapshots → /api/vol · /api/ml/strip · /api/markets/stablecoins · /api/series
```

**New**
- `/vol.html` volatility desk: Treasuries + MOVE, FX (ECB) + DXY, stablecoin peg risk, insurance CPI/PPI + KIE,
  stocks + sectors + VIX/VXN/VVIX, gold/silver/oil + GVZ/OVX. RV10/20/60/252, EWMA, GARCH(1,1) 20-day and
  5-day 1σ range, 1y percentile, regime, σ-move alerts, VRP, yield curve, cross-asset stress, correlation, regime board.
- ML + vol strip on every page (gold 5-day model, live hit rate, stress, page focus series, top σ alert).
- D1 time-series warehouse (`docs/STORAGE.md`): 58 series, json_each bulk upserts, 4 D1 statements per cycle.
- ML pipeline reads its inputs from the warehouse (1 query instead of 15 upstream calls per hourly run).
- Admin → DATABASE: warehouse panel, RUN INGEST NOW, REBUILD VOL SNAPSHOTS.

**Data fixes**
- Auto-insurance CPI was CPI **motor fuel** (`CUSR0000SETB`) → `CUSR0000SETE`. Macro cache key bumped to `macro:v2`.
- Shelter / food / energy YoY, insurance table, Fed target range, ECB deposit rate: live from FRED via warehouse.
- Stablecoins: server-side (no browser → CoinGecko), deviation in bp, 90-day peg chart (USDT + USDC).
- Static reference rows (shipping indices, BOJ/PBOC, transport/medical CPI) now say STATIC REFERENCE.

**Fixed after independent review**
| # | Defect | Fix |
|---|--------|-----|
| 1 | GARCH grid on 2 classes ≈ 50 ms cold, over the Free CPU limit; a killed class stayed "oldest" and blocked the rest | 1 class per cycle by rotation, cached α/β (daily refit, 30-point grid, ≤250 obs) |
| 2 | 420-day window too short for 13 monthly CPI points → YoY null late each month | 600 days |
| 3 | monthly YoY / m/m by array position: a skipped release (e.g. BLS shutdown month) stretched the window | calendar-month lookup |
| 4 | Yahoo dates from today's gmtoffset → DST shift of all history | exchange time-zone dates |
| 5 | Sunday-evening futures prints created weekend rows (vol −9%, ML 5-bar horizon) | weekend rows dropped, after-18:00 futures → next session |
| 6 | `fetched_at` stamped after the fetch → every unit polled one cycle late | cycle-start stamp + 2-min grace |

## v1 · 2026-10-01 · build fix + admin console
See `docs/REVIEW.md`.
