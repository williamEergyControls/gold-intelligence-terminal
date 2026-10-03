# Admin Console + Deploy Steps

## Deploy this fix

1. Replace the repo contents with this folder (do not hand-merge `src/worker/index.ts`;
   the broken copy has a stray `case` label). Commit `bun.lock` too.
2. Push to GitHub. Workers Builds runs `bun install` then `npx wrangler deploy`.
   Optional: set the build command to `bun run build` so type errors block a deploy.
3. Apply the new migrations once (0004 admin, 0005 warehouse):
   `npx wrangler d1 migrations apply gold-terminal --remote`
   (the Worker also creates the same tables at runtime, so this is belt and braces).
4. Sign in, open `/admin.html` (ADMIN chip in the nav when your role is admin).
5. First hour after deploy: the warehouse backfills (≈ 5 ingest cycles, 50 min). Speed it up from
   Admin → DATABASE + KV → **RUN INGEST NOW** (click 4–5 times), then **REBUILD VOL SNAPSHOTS**.
   `/vol.html` shows WAREHOUSE WARMING until the first snapshots exist; nothing is simulated there.

## Make yourself admin

The first account is admin. If the `users` table came from `migrations/0003_auth.sql`
it had no `role` column; the Worker now adds it and promotes the earliest account only when
no admin exists. If a different account is admin, run in Cloudflare → D1 → gold-terminal → Console:

```sql
UPDATE users SET role = 'admin' WHERE name = 'YOUR_OPERATOR_NAME';
SELECT id, name, role FROM users;
```

Role is read on every request, so just reload. After that, promote/demote from the USERS tab.

## What "live" means on the API tab

Each row is a real HTTP request made by the Worker when you press RUN LIVE PROBE (or every
120 s while the tab is open, throttled to once per 20 s server-side). The hourly cron runs the
same probes for the 24h uptime/latency history. Quota APIs are skipped unless you press
FORCE QUOTA PROBES (max once per 5 min):

| API | Free quota | Why skipped by default |
|-----|-----------|------------------------|
| metals.dev | ~100 req/month | fallback #2 for gold, quota burns fast |
| GoldAPI.io | ~100 req/month | already called 2x/day by the cron seed |
| Workers AI | daily neuron allowance | costs neurons |

## Secrets

`SECRETS RESOLVED` must read 4/4. If a key shows `NO` with "not found", the name in the
Secrets Store does not match `secret_name` in `wrangler.jsonc`. If it shows `UNBOUND`, the
binding is missing from `wrangler.jsonc`.

## Admin API

| Method | Route | Purpose |
|--------|-------|---------|
| GET | /api/admin/apis[?run=1][&force=1] | probe results, 24h history, secrets, provider_health |
| GET | /api/admin/ml | snapshot, predictions + outcomes, stats, calibration, models, daily_bars |
| POST | /api/admin/ml/predict, /grade, /train | run ML steps now |
| GET | /api/admin/db | size, tables, rows, approx bytes, growth |
| POST | /api/admin/db/prune | retention now |
| GET | /api/admin/kv | cache keys, age, fresh/stale |
| GET | /api/admin/users | operators |
| POST | /api/admin/users/role, /unlock, /revoke | `{ id, role? }` |
| GET | /api/env | secret binding states (never values) |
| GET | /api/admin/storage | warehouse units, series coverage, errors, snapshot ages |
| POST | /api/admin/storage/ingest | one ingest cycle now (`{ keys?: [unitKey] }` to target units) |
| POST | /api/admin/storage/rebuild | `{ cls }` rebuild one vol class from stored data |
