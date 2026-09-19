import type { Env, Tf } from './types';
import { AppCache } from './cache';
import { buildBootstrap } from './bootstrap';
import { aiAnalyst, newsSentimentHourly } from './ai/analyst';
import { firstOk, persistHealthRows, ensureSecrets, secret } from './providers/provider';
import { trainAndStore, predictAndStore, gradeOutcomes } from './ml/pipeline';
import * as yahoo from './providers/yahoo';
import * as sim from './providers/simulated';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
const TFS: Tf[] = ['5M', '15M', '1H', '1D', '1W'];

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
    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
    if (!allow(ip)) return json({ error: 'RATE_LIMITED' }, 429);
    await ensureSecrets(env);

    try {
      switch (true) {
        case path === '/api/env': {
          const mk = (n: string) => { const v = secret(env, n); return v ? `SET (${v.length} chars)` : 'MISSING'; };
          return json({ METALS_API_KEY: mk('METALS_API_KEY'), FRED_API_KEY: mk('FRED_API_KEY'), aiEnabled: env.AI_ENABLED ?? 'MISSING', checkedAt: new Date().toISOString() });
        }
        case path === '/api/health': {
          const boot = await cachedBoot(env, '15M');
          return json({ mode: boot.v.mode, builtAt: boot.v.builtAt, stale: boot.stale, providers: boot.v.health });
        }
        case path === '/api/bootstrap': {
          const tf = parseTf(url.searchParams.get('tf'));
          const boot = await cachedBoot(env, tf);
          return json(boot.v);
        }
        case path === '/api/candles': {
          // LIGHT endpoint: fetches ONLY candles — no full bootstrap. Fixes hero stats + speed.
          const tf = parseTf(url.searchParams.get('tf'));
          const cache = new AppCache(env.CACHE);
          const r = await cache.wrap(`candles:XAU:${tf}`, tf === '1D' ? 3600 : 120, () =>
            firstOk([
              { name: 'yahoo', fn: () => yahoo.yahooCandles(env, 'XAU:USD', tf) },
              { name: 'simulated', fn: () => Promise.resolve(sim.simCandles('XAU:USD', tf)) },
            ]).then(rr => ({ candles: rr.value, source: rr.provider === 'yahoo' ? 'yahoo(unofficial)' : 'simulated', delay: rr.provider === 'yahoo' ? 'near-live' : 'simulated', ts: Date.now() }))
          );
          return json({ tf, ...r.v, stale: r.stale, ageMs: r.ageMs });
        }
        case path === '/api/ml/train': {
          const tr = await trainAndStore(env);
          await predictAndStore(env);
          return json(tr);
        }
        case path === '/api/ml': {
          const raw = await env.CACHE.get('ml:snap', 'json');
          if (raw) return json(raw);
          return json({ status: 'WARMING', note: 'first predictions appear within ~5 minutes of cron' });
        }
        case path === '/api/macro': {
          const cache = new AppCache(env.CACHE);
          const r = await cache.wrap('macro', 21600, async () => (await buildBootstrap(env, '15M')).macro);
          return json(r.v);
        }
        case path === '/api/news': {
          const cache = new AppCache(env.CACHE);
          const r = await cache.wrap('news', 3600, async () => (await buildBootstrap(env, '15M')).news);
          return json(r.v);
        }
        case path === '/api/analytics':
        case path === '/api/why-gold': {
          const b = await cachedBoot(env, '15M');
          return json(path === '/api/analytics' ? b.v.analytics : { ...b.v.why, movePct: b.v.gold.changePct });
        }
        case path === '/api/ai/analyst': {
          const b = await cachedBoot(env, parseTf(url.searchParams.get('tf')));
          const out = await aiAnalyst(env, b.v.analytics, b.v.why, {
            ml: (b.v as any).ml ?? null,
            dxy: b.v.dxy.changePct,
            realYield: b.v.why.drivers[0]?.delta,
            newsSentiment: {
              bull: b.v.news.gold.filter(n => n.sentiment === 'bull').length,
              bear: b.v.news.gold.filter(n => n.sentiment === 'bear').length,
            },
          });
          return json(out);
        }
        default: return json({ error: 'UNKNOWN_ENDPOINT', endpoints: ['/api/env', '/api/health', '/api/bootstrap', '/api/candles', '/api/ml', '/api/ml/train', '/api/macro', '/api/news', '/api/analytics', '/api/why-gold', '/api/ai/analyst'] }, 404);
      }
    } catch (e) {
      return json({ error: 'UPSTREAM_FAILURE', detail: String((e as Error).message).slice(0, 300) }, 502);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    await ensureSecrets(env);

    // (1) warm site cache + write history
    ctx.waitUntil((async () => {
      try {
        const boot = await buildBootstrap(env, '15M');
        await new AppCache(env.CACHE).write('boot:15M', boot, 30);
        await env.DB.prepare('INSERT OR REPLACE INTO price_snapshots(ts,symbol,price,source) VALUES(?,?,?,?)')
          .bind(Date.now(), 'XAU:USD', boot.gold.price, boot.gold.source).run();
        for (const h of persistHealthRows()) {
          await env.DB.prepare('INSERT INTO provider_health(provider,last_success,last_failure,latency_ms,status) VALUES(?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET last_success=excluded.last_success,last_failure=excluded.last_failure,latency_ms=excluded.latency_ms,status=excluded.status')
            .bind(h.provider, h.last_success, h.last_failure, h.latency_ms, h.status).run();
        }
        const day = new Date().toISOString().slice(0, 10);
        const cur = await env.CACHE.get('prevday:XAU:USD', 'json') as { d: string; c: number } | null;
        if (cur && cur.d !== day) await env.CACHE.put('prevclose:XAU:USD', JSON.stringify({ c: cur.c }), { expirationTtl: 259200 });
        await env.CACHE.put('prevday:XAU:USD', JSON.stringify({ d: day, c: boot.gold.price }), { expirationTtl: 259200 });
      } catch (e) { console.error('CRON_SITE_FAIL', String((e as Error).message).slice(0, 300)); }
    })());

    // (2) ML: retrain weekly, predict+grade at most every 6h
    ctx.waitUntil((async () => {
      try {
        const lastMl = await env.CACHE.get('ml:last', 'json') as { t: number } | null;
        if (lastMl && Date.now() - lastMl.t < 6 * 36e5) return;
        let mlOk = true;
        const last = await env.DB.prepare('SELECT MAX(trained_at) t FROM ml_models WHERE active=1').first<{ t: number | null }>();
        if (!last?.t || Date.now() - last.t > 7 * 864e5) {
          const tr = await trainAndStore(env);
          if (!tr.ok) { mlOk = false; console.error('ML_TRAIN_FAIL', tr.error); }
        }
        await predictAndStore(env);
        await gradeOutcomes(env);
        if (mlOk) await env.CACHE.put('ml:last', JSON.stringify({ t: Date.now() }), { expirationTtl: 86400 });
      } catch (e) { console.error('ML_CRON_FAIL', String((e as Error).message).slice(0, 300)); }
    })());

    // (3) HOURLY Llama news sentiment — ~1 AI call/hour, free quota
    ctx.waitUntil((async () => {
      try {
        const lastNse = await env.CACHE.get('nse:last', 'json') as { t: number } | null;
        if (lastNse && Date.now() - lastNse.t < 36e5) return;
        await newsSentimentHourly(env);
        await env.CACHE.put('nse:last', JSON.stringify({ t: Date.now() }), { expirationTtl: 86400 });
      } catch { /* never breaks the site */ }
    })());
  },
};

async function cachedBoot(env: Env, tf: Tf) {
  return new AppCache(env.CACHE).wrap(`boot:${tf}`, 30, () => buildBootstrap(env, tf));
}
function parseTf(s: string | null): Tf { return TFS.includes(s as Tf) ? (s as Tf) : '15M'; }
function json(v: unknown, status = 200): Response { return new Response(JSON.stringify(v), { status, headers: JSON_HEADERS }); }
