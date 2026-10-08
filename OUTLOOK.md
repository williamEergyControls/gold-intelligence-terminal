# Outlook engine + forecast ledger

## Logic
```
 every minute (* * * * *)                   4x a day (:52 slot, outlook > 6 h old)        daily
 POLL   gold-api.com spot                   READ  ~20 warehouse series, COT, Form 4,      00 UTC  ledger roll-up, relearn
        clock > 6 min old = market closed         crowd, shipping, drought                       blend weights, prune
 CHECK  >1.5% jump needs 2nd source ±0.5%   SCORE every factor s ∈ [-1,+1] × weight       12 UTC  SEC Form 4 pull
 STORE  tick + due forecasts (4 models)     Economy c/10, Gold y/10, stance, flips,
 GRADE  matured forecasts vs this tick            odds replay, outlooks, street-missing
        no tick in window → voided          STORE outlook_log (point-in-time, one row/day)
```

## Scores
`score = 5 + 5 × Σ(w·s) / Σw` over the inputs that are live (missing inputs drop out, coverage is shown).

| Economy input | w | Healthier when |
|---|---|---|
| Yield curve 10Y–3M (FRED T10Y3M) | 1.5 | positive; re-steepening after a 12-month inversion scores −0.5 |
| Baa credit spread (BAA10Y) | 1.5 | low and tightening |
| Jobless claims 4-wk avg vs 52-wk low (ICSA) | 1.2 | near the low (+30% = −1) |
| Sahm gap (UNRATE) | 1.2 | under 0.5 |
| Copper/gold 3-mo | 1.0 | rising |
| S&P vs 200-day | 0.8 | above |
| Dry-bulk freight BDRY 3-mo | 0.7 | rising |
| Consumer sentiment (UMCSENT) | 0.6 | above 75 |
| Chokepoint transits vs 28-day (PortWatch) | 0.5 | rising |
| VIX 1-yr percentile | 0.5 | low |
| Dollar 3-mo | 0.4 | falling |

| Gold input (3–12 months) | w | Better setup when |
|---|---|---|
| Value vs real yields (ln gold on DFII10, ≤2 yrs) | 1.5 | below the fitted line |
| Stretch vs 200-day | 1.2 | under +8% (−1 at +20%) |
| 12-month trend | 1.0 | rising |
| Real-yield 3-mo change | 1.0 | falling |
| CFTC managed-money net % of OI, 3-yr percentile | 1.0 | washed out (contrarian) |
| Economic backdrop (economy score) | 0.8 | weak economy |
| Dollar 3-mo | 0.7 | falling |
| Crowd mood, your YouTube + RSS + GDELT, 14 days | 0.6 | gloomy (contrarian), needs ≥ 8 stories |
| Miner insiders, SEC Form 4 open-market buys (NEM CDE HL RGLD FCX) | 0.6 | buying |
| Miners vs metal (GDX/GC) 3-mo | 0.6 | miners leading |

Stance: ≥ 6.8 accumulate (on dips if stretched) · 4.5–6.8 hold · < 4.5 trim or wait.

Odds: stretch, trend, real-yield and dollar are replayed on every stored day; days scoring within 0.75 of today
give the share with gold higher 63 trading days later. Overlapping windows, so a rough guide.
Every outlook is graded 91 days later on the Outlook page scorecard.

## Forecast ledger
| Horizon | New forecast | Graded if a tick is within | Tight band |
|---|---|---|---|
| 1m | every minute | ±90 s | 0.05% |
| 30m | every 5 min | ±3 min | 0.25% |
| 1d | hourly | ±30 min | 1% |
| 1w | every 6 h | ±3 h | 2.5% |
| 30d | daily | ±12 h | 5% |

Models: naive (price stays put, the baseline), drift (damped momentum), revert (pull to the 30-min EMA or
50-day mean), blend (weights = 1 / 7-day MAPE, relearned nightly). Skill = 1 − MAPE(blend)/MAPE(naive).

Training data for later models: `ticks` (every market minute, forever), `forecasts` (1m kept 30 days,
30m 180 days, longer forever), `forecast_daily`, `outlook_log` (full factor vector per day, point-in-time).

## Free-plan budget (added)
| | per day |
|---|---|
| D1 row writes | ~8–10k (ticks 1.4k, forecasts 1.8k, grading 1.8k, state 1.4k, rest small) |
| D1 storage | ~0.2 MB/day (≈ 70 MB/year before pruning) |
| Subrequests | 1–2 per minute; Form 4 ≤ 20 once a day; COT 1 per 12 h |
| Cron triggers | still 3 (`*/5` became `* * * * *`) |

## Setup
- `SEC_USER_AGENT` in `wrangler.jsonc` vars: `"GoldTerminal you@yourdomain.com"` (SEC requires a contact). Empty = insiders off.
- Migration `0008_outlook.sql` (the Worker also creates the tables at runtime).
- Admin: `POST /api/admin/outlook/build`, `POST /api/admin/insiders/refresh`.
