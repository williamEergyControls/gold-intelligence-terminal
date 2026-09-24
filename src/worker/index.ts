import type { Env, Tf } from './types';
import { AppCache, K } from './cache';
import { buildBootstrap, getCandles } from './bootstrap';
import { aiAnalyst } from './ai/analyst';
import { agentChat } from './ai/chat';
import { persistHealthRows } from './providers/provider';
import { ensureSchema } from './schema';
import { mlTick, mlStatus, ML_CRON } from './ml/pipeline';
import { authRegister, authLogin, authVerify, authLogout, requireAuth } from './auth';
import { buildEnergyPage, buildAgriPage } from './pages';
import * as yahoo from './providers/yahoo';
import * as sim from './providers/simulated';

const JH = { 'content-type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
const TFS: Tf[] = ['5M', '15M', '1H', '1D', '1W'];
const hits = new Map<string, { n: number; w: number }>();
const qMemo = new Map<string, { v: any; ts: number }>();

function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const h = hits.get(key);
  if (!h || now - h.w > windowMs) { hits.set(key, { n: 1, w: now }); return true; }
  h.n++;
  return h.n <= max;
}
function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const m = qMemo.get(key);
  if (m && Date.now() - m.ts < ttlMs) return Promise.resolve(m.v as T);
  return fn().then(v => { qMemo.set(key, { v, ts: Date.now() }); return v; });
}
async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}
function json(v: unknown, status: number): Response {
  return new Response(JSON.stringify(v), { status, headers: JH });
}
async function cachedBoot(env: Env, tf: Tf) {
  return new AppCache(env.CACHE).wrap(K('boot:' + tf), 30, () => buildBootstrap(env, tf), { persist: false });
}
function parseTf(s: string | null): Tf { return TFS.includes(s as Tf) ? (s as Tf) : '15M'; }

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
    if (!allow(ip, 240, 60000)) return json({ error: 'RATE_LIMITED' }, 429);

    try {
      await ensureSchema(env).catch(() => {});

      // ===================== PUBLIC ROUTES =====================
      if (path === '/api/auth/register' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await authRegister(env, String(b.name || ''), String(b.password || ''));
        return r.ok ? json({ ok: true, token: r.token, name: r.name, role: r.role }, 200) : json({ error: r.error }, 400);
      }
      if (path === '/api/auth/login' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await authLogin(env, String(b.name || ''), String(b.password || ''));
        return r.ok ? json({ ok: true, token: r.token, name: r.name, role: r.role }, 200) : json({ error: r.error }, 401);
      }
      if (path === '/api/auth/logout' && req.method === 'POST') {
        const b = await readBody(req);
        await authLogout(env, String(b.token || ''));
        return json({ ok: true }, 200);
      }
      if (path === '/api/auth/me') {
        const t = req.headers.get('x-session') || url.searchParams.get('token') || '';
        const r = await authVerify(env, t);
        return json(r.valid ? { valid: true, name: r.name, role: r.role } : { valid: false }, 200);
      }
      if (path === '/api/health') {
        const boot = await cachedBoot(env, '15M');
        return json({ mode: boot.v.mode, builtAt: boot.v.builtAt, stale: boot.stale, providers: boot.v.health }, 200);
      }

      // ===================== AUTH REQUIRED =====================
      const auth = await requireAuth(req, env);
      if (!auth.valid) return json({ error: 'UNAUTHORIZED', hint: 'sign in first' }, 401);

      if (path === '/api/bootstrap') {
        const boot = await cachedBoot(env, parseTf(url.searchParams.get('tf')));
        return json(boot.v, 200);
      }
      if (path === '/api/candles') {
        const tf = parseTf(url.searchParams.get('tf'));
        const c = await getCandles(env, tf);
        return json({ tf, candles: c.candles, source: c.source, delay: c.source === 'simulated' ? 'simulated' : 'near-live', ts: Date.now() - c.ageMs, stale: c.stale, ageMs: c.ageMs }, 200);
      }
      if (path === '/api/quote') {
        const out: any = { ts: Date.now() };
        try {
          const g = await memo('q:gold', 60000, () => yahoo.yahooQuote(env, 'XAU:USD'));
          out.gold = g.price; out.goldPct = g.changePct; out.source = g.source;
        } catch { out.gold = null; }
        try {
          const d = await memo('q:dxy', 60000, () => yahoo.yahooQuote(env, 'DXY'));
          out.dxy = d.price; out.dxyPct = d.changePct;
        } catch { out.dxy = null; }
        return json(out, 200);
      }
      if (path === '/api/page/energy') {
        const c = new AppCache(env.CACHE);
        const r = await c.wrap(K('page:energy'), 900, () => buildEnergyPage(env));
        return json(r.v, 200);
      }
      if (path === '/api/page/agri') {
        const c = new AppCache(env.CACHE);
        const r = await c.wrap(K('page:agri'), 900, () => buildAgriPage(env));
        return json(r.v, 200);
      }
      if (path === '/api/page/shipping') {
        const c = new AppCache(env.CACHE);
        const r = await c.wrap(K('page:shipping'), 900, async () => {
          try {
            const shp = await import('./providers/shipping');
            return await shp.buildShippingPanel(env);
          } catch (e: any) {
            return { futures: [], indices: [], ports: [], sea: null, news: [], builtAt: Date.now() };
          }
        });
        return json(r.v, 200);
      }
      if (path === '/api/watch') {
        const syms = (url.searchParams.get('syms') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 12);
        if (!syms.length) return json({ quotes: [] }, 200);
        const c = new AppCache(env.CACHE);
        const r = await c.wrap(K('watch:' + syms.join(',')), 120, () => yahoo.yahooBatchQuotes(syms).catch(() => sim.simQuotes(syms)));
        return json({ quotes: r.v }, 200);
      }
      if (path === '/api/macro') return json((await cachedBoot(env, '15M')).v.macro, 200);
      if (path === '/api/news') return json((await cachedBoot(env, '15M')).v.news, 200);
      if (path === '/api/analytics') return json((await cachedBoot(env, '15M')).v.analytics, 200);
      if (path === '/api/why-gold') {
        const b = await cachedBoot(env, '15M');
        return json({ ...b.v.why, movePct: b.v.gold.changePct }, 200);
      }
      if (path === '/api/ml') return json(await mlStatus(env), 200);
      if (path === '/api/ai/analyst') {
        if (!allow('ai:' + ip, 6, 60000)) return json({ error: 'RATE_LIMITED' }, 429);
        const b = await cachedBoot(env, parseTf(url.searchParams.get('tf')));
        const ry = b.v.why.drivers.find(d => d.name.startsWith('REAL YIELD'));
        const out = await aiAnalyst(env, b.v.analytics, b.v.why, {
          mode: b.v.mode, stale: b.stale,
          dxyPct: b.v.dxy.changePct, realYield10yChg: ry?.delta ?? null,
          newsSentiment: {
            bull: b.v.news.gold.filter(n => n.sentiment === 'bull').length,
            bear: b.v.news.gold.filter(n => n.sentiment === 'bear').length,
          },
        });
        return json(out, 200);
      }
      if (path === '/api/ai/chat') {
        if (req.method !== 'POST') return json({ error: 'POST_ONLY' }, 405);
        if (!allow('ai:' + ip, 6, 60000)) return json({ error: 'RATE_LIMITED' }, 429);
        const body = await readBody(req);
        const boot = await cachedBoot(env, '15M');
        return json(await agentChat(env, body?.messages, boot.v, boot.stale), 200);
      }
      if (path === '/api/ai/ask') {
        if (req.method !== 'POST') return json({ error: 'POST_ONLY' }, 405);
        if (!allow('ai:' + ip, 6, 60000)) return json({ error: 'RATE_LIMITED' }, 429);
        const b = await readBody(req);
        const q = String(b.question || '').slice(0, 500);
        if (!q) return json({ error: 'ENTER A QUESTION' }, 400);
        const boot = await cachedBoot(env, '1D');
        const ml = await env.CACHE.get(K('ml:snap'), 'json');
        const ctx = {
          gold: { price: boot.v.gold.price, change: boot.v.gold.changePct },
          silver: { price: boot.v.silver.price },
          dxy: { price: boot.v.dxy.price, change: boot.v.dxy.changePct },
          macro: boot.v.macro.rows.slice(0, 10),
          analytics: boot.v.analytics, why: boot.v.why, ml: ml,
          newsSummary: {
            bull: (boot.v.news.gold || []).filter((n: any) => n.sentiment === 'bull').length,
            bear: (boot.v.news.gold || []).filter((n: any) => n.sentiment === 'bear').length,
            top: (boot.v.news.gold || []).slice(0, 5).map((n: any) => n.title),
          },
          question: q,
        };
        const SYS = 'You are a senior gold market analyst. Use ONLY the numbers provided. Be direct. Reference exact figures. Max 10 lines. End with: NOT FINANCIAL ADVICE.';
        try {
          const res: any = await env.AI!.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [{ role: 'system', content: SYS }, { role: 'user', content: JSON.stringify(ctx) }],
            max_tokens: 500, temperature: 0.3,
          });
          return json({ ok: true, answer: String(res?.response || '').trim(), engine: 'llama-3.1-8b', ts: Date.now() }, 200);
        } catch {
          return json({ ok: true, answer: 'Gold ' + (boot.v.gold.changePct >= 0 ? 'up' : 'down') + ' ' + Math.abs(boot.v.gold.changePct || 0).toFixed(2) + '% at $' + boot.v.gold.price + '. ' + (boot.v.why.drivers[0]?.name || '') + ' ' + (boot.v.why.drivers[0]?.delta || '') + '. NOT FINANCIAL ADVICE.', engine: 'fallback', ts: Date.now() }, 200);
        }
      }
      if (path === '/api/search') {
        const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 100);
        if (!q || q.length < 2) return json({ results: [] }, 200);
        const results: any[] = [];
        const PAGES = [
          { t: 'Gold Terminal', u: '/gold.html', k: 'gold xau price chart why miners heatmap' },
          { t: 'Energy Terminal', u: '/energy.html', k: 'energy oil wti brent natural gas eia' },
          { t: 'Agri Terminal', u: '/agri.html', k: 'agri corn wheat soybean cattle water usda' },
          { t: 'FX Terminal', u: '/fx.html', k: 'fx forex dollar dxy euro currency' },
          { t: 'Water Terminal', u: '/water.html', k: 'water drought river usgs nq' },
          { t: 'Land Terminal', u: '/land.html', k: 'land farm acre rent usda' },
          { t: 'Stablecoin Terminal', u: '/stable.html', k: 'stablecoin tether usdt crypto peg' },
          { t: 'Shipping Terminal', u: '/shipping.html', k: 'shipping freight port baltic suez' },
          { t: 'AI Analysis', u: '/ai.html', k: 'ai analyst ml question deep' },
        ];
        for (const p of PAGES) {
          if (p.t.toLowerCase().includes(q) || p.k.includes(q)) results.push({ type: 'PAGE', title: p.t, url: p.u, source: 'NAV' });
        }
        try {
          const b = await cachedBoot(env, '15M');
          const all = [...(b.v.news.gold || []), ...(b.v.news.mining || []), ...(b.v.news.macro || [])];
          for (const n of all) {
            if (n.title && n.title.toLowerCase().includes(q)) results.push({ type: 'NEWS', title: n.title, url: n.url, source: n.source });
            if (results.length > 15) break;
          }
        } catch { }
        return json({ results: results.slice(0, 15) }, 200);
      }

      // ===================== ADMIN ONLY =====================
      if (auth.role !== 'admin') return json({ error: 'FORBIDDEN' }, 403);
      if (path === '/api/env') {
        const mk = (n: string) => { const v = (env as any)[n]; return v ? 'SET' : 'MISSING'; };
        return json({ METALS_API_KEY: mk('METALS_API_KEY'), FRED_API_KEY: mk('FRED_API_KEY'), ADMIN_TOKEN: mk('ADMIN_TOKEN') }, 200);
      }
      if (path === '/api/ml/train') {
        const tr = await (await import('./ml/pipeline')).trainAndStore(env);
        return json(tr, 200);
      }
      if (path === '/api/admin/diagnostics') {
        const b = await cachedBoot(env, '15M');
        const ml = await env.CACHE.get(K('ml:snap'), 'json');
        const models = await env.DB.prepare('SELECT id, name, trained_at, active FROM ml_models ORDER BY id DESC LIMIT 5').all();
        const pc = await env.DB.prepare('SELECT COUNT(*) as n FROM predictions').first();
        const oc = await env.DB.prepare('SELECT COUNT(*) as n, SUM(correct) as c FROM prediction_outcomes').first();
        const uc = await env.DB.prepare('SELECT COUNT(*) as n FROM users').first();
        const sc = await env.DB.prepare('SELECT COUNT(*) as n FROM sessions WHERE expires_at > ?').bind(Date.now()).first();
        return json({
          worker: { mode: b.v.mode, builtAt: b.v.builtAt, providers: b.v.health },
          ml: { models: models.results, predictions: pc?.n ?? 0, graded: oc?.n ?? 0, accuracy: oc?.n > 0 ? ((oc?.c ?? 0) / oc.n * 100).toFixed(1) + '%' : 'PENDING', signal: ml ? { dir: ml.direction, p: ml.p, regime: ml.regime?.state } : null },
          auth: { users: uc?.n ?? 0, sessions: sc?.n ?? 0 },
          dataFlow: {
            gold: 'yahoo > metals.dev (guarded) > stooq > sim',
            news: 'GDELT > keyword sentiment',
            macro: 'FRED (CPI/PCE/PPI/SOFR/EFFR/yields)',
            energy: 'Yahoo futures + EIA weekly',
            agri: 'Yahoo futures + USGS + Open-Meteo',
            shipping: 'Yahoo futures + indices + marine',
            stable: 'CoinGecko live',
            ml: '*/15 cron step machine',
          },
        }, 200);
      }

      return json({ error: 'UNKNOWN_ENDPOINT' }, 404);
    } catch (e) {
      return json({ error: 'UPSTREAM_FAILURE', detail: String((e as Error).message).slice(0, 300) }, 502);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === ML_CRON) {
      ctx.waitUntil(mlTick(env).catch(() => { }));
      return;
    }
    ctx.waitUntil((async () => {
      try {
        await ensureSchema(env).catch(() => { });
        const boot = await buildBootstrap(env, '15M');
        await new AppCache(env.CACHE).write(K('boot:15M'), boot, 30);
        const stmts = [
          env.DB.prepare('INSERT OR REPLACE INTO price_snapshots(ts,symbol,price,source) VALUES(?,?,?,?)')
            .bind(Date.now(), 'XAU:USD', boot.gold.price, boot.gold.source),
          ...persistHealthRows().map(h => env.DB.prepare('INSERT INTO provider_health(provider,last_success,last_failure,latency_ms,status) VALUES(?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET last_success=excluded.last_success,last_failure=excluded.last_failure,latency_ms=excluded.latency_ms,status=excluded.status')
            .bind(h.provider, h.last_success, h.last_failure, h.latency_ms, h.status)),
        ];
        await env.DB.batch(stmts);
        // warm the expansion pages
        try {
          const c = new AppCache(env.CACHE);
          await c.write(K('page:energy'), await buildEnergyPage(env), 900);
          await c.write(K('page:agri'), await buildAgriPage(env), 900);
        } catch { }
      } catch (e) { console.error('cron warm failed', String((e as Error)?.message ?? e)); }
    })());
  },
};
