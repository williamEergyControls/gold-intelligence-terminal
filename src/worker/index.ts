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
      /* ============ PUBLIC (no auth) ============ */
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

      /* ============ AUTH REQUIRED (all operators) ============ */
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
        const r = await c.wrap('cd:' + sym + ':' + tf, tf === '1D' ? 3600 : 300, () => firstOk([{ name: 'yahoo', fn: () => yahoo.yahooCandles(env, sym, tf) }, { name: 'sim', fn: () => Promise.resolve(sim.simCandles(sym, tf)) }]).then(rr => ({ candles: rr.value, source: rr.provider === 'yahoo' ? 'yahoo(unofficial)' : 'simulated', ts: Date.now() })));
        return json({ tf, sym, ...r.v, stale: r.stale, ageMs: r.ageMs });
      }
      if (path === '/api/page/energy') { const c = new AppCache(env.CACHE); const r = await c.wrap('pg:e', 900, () => buildEnergyPage(env)); return json(r.v); }
      if (path === '/api/page/agri') { const c = new AppCache(env.CACHE); const r = await c.wrap('pg:a', 900, () => buildAgriPage(env)); return json(r.v); }
      if (path === '/api/page/shipping') {
        const c = new AppCache(env.CACHE);
        const r = await c.wrap('pg:s', 900, async () => {
          try {
            const shp = await import('./providers/shipping');
            return await shp.buildShippingPanel(env);
          } catch (e: any) {
            return { futures: [], indices: [{ label: 'SHIPPING DATA PENDING', value: 0, change: null, source: 'CONFIGURING', asOf: '' }], ports: [], sea: null, news: [], builtAt: Date.now() };
          }
        });
        return json(r.v);
      }
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
        const cached = profile ? null : (await env.CACHE.get('ai:c', 'json')) as any;
        if (cached && Date.now() - cached.ts < 600000) return json(cached);
        const b = await cachedBoot(env, parseTf(url.searchParams.get('tf')));
        const out = await aiAnalyst(env, b.v.analytics, b.v.why, { ml: (b.v as any).ml ?? null, profile, dxy: b.v.dxy.changePct, realYield: b.v.why.drivers[0]?.delta, newsSentiment: { bull: b.v.news.gold.filter((n: any) => n.sentiment === 'bull').length, bear: b.v.news.gold.filter((n: any) => n.sentiment === 'bear').length } });
        if (!profile) await env.CACHE.put('ai:c', JSON.stringify(out), { expirationTtl: 1200 }); return json(out);
      }
      if (path === '/api/ai/ask') {
        if (req.method !== 'POST') return json({ error: 'POST ONLY' }, 405);
        const b = await readBody(req); const question = String(b.question || '').slice(0, 500);
        if (!question) return json({ error: 'ENTER A QUESTION' }, 400);
        const boot = await cachedBoot(env, '1D');
        const mlSnap = await env.CACHE.get('ml:snap', 'json');
        const context = { gold: { price: boot.v.gold.price, change: boot.v.gold.changePct }, silver: { price: boot.v.silver.price }, dxy: { price: boot.v.dxy.price, change: boot.v.dxy.changePct }, macro: boot.v.macro.rows.slice(0, 10), analytics: boot.v.analytics, why: boot.v.why, ml: mlSnap, newsSummary: { bull: (boot.v.news.gold || []).filter((n: any) => n.sentiment === 'bull').length, bear: (boot.v.news.gold || []).filter((n: any) => n.sentiment === 'bear').length, top: (boot.v.news.gold || []).slice(0, 5).map((n: any) => n.title) }, question };
        const SYS = 'You are a senior gold market analyst. Use ONLY the numbers in the JSON. Be direct. Reference exact figures. Max 10 lines. End with: NOT FINANCIAL ADVICE.';
        try {
          const res: any = await env.AI!.run('@cf/meta/llama-3.1-8b-instruct', { messages: [{ role: 'system', content: SYS }, { role: 'user', content: JSON.stringify(context) }], max_tokens: 500, temperature: 0.3 });
          return json({ ok: true, answer: String(res?.response || '').trim(), engine: 'llama-3.1-8b', ts: Date.now() });
        } catch {
          return json({ ok: true, answer: 'Gold ' + (boot.v.gold.changePct >= 0 ? 'up' : 'down') + ' ' + Math.abs(boot.v.gold.changePct || 0).toFixed(2) + '% at $' + boot.v.gold.price + '. Top driver: ' + (boot.v.why.drivers[0]?.name || 'N/A') + ' ' + (boot.v.why.drivers[0]?.delta || '') + '. ML: ' + (mlSnap ? mlSnap.direction + ' ' + (mlSnap.p * 100).toFixed(0) + '%' : 'warming') + '. NOT FINANCIAL ADVICE.', engine: 'fallback', ts: Date.now() });
        }
      }
      if (path === '/api/search') {
        const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 100);
        if (!q || q.length < 2) return json({ results: [] });
        const results: any[] = [];
        const PAGES = [
          { t: 'Gold Terminal', u: '/gold.html', k: 'gold xau price chart why miners' },
          { t: 'Energy Terminal', u: '/energy.html', k: 'energy oil wti brent gas eia' },
          { t: 'Agri Terminal', u: '/agri.html', k: 'agri corn wheat cattle water usda' },
          { t: 'FX Terminal', u: '/fx.html', k: 'fx forex dollar dxy euro currency' },
          { t: 'Water Terminal', u: '/water.html', k: 'water drought river usgs nq' },
          { t: 'Land Terminal', u: '/land.html', k: 'land farm acre rent usda nass' },
          { t: 'Stablecoin Terminal', u: '/stable.html', k: 'stablecoin tether usdt crypto peg' },
          { t: 'Shipping Terminal', u: '/shipping.html', k: 'shipping freight port baltic suez' },
          { t: 'AI Analysis', u: '/ai.html', k: 'ai analyst ml question deep' },
        ];
        for (const p of PAGES) { if (p.t.toLowerCase().includes(q) || p.k.includes(q)) results.push({ type: 'PAGE', title: p.t, url: p.u, source: 'NAV' }); }
        try {
          const b = await cachedBoot(env, '15M');
          const all = [...(b.v.news.gold || []), ...(b.v.news.mining || []), ...(b.v.news.macro || [])];
          for (const n of all) { if (n.title?.toLowerCase().includes(q)) results.push({ type: 'NEWS', title: n.title, url: n.url, source: n.source }); if (results.length > 15) break; }
        } catch { }
        return json({ results: results.slice(0, 15) });
      }

      /* ============ ADMIN ONLY ============ */
      if (auth.role !== 'admin') return json({ error: 'FORBIDDEN' }, 403);
      if (path === '/api/env') { const mk = (n: string) => { const v = secret(env, n); return v ? 'SET' : 'MISSING'; }; return json({ METALS_API_KEY: mk('METALS_API_KEY'), FRED_API_KEY: mk('FRED_API_KEY'), ADMIN_TOKEN: mk('ADMIN_TOKEN') }); }
      if (path === '/api/ml/train') { const tr = await trainAndStore(env); await predictAndStore(env); return json(tr); }
      if (path === '/api/admin/diagnostics') {
        const b = await cachedBoot(env, '15M');
        const ml = await env.CACHE.get('ml:snap', 'json');
        const models = await env.DB.prepare('SELECT id, name, trained_at, active FROM ml_models ORDER BY id DESC LIMIT 5').all();
        const pc = await env.DB.prepare('SELECT COUNT(*) as n FROM predictions').first();
        const oc = await env.DB.prepare('SELECT COUNT(*) as n, SUM(correct) as c FROM prediction_outcomes').first();
        const uc = await env.DB.prepare('SELECT COUNT(*) as n FROM users').first();
        const sc = await env.DB.prepare('SELECT COUNT(*) as n FROM sessions WHERE expires_at > ?').bind(Date.now()).first();
        return json({
          worker: { mode: b.v.mode, builtAt: b.v.builtAt, providers: b.v.health },
          ml: { models: models.results, predictions: pc?.n ?? 0, graded: oc?.n ?? 0, accuracy: oc?.n > 0 ? ((oc?.c ?? 0) / oc.n * 100).toFixed(1) + '%' : 'PENDING', signal: ml ? { dir: ml.direction, p: ml.p, regime: ml.regime?.state } : null },
          auth: { users: uc?.n ?? 0, sessions: sc?.n ?? 0 },
          dataFlow: { gold: 'gold-api.com > Yahoo > metals.dev', news: 'GDELT + Llama hourly', macro: 'FRED (CPI/PCE/yields/SOFR)', energy: 'Yahoo + EIA', agri: 'Yahoo + USGS + Open-Meteo', shipping: 'Yahoo + indices + marine', stable: 'CoinGecko', ml: 'hourly cron, weekly train, 5d grade' },
        });
      }
      return json({ error: 'UNKNOWN_ENDPOINT' }, 404);
    } catch (e) { return json({ error: 'UPSTREAM_FAILURE', detail: String((e as Error).message).slice(0, 200) }, 502); }
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
        try { const c = new AppCache(env.CACHE); await c.write('pg:e', await buildEnergyPage(env), 900); await c.write('pg:a', await buildAgriPage(env), 900); } catch { }
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
