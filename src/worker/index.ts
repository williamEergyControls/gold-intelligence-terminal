import type { Bootstrap, Env, Tf } from './types';
import { AppCache } from './cache';
import { buildBootstrap } from './bootstrap';
import { aiAnalyst } from './ai/analyst';
import { persistHealthRows } from './providers/provider';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
const TFS: Tf[] = ['5M', '15M', '1H', '1D', '1W'];

// ---- per-isolate rate limiter: protects against runaway frontend loops.
// Real abuse protection = a WAF rate rule in the Cloudflare dash (see MANUAL_SETUP §C7). ----
const hits = new Map<string, { n: number; w: number }>();
function allow(ip: string, max = 240, windowMs = 60_000): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.w > windowMs) { hits.set(ip, { n: 1, w: now }); return true; }
  h.n++;
  return h.n <= max;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 }); // assets handled by CF
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
    if (!allow(ip)) return json({ error: 'RATE_LIMITED' }, 429);

    try {
      switch (true) {
        case path === '/api/health': {
          const tf: Tf = '15M';
          const boot = await cachedBoot(env, tf);
          return json({ mode: boot.v.mode, builtAt: boot.v.builtAt, stale: boot.stale, providers: boot.v.health });
        }
        case path === '/api/bootstrap': {
          const tf = parseTf(url.searchParams.get('tf'));
          const boot = await cachedBoot(env, tf);
          return json(boot.v);
        }
        case path === '/api/candles': {
          const tf = parseTf(url.searchParams.get('tf'));
          const cache = new AppCache(env.CACHE);
          const r = await cache.wrap(`candles:XAU:${tf}`, 120, async () => {
            const b = await buildBootstrap(env, tf);
            return { candles: b.candles, source: b.gold.source, delay: b.gold.delay, ts: b.builtAt };
          });
          return json({ tf, ...r.v, stale: r.stale, ageMs: r.ageMs });
        }
        case path === '/api/macro': {
          const cache = new AppCache(env.CACHE);
          const r = await cache.wrap('macro', 21600, async () => (await buildBootstrap(env, '15M')).macro);
          return json(r.v);
        }
        case path === '/api/news': {
          const cache = new AppCache(env.CACHE);
          const r = await cache.wrap('news', 300, async () => (await buildBootstrap(env, '15M')).news);
          return json(r.v);
        }
        case path === '/api/analytics':
        case path === '/api/why-gold': {
          const b = await cachedBoot(env, '15M');
          return json(path === '/api/analytics' ? b.v.analytics : { ...b.v.why, movePct: b.v.gold.changePct }));
        }
        case path === '/api/ai/analyst': {
          // AI is ON-DEMAND only (user clicks RUN) — never per-visitor, never in cron.
          const b = await cachedBoot(env, parseTf(url.searchParams.get('tf')));
          const out = await aiAnalyst(env, b.v.analytics, b.v.why, {
            dxy: b.v.dxy.changePct, realYield: b.v.why.drivers[0]?.delta, newsSentiment: {
              bull: b.v.news.gold.filter(n => n.sentiment === 'bull').length,
              bear: b.v.news.gold.filter(n => n.sentiment === 'bear').length,
            },
          });
          return json(out);
        }
        default: return json({ error: 'UNKNOWN_ENDPOINT', endpoints: ['/api/health', '/api/bootstrap', '/api/candles', '/api/macro', '/api/news', '/api/analytics', '/api/why-gold', '/api/ai/analyst'] }, 404);
      }
    } catch (e) {
      return json({ error: 'UPSTREAM_FAILURE', detail: String((e as Error).message).slice(0, 300) }, 502);
    }
  },

  // ---- CRON: the ONLY steady-state upstream caller. Warms KV + persists history. ----
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      try {
        const boot = await buildBootstrap(env, '15M');
        await new AppCache(env.CACHE).write('boot:15M', boot, 30);
        // D1: 1 snapshot / run + provider health upserts (≈2k writes/day — far under the 100k free cap)
        await env.DB.prepare('INSERT OR REPLACE INTO price_snapshots(ts,symbol,price,source) VALUES(?,?,?,?)')
          .bind(Date.now(), 'XAU:USD', boot.gold.price, boot.gold.source).run();
        for (const h of persistHealthRows()) {
          await env.DB.prepare('INSERT INTO provider_health(provider,last_success,last_failure,latency_ms,status) VALUES(?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET last_success=excluded.last_success,last_failure=excluded.last_failure,latency_ms=excluded.latency_ms,status=excluded.status')
            .bind(h.provider, h.last_success, h.last_failure, h.latency_ms, h.status).run();
        }
        // previous-day close roll (used when metals.dev gives no prevClose)
        const day = new Date().toISOString().slice(0, 10);
        const cur = await env.CACHE.get('prevday:XAU:USD', 'json') as { d: string; c: number } | null;
        if (cur && cur.d !== day) await env.CACHE.put('prevclose:XAU:USD', JSON.stringify({ c: cur.c }), { expirationTtl: 259200 });
        await env.CACHE.put('prevday:XAU:USD', JSON.stringify({ d: day, c: boot.gold.price }), { expirationTtl: 259200 });
      } catch { /* cron failures are non-fatal; users still read last warm KV */ }
    })());
  },
};

async function cachedBoot(env: Env, tf: Tf) {
  return new AppCache(env.CACHE).wrap(`boot:${tf}`, 30, () => buildBootstrap(env, tf));
}
function parseTf(s: string | null): Tf { return TFS.includes(s as Tf) ? (s as Tf) : '15M'; }
function json(v: unknown, status = 200): Response { return new Response(JSON.stringify(v), { status, headers: JSON_HEADERS }); }
