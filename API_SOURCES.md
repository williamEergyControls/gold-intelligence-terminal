# API Sources

| Provider | Key | Used for | Cadence label | Cache | Notes |
|----------|-----|----------|---------------|-------|-------|
| gold-api.com | none | XAU/XAG spot (primary) | NEAR-LIVE | 20 s isolate memo | free, no stated limit |
| Yahoo Finance chart | none | candles, DXY, futures, miners, ML inputs | NEAR-LIVE | 60 s - 1 h | unofficial, rate-limits under load |
| metals.dev | METALS_API_KEY | gold/silver fallback #2 | NEAR-LIVE | METALS_TTL (28800 s) | ~100 req/month |
| GoldAPI.io | GOLDAPI_KEY | daily OHLC, bid/ask, prev close seed | DAILY | KV `goldio:daily` 2 d | cron 2 calls/day |
| Stooq CSV | none | miners heatmap, gold/DXY fallback | EOD | 1 h | |
| Frankfurter (ECB) | none | FX panel | DAILY | 1 h | ECB reference rates ~16:00 CET |
| FRED | FRED_API_KEY | CPI, PCE, PPI, yields, real yield, SOFR, EFFR | DAILY / MONTHLY | 6 h | 120 req/min |
| EIA API v2 | EIA_API_KEY | crude stocks, retail gasoline, retail diesel | WEEKLY | 6 h | `/v2/seriesid/{v1 id}` route |
| GDELT DOC 2.0 | none | news + keyword sentiment | NEAR-LIVE | 1 h | Llama re-labels hourly |
| USGS WaterServices | none | river gage height | NEAR-LIVE | 15 min | legacy, being retired |
| USGS Water Data OGC | none | migration target | NEAR-LIVE | probe only | api.waterdata.usgs.gov/ogcapi/v0 |
| Open-Meteo | none | plains weather, marine | HOURLY | 15 min | |
| CoinGecko | none | stablecoins (price + mcap) | DAILY + LATEST | D1 warehouse, hourly | server-side since v2; no browser calls |
| FRED (warehouse) | FRED_API_KEY | DGS3MO/2/5/10/30, DFII10, T10YIE, DFEDTARL/U, ECBDFR, CUSR0000SETE, CUUR0000SEHD, CUUR0000SEME, PCU524126524126, CPIAUCSL, CUSR0000SAH1, CPIUFDSL, CPIENGSL | DAILY / MONTHLY | D1 warehouse | vol desk, bootstrap macro, policy rates |
| Yahoo (warehouse) | none | ^GSPC ^NDX ^RUT ^VIX ^VXN ^VVIX ^MOVE ^GVZ ^OVX DX-Y.NYB GC=F SI=F CL=F KIE XLK XLF XLE XLV XLU XLI | DAILY + LATEST | D1 warehouse, 30–60 min | unofficial; exchange-tz date keying |
| Frankfurter (warehouse) | none | 8 USD pairs, 1 call | DAILY | D1 warehouse, 6 h | ECB reference rates |
| Workers AI | binding | analyst, ask, chat, sentiment | EVENT | none | Llama 3.1 8B |

Fixed in v2: `AUTOINS` pointed at `CUSR0000SETB` (CPI **motor fuel**) while labeled auto insurance; now
`CUSR0000SETE`. Home-page shelter/food/energy, the insurance table and the Fed/ECB rows now come from the
warehouse with source + month on every value.

Reference values that are **not** fetched (frozen in code, label as reference with an as-of
date or replace): `bootstrap.ts` RE shipping/insurance/central banks/calendar, `RE_PERIODS`,
CPI breakdown, `shipping.ts` indices and ports.
