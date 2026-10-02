# Build Prompt Review + v2

## A. Review of the original "lead full-stack engineer" prompt

**Keep (it's right):** inspect before changing, no rewrite, keys server-side only, never call
delayed data live, no fake zeros, source + unit + timestamp on every number, new USGS Water
Data API instead of legacy WaterServices, one JSON envelope for every endpoint.

**Fix (it will send an agent the wrong way):**

| # | Problem in the prompt | What actually applies to this repo |
|---|----------------------|-----------------------------------|
| 1 | Diagnosis says the deploy "stops after bun install" and tells the agent to check Pages build command, Vite, `dist/`, output directory | The log was cut short. Full log shows `npx wrangler deploy` ran and esbuild failed: `Unexpected "case"` at `src/worker/index.ts:51`. This is a **Worker + static assets** project (`wrangler.jsonc → assets.directory = ./public`). No framework, no build output dir, no Pages. An agent following the prompt may migrate it to Pages. |
| 2 | Assumes React / Vite / Next / Astro and a "React-compatible chart library" | Vanilla JS + hand-rolled canvas charts + one CSS design system (`public/css/terminal.css`). Adding React means rewriting every page. |
| 3 | 10 pages + dashboard + 6 API families + tests in one pass | Agents produce 10 thin pages that way. Phase it, one acceptance gate per phase. |
| 4 | Lists `USDA_MMN_API_KEY`, `USDA_NASS_API_KEY`, `USDA_ERS_API_KEY`, `COINGECKO_API_KEY`, `USGS_API_KEY` | Your Secrets Store has **FRED, EIA, GOLDAPI, METALS** only. Cattle (MMN), agriculture + land (NASS) are blocked until you register those free keys. USGS OGC and CoinGecko work keyless at low volume. |
| 5 | Keys go in "Workers & Pages > Settings > Environment variables" and `.env.example` | This repo binds keys from **Secrets Store** in `wrangler.jsonc → secrets_store_secrets`. A new key needs 3 edits: Secrets Store entry, binding in wrangler.jsonc, name in `SECRET_NAMES` (`src/worker/providers/provider.ts`). Wrangler never reads `.env`; local dev reads `.dev.vars`. |
| 6 | Routes `/markets/bonds` etc. | Static assets serve `public/markets/bonds.html` at `/markets/bonds` already (default html_handling). No router needed. Existing pages stay at `/gold.html` etc. |
| 7 | Doesn't say if new pages need login | Today every page and `/api/*` route except auth + health is behind the session gate. Decide: keep gated (recommended) or open specific read-only routes. |
| 8 | Cache TTL table ignores platform limits | KV Free = **1,000 writes/day**. Ten endpoints at 1-15 min TTL blows through that. Use the Cache API (`caches.default`, no write cap) for upstream responses, KV only for cross-isolate state, or move to Workers Paid. |
| 9 | Home dashboard pulls every source | Workers Free = **50 subrequests per request**. A fan-out dashboard fails silently. Dashboard must read cron-warmed cache only. |
| 10 | "Bond + MBS live" with no series IDs | FRED Treasuries are daily (prior business day). There is no free live MBS price. Give the agent exact series IDs (below) so it doesn't invent any. |
| 11 | River freight: "say unavailable if no free source" | USDA AMS **Grain Transportation Report** publishes weekly barge freight rates. That is a real, free, authoritative rate source. USACE WCSC is file downloads (CSV/Excel), not a JSON API: ingest monthly via cron into D1. |
| 12 | No mention of type-checking | esbuild never type-checks. The repo had 9 tsc errors that deploys didn't catch. Gate on `bun run build` (tsc + dry-run). |

## B. Prompt v2 (paste this)

```text
ROLE: senior engineer on an existing Cloudflare Worker. Do the work in the repo. No tutorials.

FACTS (verified, do not re-derive):
- Architecture: ONE Cloudflare Worker + static assets. wrangler.jsonc: main=src/worker/index.ts,
  assets.directory=./public. Deploy = `npx wrangler deploy` (Workers Builds, bun 1.2.15).
  There is NO framework, NO build output directory, NO Pages project. Do not add one.
- Frontend: vanilla JS in public/js/*.js, canvas charts, public/css/terminal.css design system
  (tokens --gold --up --dn --cyan --grid, .panel/.p-hd/.p-bd/.tb/.chip). No React. No new runtime deps.
- Router: flat if-chain in src/worker/index.ts. Never use switch/case there.
- Auth: every /api/* route except /api/auth/* and /api/health requires x-session. Admin routes
  are /api/admin/* and check role === 'admin'. New data routes go behind the session gate.
- Secrets: Cloudflare Secrets Store bindings (objects with .get()). Available today: FRED_API_KEY,
  EIA_API_KEY, GOLDAPI_KEY, METALS_API_KEY. To add a key: (1) create it in Secrets Store,
  (2) add to wrangler.jsonc secrets_store_secrets, (3) add the name to SECRET_NAMES in
  src/worker/providers/provider.ts. Read keys only via secret(env, NAME).
- Storage: D1 `gold-terminal` (binding DB), KV `CACHE`. Schema changes go in a new
  migrations/000N_*.sql AND in src/worker/schema.ts DDL (idempotent IF NOT EXISTS).
- Platform limits to design around: 50 subrequests/request and 10 ms CPU on Workers Free;
  KV 1,000 writes/day. Pages must read cron-warmed data, never fan out to upstreams per view.
  Use caches.default for raw upstream responses; KV only for small cross-isolate state.
- Admin console /admin.html probes every upstream live. Add each new upstream to
  PROBES in src/worker/admin/probes.ts so its health is visible on day one.

DATA RULES (hard):
- Every number carries source, unit, observation timestamp, frequency, geography.
- Never label delayed/periodic data "live". Use: LIVE (<1 min), NEAR-LIVE, DAILY, WEEKLY,
  MONTHLY, ANNUAL, LATEST RELEASE.
- Missing data renders "DATA TEMPORARILY UNAVAILABLE · source · last success · retrying".
  Never 0, never a fabricated series, never a simulated value without a SIMULATED label.
- Calculated values (spreads, ratios) are labeled CALC with their inputs.

API CONTRACT (all new endpoints):
{ "source": "FRED", "series": "DGS10", "retrievedAt": ISO, "dataTimestamp": ISO,
  "frequency": "daily", "unit": "percent", "geography": "US", "stale": false, "data": [...] }
Errors: HTTP 503 { "error": "DATA_TEMPORARILY_UNAVAILABLE", "source", "lastSuccess", "retrying": true }

PHASES — finish, test and report each before starting the next.

PHASE 1  Bonds + MBS  (keys available: FRED)
  Routes: /markets/bonds, /markets/mbs  → public/markets/bonds.html, mbs.html
  API: /api/markets/fred?series=ID[,ID]&range=1y   (allow-list of IDs below, cache 6h)
  Series: DGS3MO DGS6MO DGS1 DGS2 DGS5 DGS10 DGS20 DGS30 (daily, % , 1-day lag)
          MORTGAGE30US MORTGAGE15US (weekly, Freddie Mac PMMS)
          WSHOMCB (weekly, Fed MBS holdings, $mn)   OBMMIC30YF (daily, verify on FRED first)
          CALC: MORTGAGE30US − DGS10 spread (label CALC, weekly alignment)
  Show: current, previous, 1d/1w/1m change, yield curve (today vs 1m vs 1y ago), history chart.
  Gate: every value shows "Last updated YYYY-MM-DD HH:MM · FRED · <ID>".

PHASE 2  Stablecoins  (keyless CoinGecko; optional COINGECKO_API_KEY demo header)
  Move the existing browser-side CoinGecko calls in public/js/stable.js behind
  /api/markets/stablecoins (cache 5 min via caches.default). Coins: USDT USDC DAI USDe FDUSD PYUSD
  + top stablecoins by market cap from the API category. Price, mcap, 24h vol, 24h %, supply,
  rank, 30d chart, total stablecoin mcap, dominance bar.

PHASE 3  Water  (USGS Water Data OGC API, api.waterdata.usgs.gov/ogcapi/v0, keyless)
  Replace legacy waterservices.usgs.gov in src/worker/providers/water.ts.
  Collections: latest-continuous (current), continuous (7-day). Params 00060 discharge cfs,
  00065 gage height ft. Station list in a config array with state/river/basin.
  Gate: admin console probe `usgs-ogc` is ONLINE before you remove the legacy probe.

PHASE 4  Construction + Solar indicators  (FRED / BLS PPI, monthly)
  TTLCONS (construction spending), PPI construction materials and inputs (lumber, steel mill
  products, copper wire, cement, asphalt, diesel), silver/copper/aluminum from existing feeds.
  Title the solar page "MARKET INDICATORS", never "panel price". Verify every series ID on
  FRED before using it; drop any that 404 and list them in the report.

PHASE 5  River transport  (USDA AMS Grain Transportation Report weekly barge rates +
  USACE WCSC/LPMS monthly files ingested by cron into D1). Separate TRAFFIC / TONNAGE /
  COMMODITY / RATE. Annual/monthly stats are never shown as current prices.

PHASE 6  Agriculture, Cattle, Land  — BLOCKED until USDA_NASS_API_KEY and USDA_MMN_API_KEY
  exist in Secrets Store. Stop and report if missing. Do not build mock pages.

PHASE 7  Home dashboard cards for every finished page, reading cron-warmed cache only.

TEST GATE (every phase):
  bun install && bun run build            # tsc + wrangler dry-run must pass
  bun run db:migrate:local && bun run dev # hit every new route, check 200/503 shapes
  grep the built bundle and public/ for any key value or key name in client code
  open each page: loading state, data, timestamp, source, failure state (kill the upstream)
REPORT: files changed, endpoints, keys needed, live vs periodic table, limitations.
```
