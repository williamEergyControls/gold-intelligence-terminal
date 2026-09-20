import type { Env, Tf } from './types';
import { AppCache } from './cache';
import { buildBootstrap } from './bootstrap';
import { aiAnalyst, newsSentimentHourly } from './ai/analyst';
import { firstOk, persistHealthRows, ensureSecrets, secret } from './providers/provider';
import { trainAndStore, predictAndStore, gradeOutcomes } from './ml/pipeline';
import { buildEnergyPage, buildAgriPage } from './pages';
import * as yahoo from './providers/yahoo';
import * as metalsdev from './providers/metalsdev';
import * as goldapicom from './providers/goldapicom';
import * as goldapiio from './providers/goldapiio';
import * as sim from './providers/simulated';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
const TFS: Tf[] = ['5M', '15M', '1H', '1D', '1W'];

const hits = new Map<string, { n: number; w: number }>();
function allow(ip: string, max = 240, windowMs = 60_000): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.w > windowMs) { hits.set(ip, { n: 1, w: now }); return true; }
  h.n++;
  if (hits.size > 5000) hits.clear();
  return h.n <= max;
}

const qMemo = new Map<string, { v: any; ts: number }>();
function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const m = qMemo.get(key);
  if (m && Date.now() - m.ts < ttlMs) return Promise.resolve(m.v as T);
  return fn().then(v => { qMemo.set(key, { v, ts: Date.now() }); return v; });
}

function adminOk(req: Request, env: Env, url: URL): boolean {
  const t = secret(env, 'ADMIN_TOKEN');
  if (!t) return false;
  return req.headers.get('x-admin') === t || url.searchParams.get('key') === t;
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
          if (!adminOk(req, env, url)) return json({ error: 'ADMIN_LOCKED', hint: 'set ADMIN_TOKEN secret, then pass ?key=TOKEN' }, 403);
          const mk = (n: string) => { const v = secret(env, n); return v ? `SET (${v.length} chars)` : 'MISSING'; };
          return json({ METALS_API_KEY: mk('METALS_API_KEY'), FRED_API_KEY: mk('FRED_API_KEY'), GOLDAPI_KEY: mk('GOLDAPI_KEY'), EIA_API_KEY: mk('EIA_API_KEY'), ADMIN_TOKEN: mk('ADMIN_TOKEN'), aiEnabled: env.AI_ENABLED ?? 'MISSING', checkedAt: new Date().toISOString() });
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
        /* LIGHT quote poll — gold-api.com primary (free, no key, no limit) */
        case path === '/api/quote': {
          const out: any = { ts: Date.now() };
          try {
            const g = await goldapicom.goldapiComQuote('XAU:USD');
            const s = await goldapicom.goldapiComQuote('XAG:USD');
            out.gold = g.price; out.silver = s.price; out.source = 'gold-api.com';
          } catch {
            try {
              const g = await memo('q:gold', 60e3, () => yahoo.yahooQuote(env, 'XAU:USD'));
              const s = await memo('q:silver', 60e3, () => yahoo.yahooQuote(env, 'XAG:USD'));
              out.gold = g.price; out.silver = s.price; out.source = 'yahoo(unofficial)';
            } catch {
              const l = await metalsdev.metalsdevLatest(env); // quota-protected last resort
              out.gold = l.gold; out.silver = l.silver; out.source = 'metals.dev';
            }
          }
          const d = await memo('q:dxy', 60e3, () => yahoo.yahooQuote(env, 'DXY'));
          out.dxy = d.price; out.dxyPct = d.changePct ?? null;
          return json(out);
        }
        /* candles now accepts ?sym= (defaults XAU:USD — home page unchanged) */
        case path === '/api/candles': {
          const tf = parseTf(url.searchParams.get('tf'));
          const sym = url.searchParams.get('sym') ?? 'XAU:USD';
          const cache = new AppCache(env.CACHE);
          const r = await cache.wrap(`candles:${sym}:${tf}`, tf === '1D' ? 3600 : 300, () =>
            firstOk([
              { name: 'yahoo', fn: () => yahoo.yahooCandles(env, sym, tf) },
              { name: 'simulated', fn: () => Promise.resolve(sim.simCandles(sym, tf)) },
            ]).then(rr => ({ candles: rr.value, source: rr.provider === 'yahoo' ? 'yahoo(unofficial)' : 'simulated', delay: rr.provider === 'yahoo' ? 'near-live' : 'simulated', ts: Date.now() }))
          );
          return json({ tf, sym, ...r.v, stale: r.stale, ageMs: r.ageMs });
        }
        /* ===== EXPANSION PAGES ===== */
        case path === '/api/page/energy': {
          const cache = new AppCache(env.CACHE);
          const r = await cache.wrap('page:energy', 300, () => buildEnergyPage(env));
          return json(r.v);
        }
        case path === '/api/page/agri': {
          const cache = new AppCache(env.CACHE);
          const r = await cache.wrap('page:agri', 300, () => buildAgriPage(env));
          return json(r.v);
        }
        case path === '/api/ml/train': {
          if (!adminOk(req, env, url)) return json({ error: 'ADMIN_LOCKED', hint: 'set ADMIN_TOKEN secret, then pass ?key=TOKEN' }, 403);
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
          const b = await cachedBoot(env, '15M');
          return json(b.v.macro);
        }
        case path === '/api/news': {
          const b = await cachedBoot(env, '15M');
          return json(b.v.news);
        }
        case path === '/api/analytics':
        case path === '/api/why-gold': {
          const b = await cachedBoot(env, '15M');
          return json(path === '/api/analytics' ? b.v.analytics : { ...b.v.why, movePct: b.v.gold.changePct });
        }
        case path === '/api/ai/analyst': {
          const cachedAi = (await env.CACHE.get('ai:cache', 'json')) as any;
          if (cachedAi && Date.now() - cachedAi.ts < 600e3) return json(cachedAi);
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
          await env.CACHE.put('ai:cache', JSON.stringify(out), { expirationTtl: 1200 });
          return json(out);
        }
        default: return json({ error: 'UNKNOWN_ENDPOINT', endpoints: ['/api/health', '/api/bootstrap', '/api/quote', '/api/candles?sym=', '/api/page/energy', '/api/page/agri', '/api/ml', '/api/macro', '/api/news', '/api/analytics', '/api/why-gold', '/api/ai/analyst'] }, 404);
      }
    } catch (e) {
      return json({ error: 'UPSTREAM_FAILURE', detail: String((e as Error).message).slice(0, 300) }, 502);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    await ensureSecrets(env);
    const hourly = event.cron === '0 * * * *';

    // (1) warm site cache + history — every run
    ctx.waitUntil((async () => {
      try {
        const boot = await buildBootstrap(env, '15M');
        await new AppCache(env.CACHE).write('boot:15M', boot, 300);
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

    if (!hourly) return;

    // (1b) GoldAPI.io DAILY SEED — 2 calls/day, gated 20h (quota: ~100/mo)
    ctx.waitUntil((async () => {
      try {
        const last = await env.CACHE.get('goldio:last', 'json') as { t: number } | null;
        if (last && Date.now() - last.t < 20 * 36e5) return;
        const seed = await goldapiio.goldapiIoSeed(env);
        await env.CACHE.put('goldio:daily', JSON.stringify(seed), { expirationTtl: 172800 });
        await env.CACHE.put('goldio:last', JSON.stringify({ t: Date.now() }), { expirationTtl: 172800 });
      } catch (e) { console.error('GOLDIO_SEED_FAIL', String((e as Error).message).slice(0, 200)); }
    })());

    // (2) ML: retrain weekly, predict+grade (6h throttle)
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

    // (3) hourly Llama news sentiment
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
  return new AppCache(env.CACHE).wrap(`boot:${tf}`, 300, () => buildBootstrap(env, tf));
}
function parseTf(s: string | null): Tf { return TFS.includes(s as Tf) ? (s as Tf) : '15M'; }
function json(v: unknown, status = 200): Response { return new Response(JSON.stringify(v), { status, headers: JSON_HEADERS }); }
