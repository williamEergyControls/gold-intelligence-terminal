# Manual Setup

```bash
bun install                      # same toolchain as Workers Builds (bun 1.2.15)
bun run build                    # tsc --noEmit + wrangler deploy --dry-run
bun run db:migrate:local
bun run dev                      # http://127.0.0.1:8787
```

Cloudflare (Workers & Pages → gold-intelligence-terminal → Settings → Build):

| Setting | Value |
|---------|-------|
| Build command | `bun run build` (optional gate; empty also works) |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Output directory | none (Worker + static assets from `./public`) |

Bindings live in `wrangler.jsonc`: KV `CACHE`, D1 `DB` (gold-terminal), Workers AI `AI`,
Secrets Store keys `METALS_API_KEY`, `FRED_API_KEY`, `EIA_API_KEY`, `GOLDAPI_KEY`.
Remote migrations: `bun run db:migrate:remote`. Admin console: see `docs/ADMIN.md`.
