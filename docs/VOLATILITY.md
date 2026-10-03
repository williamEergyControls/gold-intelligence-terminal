# Volatility Desk: Methods

Page `/vol.html`. API `/api/vol` (snapshots), `/api/series?id=` (detail), `/api/ml/strip?page=` (band on every page).

## Per-series metrics

| Metric | Definition |
|--------|-----------|
| Change | price/index: log return %; yields: bp; stablecoins: bp of deviation; CPI: m/m % |
| RV10 / RV20 / RV60 / RV252 | sample stdev of the last n changes × √252 (√365 for 24/7 stablecoins, √12 monthly) |
| EWMA | RiskMetrics, λ = 0.94, annualized |
| GARCH(1,1) | σ²ₜ = ω + α·r²ₜ₋₁ + β·σ²ₜ₋₁, variance targeting ω = V_L(1−α−β), α/β by Gaussian likelihood grid search on ≤500 obs. 20D = average forecast variance over 20 days, annualized |
| 5D 1σ | √(Σ GARCH variance, 5 days) → price units (or bp for yields) |
| σ move (z) | last change ÷ GARCH conditional σ for that day. Alert at abs(z) ≥ 2.5 (daily), ≥ 2 (monthly) |
| Percentile | rank of today's RV20 inside the last 252 RV20 values. Vol indices (VIX, MOVE, GVZ, OVX…): rank of the level |
| Regime | percentile < 20 LOW · < 60 NORMAL · < 85 ELEVATED · else STRESS |
| Stablecoins | deviation bp = (price − 1) × 10,000; max abs dev 30/90 d; σ bp/day; days > 10 bp; regime by current abs dev (< 10 / 50 / 100 bp) |
| CPI / PPI | YoY, m/m, 3-month annualized, m/m σ over 36 m, z of latest m/m, YoY percentile over 10 y |

## Class extras

- **Treasuries**: curve now / 1 M / 1 Y ago, 2s10s, 3m10y, Fed target range and ECB deposit rate (FRED).
- **FX**: RV20 ranking. USD/CNY is a managed band; low vol there is policy.
- **Stablecoins**: market-cap share, 30-day supply change, deviation bars.
- **Insurance**: YoY of auto, home/renters, health CPI and P&C insurer PPI vs CPI all items.
- **Stocks / Gold · Oil**: implied vs realized (VRP): VIX vs SPX RV20, VXN vs NDX, GVZ vs gold, OVX vs oil.

## Cross-asset

- **Stress index (CALC)**: equal-weight mean of five percentiles: VIX level, MOVE level, FX RV20 (avg),
  GVZ + OVX levels, abs depeg of USDT + USDC. 0 = calmest day of the past year. Not an official index.
- **Correlation**: 60 observations of daily changes, aligned by date.

## Honesty rules applied

- Every row shows source, series id and observation date; stale rows are flagged (> 6 days daily, > 75 days monthly).
- Futures (GC, SI, CL) are labeled as futures; the gold desk hero stays on spot.
- If a series has no data yet the row is missing and the page says WAREHOUSE WARMING; nothing is simulated on this page.
