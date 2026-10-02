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
| CoinGecko | none | stablecoins | NEAR-LIVE | none (browser-side) | move server-side (prompt v2 phase 2) |
| Workers AI | binding | analyst, ask, chat, sentiment | EVENT | none | Llama 3.1 8B |

Reference values that are **not** fetched (frozen in code, label as reference with an as-of
date or replace): `bootstrap.ts` RE shipping/insurance/central banks/calendar, `RE_PERIODS`,
CPI breakdown, `shipping.ts` indices and ports.
