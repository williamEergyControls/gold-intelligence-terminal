import type { Env, Tf } from './types';
import { AppCache } from './cache';
import { buildBootstrap } from './bootstrap';
import { aiAnalyst, newsSentimentHourly } from './ai/analyst';
import { firstOk, persistHealthRows, ensureSecrets, secret } from './providers/provider';
import { trainAndStore, predictAndStore, gradeOutcomes } from './ml/pipeline';
import { buildEnergyPage, buildAgriPage } from './pages';
import { authRegister, authLogin, authVerify, authLogout, requireAuth } from './auth';
import * as yahoo from './providers/yahoo';
import * as metalsdev from './providers/metalsdev';
import * as goldapicom from './providers/goldapicom';
import * as sim from './providers/simulated';

const JH = { 'content-type': 'application/json; charset=utf-8' };
const TFS: Tf[] = ['5M', '15M', '1H', '1D', '1W'];
const hits = new Map<string, { n: number; w: number }>();
const qMemo = new Map<string, { v: any; ts: number }>();

function allow(ip: string): boolean {
  const now = Date.now(); const h = hits.get(ip);
  if (!h || now - h.w > 60000) { hits.set(ip, { n: 1, w: now }); return true; }
  h.n++; if (hits.size > 5000) hits.clear(); return h.n <= 240;
}
function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const m = qMemo.get(key);
  if (m && Date.now() - m.ts < ttlMs) return Promise.resolve(m.v as T);
  return fn().then(v => { qMemo.set(key, { v, ts: Date.now() }); return v; });
}
async function readBody(req: Request): Promise<any> { try { return await req.json(); } catch { return {}; } }
function json(v: unknown, status = 200): Response { return new Response(JSON.stringify(v), { status, headers: JH }); }
async function cachedBoot(env: Env, tf: Tf) { return new AppCache(env.CACHE).wrap('boot:' + tf, 300, () => buildBootstrap(env, tf)); }
function parseTf(s: string | null): Tf { return TFS.includes(s as Tf) ? (s as Tf) : '15M'; }

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url); const path = url.pathname;
    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
    if (!allow(ip)) return json({ error: 'RATE_LIMITED' }, 429);
    await ensureSecrets(env);
    try {
      if (path === '/api/auth/register' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await authRegister(env, String(b.name || ''), String(b.password || ''));
        return r.ok ? json({ ok: true, token: r.token, name: r.name, role: r.role }) : json({ error: r.error }, 400);
      }
      if (path === '/api/auth/login' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await authLogin(env, String(b.name || ''), String(b.password || ''));
        return r.ok ? json({ ok: true, token: r.token, name: r.name, role: r.role }) : json({ error: r.error }, 401);
      }
      if (path === '/api/auth/logout' && req.method === 'POST') {
        const b = await readBody(req); await authLogout(env, String(b.token || '')); return json({ ok: true });
      }
      if (path === '/api/auth/me') {
        const t = req.headers.get('x-session') || url.searchParams.get('token') || '';
        const r = await authVerify(env, t); return json(r.valid ? { valid: true, name: r.name, role: r.role } : { valid: false });
      }
      if (path === '/api/health') {
        const b = await cachedBoot(env, '15M'); return json({ mode: b.v.mode, builtAt: b.v.builtAt, stale: b.stale });
      }
      const auth = await requireAuth(req, env);
      if (!auth.valid) return json({ error: 'UNAUTHORIZED' }, 401);
      if (path === '/api/bootstrap') { const tf = parseTf(url.searchParams.get('tf')); const b = await cachedBoot(env, tf); return json(b.v); }
      if (path === '/api/quote') {
        const out: any = { ts: Date.now() };
        try { const g = await goldapicom.goldapiComQuote('XAU:USD'); const s = await goldapicom.goldapiComQuote('XAG:USD'); out.gold = g.price; out.silver = s.price; out.source = 'gold-api.com'; }
        catch { try { const g = await memo('q:g', 60000, () => yahoo.yahooQuote(env, 'XAU:USD')); const s = await memo('q:s', 60000, () => yahoo.yahooQuote(env, 'XAG:USD')); out.gold = g.price; out.silver = s.price; out.source = 'yahoo'; } catch { const l = await metalsdev.metalsdevLatest(env); out.gold = l.gold; out.silver = l.silver; out.source = 'metals.dev'; } }
        const d = await memo('q:d', 60000, () => yahoo.yahooQuote(env, 'DXY')); out.dxy = d.price; out.dxyPct = d.changePct ?? null; return json(out);
      }
      if (path === '/api/candles') {
        const tf = parseTf(url.searchParams.get('tf')); const sym = url.searchParams.get('sym') ?? 'XAU:USD';
        const c = new AppCache(env.CACHE);
        const r = await c.wrap('c:' + sym + ':' + tf, tf === '1D' ? 3600 : 300, () => firstOk([{ name: 'yahoo', fn: () => yahoo.yahooCandles(env, sym, tf) }, { name: 'sim', fn: () => Promise.resolve(sim.simCandles(sym, tf)) }]).then(rr => ({ candles: rr.value, source: rr.provider === 'yahoo' ? 'yahoo' : 'sim', ts: Date.now() })));
        return json({ tf, sym, ...r.v, stale: r.stale, ageMs: r.ageMs });
      }
      if (path === '/api/page/energy') { const c = new AppCache(env.CACHE); const r = await c.wrap('pe', 900, () => buildEnergyPage(env)); return json(r.v); }
      if (path === '/api/page/agri') { const c = new AppCache(env.CACHE); const r = await c.wrap('pa', 900, () => buildAgriPage(env)); return json(r.v); }
      if (path === '/api/watch') {
        const syms = (url.searchParams.get('syms') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 12);
        if (!syms.length) return json({ quotes: [] });
        const c = new AppCache(env.CACHE); const r = await c.wrap('w:' + syms.join(','), 120, () => yahoo.yahooBatchQuotes(syms).catch(() => sim.simQuotes(syms))); return json({ quotes: r.v });
      }
      if (path === '/api/ml') { const raw = await env.CACHE.get('ml:snap', 'json'); return raw ? json(raw) : json({ status: 'WARMING' }); }
      if (path === '/api/macro') { const b = await cachedBoot(env, '15M'); return json(b.v.macro); }
      if (path === '/api/news') { const b = await cachedBoot(env, '15M'); return json(b.v.news); }
      if (path === '/api/analytics') { const b = await cachedBoot(env, '15M'); return json(b.v.analytics); }
      if (path === '/api/why-gold') { const b = await cachedBoot(env, '15M'); return json({ ...b.v.why, movePct: b.v.gold.changePct }); }
      if (path === '/api/ai/analyst') {
        let profile: any = null; try { if (req.method === 'POST') profile = (await req.json())?.profile ?? null; } catch { }
        const cached = profile ? null : (await env.CACHE.get('ai:cache', 'json')) as any;
        if (cached && Date.now() - cached.ts < 600000) return json(cached);
        const b = await cachedBoot(env, parseTf(url.searchParams.get('tf')));
        const out = await aiAnalyst(env, b.v.analytics, b.v.why, { ml: (b.v as any).ml ?? null, profile, dxy: b.v.dxy.changePct, realYield: b.v.why.drivers[0]?.delta, newsSentiment: { bull: b.v.news.gold.filter((n: any) => n.sentiment === 'bull').length, bear: b.v.news.gold.filter((n: any) => n.sentiment === 'bear').length } });
        if (!profile) await env.CACHE.put('ai:cache', JSON.stringify(out), { expirationTtl: 1200 }); return json(out);
      }
      if (path === '/api/search') {
        const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 100);
        if (!q || q.length < 2) return json({ results: [] });
        const results: any[] = [];
        const PAGES = [
          { t: 'Gold Terminal', u: '/gold.html', k: 'gold xau price chart why moving miners heatmap' },
          { t: 'Energy Terminal', u: '/energy.html', k: 'energy oil wti brent natural gas eia crude' },
          { t: 'Agri Terminal', u: '/agri.html', k: 'agri corn wheat soybean cattle water weather usda' },
          { t: 'FX Terminal', u: '/fx.html', k: 'fx forex dollar dxy euro yen currency' },
          { t: 'Water Terminal', u: '/water.html', k: 'water nq h2o california drought river usgs' },
          { t: 'Land Terminal', u: '/land.html', k: 'land farm farmland acre rent usda nass' },
          { t: 'Stablecoin Terminal', u: '/stable.html', k: 'stablecoin tether usdt usdc dai peg crypto' },
          { t: 'Shipping Terminal', u: '/shipping.html', k: 'shipping freight container port baltic suez' },
          { t: 'AI Analysis', u: '/ai.html', k: 'ai analyst machine learning ml question ask' },
        ];
        for (const p of PAGES) { if (p.t.toLowerCase().includes(q) || p.k.includes(q)) results.push({ type: 'PAGE', title: p.t, url: p.u, source: 'NAV' }); }
        try { const b = await cachedBoot(env, '15M'); const all = [...(b.v.news.gold || []), ...(b.v.news.mining || []), ...(b.v.news.macro || [])]; for (const n of all) { if (n.title?.toLowerCase().includes(q)) results.push({ type: 'NEWS', title: n.title, url: n.url, source: n.source }); if (results.length > 15) break; } } catch { }
        return json({ results: results.slice(0, 15) });
      }
      if (auth.role !== 'admin') return json({ error: 'FORBIDDEN' }, 403);
      if (path === '/api/env') { const mk = (n: string) => { const v = secret(env, n); return v ? 'SET' : 'MISSING'; }; return json({ METALS_API_KEY: mk('METALS_API_KEY'), FRED_API_KEY: mk('FRED_API_KEY'), ADMIN_TOKEN: mk('ADMIN_TOKEN') }); }
      if (path === '/api/ml/train') { const tr = await trainAndStore(env); await predictAndStore(env); return json(tr); }
      return json({ error: 'UNKNOWN' }, 404);
    } catch (e) { return json({ error: 'FAIL', detail: String((e as Error).message).slice(0, 200) }, 502); }
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    await ensureSecrets(env);
    ctx.waitUntil((async () => {
      try {
        const boot = await buildBootstrap(env, '15M');
        await new AppCache(env.CACHE).write('boot:15M', boot, 300);
        await env.DB.prepare('INSERT OR REPLACE INTO price_snapshots(ts,symbol,price,source) VALUES(?,?,?,?)').bind(Date.now(), 'XAU:USD', boot.gold.price, boot.gold.source).run();
      } catch (e) { console.error('CRON', String((e as Error).message).slice(0, 200)); }
    })());
    if (new Date(event.scheduledTime).getUTCMinutes() % 15 === 0) {
      ctx.waitUntil((async () => {
        try { const c = new AppCache(env.CACHE); await c.write('pe', await buildEnergyPage(env), 900); await c.write('pa', await buildAgriPage(env), 900); } catch { }
      })());
    }
    if (event.cron !== '0 * * * *') return;
    ctx.waitUntil((async () => {
      try {
        const lm = await env.CACHE.get('ml:last', 'json') as any;
        if (lm && Date.now() - lm.t < 21600000) return;
        const last = await env.DB.prepare('SELECT MAX(trained_at) t FROM ml_models WHERE active=1').first<{ t: number | null }>();
        if (!last?.t || Date.now() - last.t > 604800000) { const tr = await trainAndStore(env); if (!tr.ok) console.error('ML_FAIL', tr.error); }
        await predictAndStore(env); await gradeOutcomes(env);
        await env.CACHE.put('ml:last', JSON.stringify({ t: Date.now() }), { expirationTtl: 86400 });
      } catch (e) { console.error('ML_CRON', String((e as Error).message).slice(0, 200)); }
    })());
    ctx.waitUntil((async () => {
      try {
        const ln = await env.CACHE.get('nse:last', 'json') as any;
        if (ln && Date.now() - ln.t < 3600000) return;
        await newsSentimentHourly(env);
        await env.CACHE.put('nse:last', JSON.stringify({ t: Date.now() }), { expirationTtl: 86400 });
      } catch { }
    })());
  },
};
