# Changelog

## v3 · 2026-10-02 · clean layout, news crawler, real calendar, maps

**Logic**
```
 every 10 min (:02 :12 … :52)        on page load                         weekly / daily
 POLL  your YouTube channels + RSS   shell.js: auth → theme → header      USDM drought (Thu) · FRED release dates
 STORE D1 news_items (dedupe by url) page script → /api/* (KV/D1 reads)   PortWatch chokepoints + ports (daily)
 EVAL  Workers AI: 2-line summary,   maps.js: US albers / natural earth   Drewry WCI lanes (weekly note)
       sentiment, trade idea + risk  calendar.js: month grid + agenda
 PUBLISH /api/news/feed · /api/news/ideas · /api/calendar · /api/drought · /api/page/shipping
```

**Design**
- One stylesheet, Chrome-style light and dark (system by default). No scanline overlay, no scrolling tape,
  no all-caps labels, 11 px text floor, cards grow with content (no inner scrollbars), no page-level horizontal scroll.
- One header for every page (`js/shell.js`): nav with the active desk, search, theme, clock, avatar, sign out.
- Every desk has a page title, a 12-column grid that collapses to 1 column on phones, and the ML strip sized per page.

**New**
- News crawler: paste a YouTube channel link, @handle or any RSS URL in Admin → News sources. Crawled server-side
  every 10 min, summarized by Workers AI with a trade idea and the condition that proves it wrong.
  Shown on Home (trade ideas + your sources), `/news.html` (full feed, filters) and every desk's news card.
- Real calendar on the gold page: month grid + agenda, FRED release dates, FOMC/ECB meetings, weekly EIA/USDA rules (marked est.).
- US drought map (home, water) with live USGS gauges plotted. Water desk rebuilt.
- Shipping desk: world map with 28 chokepoints (IMF PortWatch transits vs 28-day), 25 busiest ports and
  priced Drewry container lanes; chokepoint table with 30-day sparklines.
- Removed dead code: `js/app.js`, `js/nav-extra.js`.

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
