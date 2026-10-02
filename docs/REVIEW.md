# Code Review: gold-intelligence-terminal (2026-10-01)

Scope: every file in `src/worker`, `public/`, `migrations/`, `wrangler.jsonc`, `package.json`.
Toolchain matched to the Cloudflare build: bun 1.2.15, wrangler 4.145.0, node 24-compatible.

## 1. How the system runs (logic breakdown)

```
                 ┌──────────────── REQUEST CYCLE (every /api/* call) ────────────────┐
 browser ──x-session──▶ INIT                AUTH GATE            ROUTE              PUBLISH
                        ensureSecrets()  →  requireAuth()     →  if-chain        →  json()
                        ensureSchema()      401 if no session    /api/bootstrap      200 / 503
                        (once/isolate)      403 if not admin     /api/admin/*        no-store
                                            on /api/admin/*

                 ┌──────────────── CRON CYCLE ────────────────────────────────────────┐
  */5 * * * *  ──▶ POLL upstreams (buildBootstrap) → EVALUATE (failover chain)
                   → PUBLISH  KV boot:15M (ttl 300, KV keeps 30 min) + D1 price_snapshots
                              (live sources only) + D1 provider_health
                   → warm page:energy / page:agri (only when ≥ 14 min old)
  0 * * * *    ──▶ probes: one real request per free API → D1 api_probes
                   Llama news sentiment (1 AI call)
                   once/20h: GoldAPI.io seed (2 calls) + retention prune
                   ML last: predict ≤ every 6h, grade 5-day outcomes, retrain if model > 7d

 FAILOVER CHAIN (gold): gold-api.com → yahoo → metals.dev → stooq → simulated (labeled)
 CACHE: isolate memory → KV (6x ttl as stale fallback) → upstream. KV write failure is
        logged and the fresh value is still served (KV Free = 1,000 writes/day).
```

## 2. Build failure (the deploy log)

```
✘ [ERROR] Unexpected "case"
    src/worker/index.ts:51:0:
      51 │ case path === '/api/auth/register': {
```

Cause: a `case` label sitting outside any `switch` block. Someone started converting the
if-chain router to `switch (true) { case path === ...: }` and the `switch (true) {` opener
is missing (or a `}` closed it early). esbuild refuses to parse it, so `wrangler deploy`
dies before upload. Reproduced locally with the exact same message.

Fix: `src/worker/index.ts` replaced with a complete flat if-chain router. Do not merge
it line by line into the broken file. Replace the whole file.

Note: the Cloudflare prompt's theory ("deployment stops after bun install, check output
directory") is wrong for this repo. It is a Worker + static assets project. There is no
framework build and no output directory. The log simply got cut off before the error.

## 3. Findings, ranked

### Critical (fixed)

| # | Where | Defect | Effect | Fix |
|---|-------|--------|--------|-----|
| C1 | index.ts:51 (deployed copy) | `case` outside `switch` | build fails, nothing deploys | full router rewrite |
| C2 | provider.ts | `ensureSecrets()` defined but **never called**; list also missed `EIA_API_KEY`, `GOLDAPI_KEY` | every Secrets Store binding is an object with `.get()`, so `secret()` returned undefined for ALL keys. FRED, EIA, metals.dev, GoldAPI.io all reported "not configured"; macro silently fell back to simulated rows | called at top of `fetch()` and `scheduled()`, all 6 names, errors captured for the admin view |
| C3 | cache.ts `wrap()` | `kv.put()` inside the same try as the fetch | KV Free caps writes at 1,000/day. Once exhausted, every cache miss threw away a good upstream result and returned 502 when no stale copy existed. This matches the "bootstrap works sometimes" pattern better than Yahoo 429s alone | write failure is logged (`KV_WRITE_FAIL`), value still served from isolate memory |
| C4 | index.ts bootstrap (previous patch) | degraded object with `price: 0`, `mode: 'live'` was **cached** for 60s | one upstream blip overwrote the last good value with $0 gold labeled live | serve last good value labeled `stale`; if none exists return 503 `DATA_TEMPORARILY_UNAVAILABLE` + `Retry-After`; UI retries with backoff |
| C5 | migrations/0003_auth.sql | `users` table has **no `role` column** (schema.ts has it) | a DB built from migrations can never hold an admin; register INSERT fails | `ensureSchema()` adds the column if missing and promotes the earliest user only when zero admins exist |
| C6 | diagnostics.html + /api/admin/diagnostics | route did a full bootstrap build with no fallback; page dereferenced `d.worker.mode` on any error | any upstream hiccup = 502 = `TypeError` = blank admin page with a misleading "may need admin role" message | new admin console (`/admin.html`), diagnostics route reads cache only |

### High (fixed)

| # | Where | Defect | Fix |
|---|-------|--------|-----|
| H1 | providers/eia.ts | EIA API v1 `/series/` is retired; `eiaRows()` was never called (`eia: []` hardcoded in pages.ts); diesel ID was a NY Harbor spot daily series with a `.W` suffix | v2 `/v2/seriesid/{id}` route, wired into the energy page with its own 6h cache, retail diesel `PET.EMD_EPD2D_PTE_NUS_DPG.W` |
| H2 | providers/goldapiio.ts | seed never called (nothing wrote `goldio:daily`), path `/api/price/XAU/USD` instead of `/api/XAU/USD`, change fields are `ch`/`chp` | fixed path + fields, runs once/20h from the hourly cron (~60 calls/month) |
| H3 | ai/analyst.ts | `newsSentimentHourly()` never called | wired into hourly cron |
| H4 | index.ts cron | KV key typo `'age:agri'` | `'page:agri'` |
| H5 | index.ts cron | `boot:15M` written with ttl 30 → KV expiry 180s < 300s cron gap | ttl 300 → KV keeps 30 min, always a stale fallback |
| H6 | index.ts cron | simulated prices written to `price_snapshots` | only live sources are stored |
| H7 | bootstrap.ts | FRED failure fabricated a straight-line real-yield series (`1.7 - i*0.004`) and correlated gold against it | empty series, `corr.ry = null` |
| H8 | ml/pipeline.ts | `gradeOutcomes` used `min(len-1, idx+5)`: near the series end it graded on a 1-4 day window and stored that permanently | skip until a full 5-bar window exists |
| H9 | schema / migrations | `daily_bars` written by the ML pipeline but never declared | added to `ensureSchema` + `0004_admin.sql` |
| H10 | index.ts | public `/api/health` could trigger a full upstream build unauthenticated | read-only from KV |
| H11 | sessions | expired sessions never deleted, no retention anywhere | daily prune: snapshots 90d, probes 14d, expired sessions |
| H12 | tsc | 9 type errors (esbuild does not type-check, so deploys still passed) | clean; `bun run build` = tsc + dry-run |
| H13 | package.json | no lockfile committed (log: "Saved lockfile") so every build floats to the newest wrangler; `npm install` fails with a peer conflict (wrangler 4.145 wants workers-types ^5) | workers-types ^5, `bun.lock` included, commit it |

### Second pass (independent re-review of the patch, all fixed)

| # | Where | Defect | Fix |
|---|-------|--------|-----|
| R1 | index.ts `/api/quote` | gold page polls every 20s and overwrote the **spot** price (gold-api.com) with **GC=F futures**, then computed change vs a spot prevClose. Price jumped by the futures basis every poll | quote uses the same spot source as bootstrap, futures only as fallback |
| R2 | gold.html inline init, fx.js | on a first-load 503 the pollers never start (`!B`), page stuck until reload. `public/js/app.js` is dead code: no page loads it | backoff retry in the scripts that actually run (gold.html, fx.js, home.js) |
| R3 | agri.html | a second `PAGE_CONFIG` with `type:'argi'`, `api:'/api/page/argi'` overrode the real one: **agri page always 404'd**. agri/energy/fx also loaded their page script twice (content after `</html>`) | removed |
| R4 | hourly cron | ML first: on Workers Free a CPU-limit kill can't be caught, so probes, sentiment, GoldAPI seed and prune would never run | cheap steps first, ML last, `ml:last` stamped before training |
| R5 | cache.ts `read()` | isolate copy returned regardless of age, so a warm isolate ignored fresher cron-written KV and rebuilt against Yahoo | expired isolate copy → read KV, keep the newer one; cron writes `boot:15M` ttl 300 |
| R6 | cron page warm | `page:energy` + `page:agri` rewritten every 5 min = 576 KV writes/day of the 1,000 Free quota | rewrite only when ≥ 14 min old |
| R7 | cron provider_health | upsert overwrote last_success with NULL from a fresh isolate → working provider shown OFFLINE | MAX/COALESCE merge |
| R8 | `/api/candles` | cached simulated candles labeled `yahoo`; any 20-char `sym` accepted (cache/upstream amplification) | source cached with data, sim never cached, symbol allow-regex |
| R9 | bootstrap GoldAPI seed | seed is now real, but it applied a snapshot's bid/ask/OHLC next to a live price and a possibly day-old prevClose | prevClose only, only if seed taken after the last 22:00 UTC roll |
| R10 | schema.ts | role fix marked done even when it failed | retried up to 3x per isolate |
| R11 | forced probe throttle | per-isolate, two isolates could both spend quota | KV-stamped, shared |

### Medium (flagged, not changed)

- Static panel labels in `pages.js` / page HTML ("NEAR LIVE", "YAHOO (UNOFFICIAL)") don't switch when a panel falls back to simulated. The hero chip does switch.

- **Hardcoded "reference" numbers look live.** `bootstrap.ts RE` (FBX 3,842, BDI 1,984, VLSFO 612, Fed 3.75–4.00%, ECB, BOJ, PBOC), `RE_PERIODS`, CPI breakdown (SHELTER 4.2 etc.), `shipping.ts` indices and ports. They are labeled reference but they are frozen values from whenever the file was written. Either source them or show the as-of date in the UI.
- **Workers Free limits.** 50 subrequests per request: a cold bootstrap can exceed it (gold chain + 3 Yahoo daily + 18 miners x 2 Yahoo hosts + 12 sequential FRED + 3 GDELT). Extra `fetch()` calls throw and the chain silently drops to simulated. 10 ms CPU: ML training will not finish on Free. Workers Paid fixes both.
- **Token in query string.** `requireAuth` and `/api/auth/me` accept `?token=`. It ends up in logs and browser history. Header-only is safer.
- **Password compare** is `hash !== row.pass_hash` (not constant-time). Low risk at this scale.
- **Yahoo unofficial API** is the backbone for candles, miners, futures, ML inputs. No SLA, rate-limits under load.
- **CoinGecko is called from the browser** (stable.js). Every viewer hits CoinGecko directly, no caching.
- **USGS WaterServices** (legacy) is being retired. The admin console now probes both the legacy host and the new OGC API so you can see when to cut over.
- **ML pipeline** calls `loadInputs()` up to 3x per hourly run (train, predict, grade): 15 upstream calls where 5 would do.
- `persistQuotesAsBars()` is dead code. `docs/API_SOURCES.md` and `docs/MANUAL_SETUP.md` were empty.

## 4. Admin console (new)

`/admin.html` (link appears in the nav for admins on every page). Server enforces admin on
every `/api/admin/*` route; the page is only navigation.

| Tab | Source | What it shows |
|-----|--------|---------------|
| API LIVE | `GET /api/admin/apis?run=1` | one real request per upstream (13), HTTP code, latency, sample value, data timestamp, 24h uptime + latency sparkline from D1, secrets binding state, cron-persisted failover health. Quota APIs (metals.dev, GoldAPI.io, Workers AI) only on FORCE (1 per 5 min). Auto re-probe every 120s while visible, server throttles to 20s |
| ML ENGINE | `GET /api/admin/ml` | signal, regime, final score, live hit rate vs always-up baseline, walk-forward LR/GBS, P(up) history colored HIT/MISS/PENDING, rolling 20 hit rate, 7-day gold snapshots, agent votes, regime probabilities, Bayesian rounds, calibration buckets, hit rate by regime/direction, model history, daily_bars coverage. PREDICT / GRADE / RETRAIN buttons |
| DATABASE + KV | `GET /api/admin/db`, `/api/admin/kv` | D1 size (meta.size_after) vs 500 MB Free / 10 GB Paid, rows + approx payload per table, 24h growth, retention, PRUNE; KV key presence/age/fresh-vs-stale |
| USERS | `GET /api/admin/users` | role, created, last login, active sessions, failed attempts, lock. PROMOTE/DEMOTE (last admin protected), UNLOCK, REVOKE |

## 5. Verified

- `tsc --noEmit` clean, `wrangler deploy --dry-run` builds (135 KiB / 40 KiB gzip).
- `wrangler dev --local` with migrations 0001-0004: first user becomes admin through the
  ALTER path, operator gets 403 with role hint, last-admin demotion blocked, prune, KV, DB
  size, both cron handlers run without throwing.
- Live probes report real HTTP status and error text (sandbox egress blocked the hosts,
  which the probe surfaced correctly as `HTTP 403 · Host not in allowlist`).
- Admin console rendered night/day/mobile (390px, no horizontal page scroll), zero page errors.
- Smoke test of `/`, `/gold`, `/agri`, `/energy`, `/fx`, `/admin`, `/diagnostics` (redirect):
  zero page errors, every `/api/*` call 200, agri now hits `/api/page/agri`.
- A separate reviewer re-read the patch cold. Its 10 findings are the R-table above; all fixed and re-tested.
