/* ================================================================
   GOLD INTELLIGENCE TERMINAL — WORKER ENTRY
   request cycle:  INIT (secrets + schema) → AUTH GATE → ROUTE → PUBLISH json
   cron cycle:     every 5 min  warm bootstrap cache + snapshot + health
                   :02 :12 … :52 news crawl (own invocation) · AI digest every other run
                                 · :32 also refreshes FRED release dates + drought map when old
                   hourly (0 *) live API probes · news sentiment · once/day GoldAPI.io
                                seed + D1 prune · ML last (CPU heavy)
   NOTE: routing is a flat if-chain on purpose. the 2026-10-01 deploy broke on
   a stray `case path === ...:` with no enclosing `switch` — esbuild rejects that
   ("Unexpected case"). keep it if-chain; never mix the two styles.
   ================================================================ */
import type { Env, Tf } from './types';
import { AppCache, pruneCache } from './cache';
import { buildBootstrap } from './bootstrap';
import { aiAnalyst, newsSentimentHourly } from './ai/analyst';
import { agentChat } from './ai/chat';
import { ensureSecrets, persistHealthRows, secretStates, healthErrors } from './providers/provider';
import { ensureSchema } from './schema';
import { trainAndStore, predictAndStore, gradeOutcomes } from './ml/pipeline';
import { authRegister, authLogin, authVerify, authLogout, requireAuth } from './auth';
import { buildEnergyPage, buildAgriPage } from './pages';
import { goldapiIoSeed } from './providers/goldapiio';
import { runProbes, storeProbes, probeHistory, lastProbes, type ProbeResult } from './admin/probes';
import { adminML, adminDB, adminKV, adminUsers, setUserRole, unlockUser, revokeSessions, pruneDB } from './admin/data';
import * as yahoo from './providers/yahoo';
import { goldapiComQuote } from './providers/goldapicom';
import { runIngest, unitStates, dueUnits, readSeries, readMeta } from './store/ingest';
import { SERIES, UNITS, SOURCE_LABEL } from './store/registry';
import { refreshVol, readSnapshots, VOL_CLASSES } from './vol/snapshot';
import { changes, rollingRv, garchFit, monthlyYoY } from './analytics/vol';
import { mlStrip } from './ml/strip';
import { crawlCycle, digestBatch, newsFeed, newsIdeas, listSources, addSource, updateSource, deleteSource, pruneNews } from './news/crawler';
import { calendar, refreshFred } from './calendar';
import { refreshDrought, readDrought } from './providers/drought';
import { tick, dailyRollup, ledgerSummary, HS, type H } from './forecast/ledger';
import { buildOutlook, readOutlook } from './outlook/engine';
import { refreshInsiders } from './outlook/sources';

const JH = { 'content-type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
const TFS: Tf[] = ['5M', '15M', '1H', '1D', '1W'];
const hits = new Map<string, { n: number; w: number }>();
const qMemo = new Map<string, { v: any; ts: number }>();
let probeMemo: { ts: number; forced: boolean; rs: ProbeResult[] } | null = null;
let volMemo: { ts: number; v: unknown } | null = null;
const SERIES_IDS = new Set(Object.keys(SERIES));
function ingestBudget(env: Env): number { const n = parseInt(env.INGEST_BUDGET ?? '10', 10); return isFinite(n) && n > 0 ? Math.min(n, 40) : 10; }

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
function json(v: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(v), { status, headers: { ...JH, ...extra } });
}
function errMsg(e: unknown, n = 200): string { return String((e as Error)?.message ?? e).slice(0, n); }
function parseTf(s: string | null): Tf { return TFS.includes(s as Tf) ? (s as Tf) : '15M'; }

/* bootstrap: 60s logical ttl, KV keeps 6x as stale fallback.
   buildBootstrap throws → wrap() serves last good value labeled stale.
   NO zero-price "degraded" objects get cached — a cached $0 gold overwrote
   the last good value for 60s and was labeled live. */
async function cachedBoot(env: Env, tf: Tf) {
  // the warm cron rebuilds boot:15M and boot:1D every 10 min; a request only rebuilds
  // when the cron copy is over 5 min old. live price between rebuilds comes from /api/quote.
  return new AppCache(env).wrap('boot:' + tf, 300, () => buildBootstrap(env, tf));
}
async function bootOrFallback(env: Env, tf: Tf) {
  try { return { ...(await cachedBoot(env, tf)), tfFallback: null as Tf | null }; }
  catch (e) {
    console.error('BOOTSTRAP_FAIL', tf, errMsg(e));
    if (tf !== '15M') {
      const alt = await new AppCache(env).read<any>('boot:15M');
      if (alt) return { v: alt.v, ageMs: alt.ageMs, stale: true, tfFallback: '15M' as Tf };
    }
    throw e;
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
    if (!allow(ip, 240, 60000)) return json({ error: 'RATE_LIMITED' }, 429);

    try {
      // ===================== INIT =====================
      await ensureSecrets(env);
      await ensureSchema(env).catch(e => console.error('SCHEMA_FAIL', errMsg(e)));

      // ===================== PUBLIC ROUTES =====================
      if (path === '/api/auth/register' && req.method === 'POST') {
        if (!allow('reg:' + ip, 5, 3600000)) return json({ error: 'RATE_LIMITED' }, 429);
        const b = await readBody(req);
        const r = await authRegister(env, String(b.name || ''), String(b.password || ''));
        return r.ok ? json({ ok: true, token: r.token, name: r.name, role: r.role }, 200) : json({ error: r.error }, 400);
      }
      if (path === '/api/auth/login' && req.method === 'POST') {
        if (!allow('login:' + ip, 20, 60000)) return json({ error: 'RATE_LIMITED' }, 429);
        const b = await readBody(req);
        const r = await authLogin(env, String(b.name || ''), String(b.password || ''));
        return r.ok ? json({ ok: true, token: r.token, name: r.name, role: r.role }, 200) : json({ error: r.error }, 401);
      }
      if (path === '/api/auth/logout' && req.method === 'POST') {
        const b = await readBody(req);
        await authLogout(env, String(b.token || req.headers.get('x-session') || ''));
        return json({ ok: true }, 200);
      }
      if (path === '/api/auth/me') {
        const t = req.headers.get('x-session') || url.searchParams.get('token') || '';
        const r = await authVerify(env, t);
        return json(r.valid ? { valid: true, id: r.id, name: r.name, role: r.role } : { valid: false }, 200);
      }
      if (path === '/api/health') {
        // read-only: never triggers an upstream build from an unauthenticated route
        const hit = await new AppCache(env).read<any>('boot:15M');
        if (!hit) return json({ mode: 'unknown', builtAt: null, stale: true, providers: [] }, 200);
        return json({ mode: hit.v.mode, builtAt: hit.v.builtAt, ageMs: hit.ageMs, stale: hit.ageMs > hit.ttl * 1000, providers: hit.v.health }, 200);
      }

      // ===================== AUTH REQUIRED =====================
      const auth = await requireAuth(req, env);
      if (!auth.valid) return json({ error: 'UNAUTHORIZED', hint: 'sign in first' }, 401);

      if (path === '/api/bootstrap') {
        const tf = parseTf(url.searchParams.get('tf'));
        try {
          const r = await bootOrFallback(env, tf);
          return json({ ...r.v, stale: r.stale, ageMs: r.ageMs, tfFallback: r.tfFallback }, 200);
        } catch (e) {
          // honest failure state — the frontend retries with backoff. no fake zeros.
          return json({ error: 'DATA_TEMPORARILY_UNAVAILABLE', source: 'bootstrap', retrying: true, retryAfterSec: 15, detail: errMsg(e) }, 503, { 'Retry-After': '15' });
        }
      }
      if (path === '/api/candles') {
        const tf = parseTf(url.searchParams.get('tf'));
        const sym = (url.searchParams.get('sym') || 'XAU:USD').toUpperCase();
        if (!/^[A-Z0-9=^.:\-]{1,15}$/.test(sym)) return json({ error: 'BAD_SYMBOL' }, 400);
        try {
          // only real yahoo candles are cached; the label travels with the data
          const r = await new AppCache(env).wrap('candles2:' + sym + ':' + tf, tf === '1D' ? 3600 : 300,
            async () => ({ candles: await yahoo.yahooCandles(env, sym, tf), source: 'yahoo-finance(unofficial)' }));
          return json({ tf, sym, candles: r.v.candles, source: r.v.source, stale: r.stale, ageMs: r.ageMs }, 200);
        } catch {
          // no live and no stored copy: an empty chart says so; nothing is invented
          return json({ tf, sym, candles: [], source: 'unavailable', stale: true, ageMs: null, retryAfterSec: 60 }, 200);
        }
      }
      if (path === '/api/quote') {
        const out: any = { ts: Date.now() };
        try {
          // spot first — the page's prevClose is spot, mixing in GC=F futures shifted the price by the basis every 20s
          const g = await memo('q:gold', 20000, () => goldapiComQuote('XAU:USD').catch(() => yahoo.yahooQuote(env, 'XAU:USD')));
          out.gold = g.price; out.goldPct = g.changePct ?? null; out.source = g.source;
        } catch { out.gold = null; }
        try {
          const d = await memo('q:dxy', 60000, () => yahoo.yahooQuote(env, 'DXY'));
          out.dxy = d.price; out.dxyPct = d.changePct;
        } catch { out.dxy = null; }
        return json(out, 200);
      }
      if (path === '/api/page/energy') {
        const r = await new AppCache(env).wrap('page:energy', 900, () => buildEnergyPage(env));
        return json({ ...r.v, stale: r.stale }, 200);
      }
      if (path === '/api/page/agri') {
        const r = await new AppCache(env).wrap('page:agri', 900, () => buildAgriPage(env));
        return json({ ...r.v, stale: r.stale }, 200);
      }
      if (path === '/api/page/shipping') {
        const r = await new AppCache(env).wrap('page:shipping', 900, async () => {
          try {
            const shp = await import('./providers/shipping');
            return await shp.buildShippingPanel(env);
          } catch (e) {
            console.error('SHIPPING_FAIL', errMsg(e));
            return { builtAt: Date.now(), proxies: [], chokepoints: [], chokeAsOf: null, chokeSource: 'IMF PortWatch', ports: [], portsAsOf: null, marineAsOf: null, wci: null, indices: [], errors: [errMsg(e)] };
          }
        });
        return json(r.v, 200);
      }
      if (path === '/api/watch') {
        const syms = (url.searchParams.get('syms') || '').split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9=^.:\-]{1,15}$/.test(s)).slice(0, 12);
        if (!syms.length) return json({ quotes: [] }, 200);
        try {
          const r = await new AppCache(env).wrap('watch:' + syms.join(','), 120, () => yahoo.yahooBatchQuotes(syms));
          return json({ quotes: r.v, stale: r.stale, ageMs: r.ageMs }, 200);
        } catch { return json({ quotes: [], stale: true, unavailable: true }, 200); }
      }
      if (path === '/api/macro') return json((await cachedBoot(env, '15M')).v.macro, 200);
      if (path === '/api/news') return json((await cachedBoot(env, '15M')).v.news, 200);
      if (path === '/api/analytics') return json((await cachedBoot(env, '15M')).v.analytics, 200);
      if (path === '/api/why-gold') {
        const b = await cachedBoot(env, '15M');
        return json({ ...b.v.why, movePct: b.v.gold.changePct }, 200);
      }
      /* ---- volatility desk + warehouse reads (all precomputed, no upstream calls) ---- */
      if (path === '/api/vol') {
        if (!volMemo || Date.now() - volMemo.ts > 30000) {
          const snaps = await readSnapshots(env);
          const classes: Record<string, unknown> = {};
          for (const c of VOL_CLASSES) classes[c] = snaps[c]?.v ?? null;
          const ages = Object.fromEntries(Object.entries(snaps).map(([k, v]) => [k, Date.now() - v.ts]));
          volMemo = { ts: Date.now(), v: { ts: Date.now(), classes, cross: snaps.x?.v ?? null, ages, warming: !Object.keys(snaps).length } };
        }
        return json(volMemo.v, 200);
      }
      if (path === '/api/series') {
        const id = (url.searchParams.get('id') || '').toUpperCase();
        if (!SERIES_IDS.has(id)) return json({ error: 'UNKNOWN_SERIES', known: [...SERIES_IDS] }, 400);
        const def = SERIES[id];
        const days = Math.min(5600, Math.max(30, parseInt(url.searchParams.get('days') || (def.freq === 'monthly' ? '3650' : '400'), 10) || 400));
        const pts = (await readSeries(env, [id], Date.now() - days * 864e5))[id] ?? [];
        const ann = def.freq === 'monthly' ? 12 : def.tradingDays;
        const ch = changes(def.kind, pts);
        const rv20 = rollingRv(ch, def.freq === 'monthly' ? 12 : 20, ann);
        const g = def.kind === 'peg' || def.kind === 'cpi' || def.kind === 'mcap' ? null : garchFit(ch.map(c => c.v));
        const condAnn = g ? ch.slice(-g.cond.length).map((c, i) => ({ t: c.t, v: +(g.cond[i] * Math.sqrt(ann)).toFixed(3) })) : [];
        const yoy = def.kind === 'cpi' ? monthlyYoY(pts).map(p => ({ t: p.t, v: +p.v.toFixed(3) })) : [];
        return json({
          id, label: def.label, kind: def.kind, unit: def.unit, freq: def.freq,
          source: SOURCE_LABEL[def.source] + ' · ' + def.srcId, retrievedAt: new Date().toISOString(),
          dataTimestamp: pts.length ? new Date(pts[pts.length - 1].t).toISOString().slice(0, 10) : null,
          points: pts, rv20, garchAnn: condAnn, yoy,
          devBp: def.kind === 'peg' ? pts.map(p => ({ t: p.t, v: +((p.v - 1) * 1e4).toFixed(2) })) : [],
          volUnit: def.kind === 'yield' || def.kind === 'peg' || def.kind === 'rate' ? 'bp/yr' : def.kind === 'cpi' ? '% m/m σ (12m, ×√12)' : '%/yr',
        }, 200);
      }
      if (path === '/api/ml/strip') {
        const page = (url.searchParams.get('page') || 'home').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12);
        return json(await mlStrip(env, page), 200);
      }
      if (path === '/api/markets/stablecoins') {
        const snaps = await readSnapshots(env);
        const st = snaps.stable?.v;
        if (!st) return json({ error: 'DATA_TEMPORARILY_UNAVAILABLE', source: 'CoinGecko via D1 warehouse', retrying: true, detail: 'warehouse warming — first ingest runs within 10 min' }, 503, { 'Retry-After': '60' });
        const mc = new Map(((st.extras?.mcap ?? []) as any[]).map(m => [m.id, m]));
        const coins = (st.rows as any[]).filter(r => r.kind === 'peg').map(r => ({
          id: r.id, label: r.label, price: r.last, devBp: r.extra?.devBp ?? null, chg1dBp: r.chg,
          max30Bp: r.extra?.max30Bp ?? null, max90Bp: r.extra?.max90Bp ?? null, daysOver10bp90: r.extra?.daysOver10bp90 ?? null,
          volBpDay: r.rv20 ?? null, regime: r.regime, mcap: mc.get(r.id)?.mcap ?? null, share: mc.get(r.id)?.share ?? null,
          mcapChg30d: mc.get(r.id)?.chg30d ?? null, lastTs: r.lastTs, stale: r.stale, spark: r.spark,
        }));
        return json({ source: 'CoinGecko (public API) · stored in D1, refreshed hourly', retrievedAt: new Date(snaps.stable.ts).toISOString(), frequency: 'daily close + latest print', unit: 'USD', totalMcap: st.extras?.totalMcap ?? null, coins }, 200);
      }
      if (path === '/api/ml/history') {
        const rs = await memo('ml:hist', 300000, async () => (await env.DB.prepare(
          `SELECT p.ts, p.p_up, p.direction, p.regime, o.realized_ret, o.correct FROM predictions p
           LEFT JOIN prediction_outcomes o ON o.ts=p.ts AND o.horizon_days=p.horizon_days ORDER BY p.ts DESC LIMIT 40`
        ).all()).results ?? []);
        return json({ horizonDays: 5, rows: rs }, 200);
      }
      if (path === '/api/ml') {
        const raw = await env.CACHE.get('ml:snap', 'json');
        return raw ? json(raw, 200) : json({ status: 'WARMING' }, 200);
      }
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
          ml: b.v.ml ?? null,
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
        const ml = await env.CACHE.get('ml:snap', 'json');
        const gpct = boot.v.gold.changePct ?? 0;
        const askCtx = {
          gold: { price: boot.v.gold.price, change: gpct, source: boot.v.gold.source },
          silver: { price: boot.v.silver.price },
          dxy: { price: boot.v.dxy.price, change: boot.v.dxy.changePct },
          macro: boot.v.macro.rows.slice(0, 10),
          analytics: boot.v.analytics, why: boot.v.why, ml,
          newsSummary: {
            bull: (boot.v.news.gold || []).filter((n: any) => n.sentiment === 'bull').length,
            bear: (boot.v.news.gold || []).filter((n: any) => n.sentiment === 'bear').length,
            top: (boot.v.news.gold || []).slice(0, 5).map((n: any) => n.title),
          },
          question: q,
        };
        const SYS = 'You are a senior gold market analyst. Use ONLY the numbers provided. Be direct. Reference exact figures. Max 10 lines. End with: NOT FINANCIAL ADVICE.';
        try {
          if (!env.AI) throw new Error('AI binding missing');
          const res: any = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [{ role: 'system', content: SYS }, { role: 'user', content: JSON.stringify(askCtx) }],
            max_tokens: 500, temperature: 0.3,
          });
          return json({ ok: true, answer: String(res?.response || '').trim(), engine: 'llama-3.1-8b', ts: Date.now() }, 200);
        } catch {
          const d0 = boot.v.why.drivers[0];
          return json({ ok: true, answer: 'Gold ' + (gpct >= 0 ? 'up' : 'down') + ' ' + Math.abs(gpct).toFixed(2) + '% at $' + boot.v.gold.price.toFixed(2) + '. ' + (d0?.name || '') + ' ' + (d0?.delta || '') + '. NOT FINANCIAL ADVICE.', engine: 'fallback', ts: Date.now() }, 200);
        }
      }
      /* ---- news crawler + calendar + drought (all single D1/KV reads) ---- */
      if (path === '/api/news/feed') {
        const topic = (url.searchParams.get('topic') || 'all').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12);
        const limit = Math.min(40, Math.max(3, parseInt(url.searchParams.get('limit') || '12', 10) || 12));
        const r = await memo('nf:' + topic + ':' + limit + ':' + (url.searchParams.get('fav') || ''), 30000, () => newsFeed(env, topic, limit, { favOnly: url.searchParams.get('fav') === '1' }));
        return json(r, 200);
      }
      if (path === '/api/news/ideas') {
        const topic = (url.searchParams.get('topic') || 'all').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12);
        const limit = Math.min(12, Math.max(1, parseInt(url.searchParams.get('limit') || '6', 10) || 6));
        return json(await memo('ni:' + topic + ':' + limit, 60000, () => newsIdeas(env, limit, topic)), 200);
      }
      /* ---- outlook (3–12 month synthesis) + forecast ledger ---- */
      if (path === '/api/outlook') {
        let r = await memo('outlook', 60000, () => readOutlook(env));
        if (!r.outlook && allow('outlook-lazy', 2, 600000)) { await buildOutlook(env); r = await readOutlook(env); }
        return json(r, 200);
      }
      if (path === '/api/forecast') {
        const h = (url.searchParams.get('h') || '1d') as H;
        if (!HS.includes(h)) return json({ error: 'BAD_HORIZON', allowed: HS }, 400);
        return json(await memo('fc:' + h, 30000, () => ledgerSummary(env, h)), 200);
      }
      if (path === '/api/calendar') {
        return json(await calendar(env), 200);
      }
      if (path === '/api/drought') {
        let d = await readDrought(env);
        if (!d && allow('drought-lazy', 2, 600000)) { await refreshDrought(env, true); d = await readDrought(env); }
        return d ? json(d, 200) : json({ error: 'DATA_TEMPORARILY_UNAVAILABLE', source: 'U.S. Drought Monitor', retrying: true }, 503, { 'Retry-After': '300' });
      }
      if (path === '/api/search') {
        const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 100);
        if (!q || q.length < 2) return json({ results: [] }, 200);
        const results: any[] = [];
        const PAGES = [
          { t: 'Outlook', u: '/outlook.html', k: 'outlook economy cycle score gold buy hold sell forecast odds cot insider shipping water long term ledger accuracy' },
          { t: 'Gold desk', u: '/gold.html', k: 'gold xau price chart why miners heatmap' },
          { t: 'Energy desk', u: '/energy.html', k: 'energy oil wti brent natural gas eia' },
          { t: 'Agri desk', u: '/agri.html', k: 'agri corn wheat soybean cattle water usda' },
          { t: 'FX desk', u: '/fx.html', k: 'fx forex dollar dxy euro currency' },
          { t: 'Water desk', u: '/water.html', k: 'water drought river usgs nq' },
          { t: 'Land desk', u: '/land.html', k: 'land farm acre rent usda' },
          { t: 'Stablecoin desk', u: '/stable.html', k: 'stablecoin tether usdt crypto peg' },
          { t: 'Shipping desk', u: '/shipping.html', k: 'shipping freight port baltic suez' },
          { t: 'AI analyst', u: '/ai.html', k: 'ai analyst ml question deep' },
          { t: 'Volatility desk', u: '/vol.html', k: 'vol volatility vix move garch treasury yields fx stablecoin depeg insurance stocks stress' },
          { t: 'News & trading ideas', u: '/news.html', k: 'news feed youtube channel rss summary trade idea headlines' },
        ];
        if (auth.role === 'admin') PAGES.push({ t: 'Admin console', u: '/admin.html', k: 'admin api probe health ml db database users diagnostics' });
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
        } catch { /* nav results still return */ }
        try {
          const rs = (await env.DB.prepare(`SELECT i.title, i.url, s.name FROM news_items i JOIN news_sources s ON s.id=i.source_id WHERE lower(i.title) LIKE ? ORDER BY i.published DESC LIMIT 8`).bind('%' + q.replace(/[%_]/g, '') + '%').all<{ title: string; url: string; name: string }>()).results ?? [];
          for (const r of rs) if (results.length < 15) results.push({ type: 'NEWS', title: r.title, url: r.url, source: r.name });
        } catch { /* crawler table may be empty */ }
        return json({ results: results.slice(0, 15) }, 200);
      }

      // ===================== ADMIN ONLY =====================
      if (auth.role !== 'admin') return json({ error: 'FORBIDDEN', role: auth.role ?? null, hint: 'admin role required — see docs/ADMIN.md' }, 403);
      const actorId = auth.id ?? -1;

      if (path === '/api/env') {
        return json({ secrets: secretStates(env), ai: !!env.AI, aiEnabled: env.AI_ENABLED ?? null, metalsTtl: env.METALS_TTL ?? null }, 200);
      }

      /* ---- news sources (your channels + feeds) ---- */
      if (path === '/api/admin/news/sources' && req.method === 'GET') return json(await listSources(env), 200);
      if (path === '/api/admin/news/sources' && req.method === 'POST') {
        if (!allow('srcadd:' + actorId, 20, 600000)) return json({ error: 'RATE_LIMITED' }, 429);
        const b = await readBody(req);
        try {
          const r = await addSource(env, { url: String(b.url || ''), name: b.name, topics: b.topics, favorite: b.favorite !== false }, auth.name ?? 'admin');
          // first crawl of the new source right away so the admin sees items (or the error)
          const c = await crawlCycle(env, { ids: [r.id] }).catch(e => ({ fetched: 0, added: 0, errors: [errMsg(e)] }));
          return json({ ok: true, source: r, crawl: c }, 200);
        } catch (e) { return json({ error: 'SOURCE_REJECTED', detail: errMsg(e, 200) }, 400); }
      }
      if (path === '/api/admin/news/sources/update' && req.method === 'POST') {
        const b = await readBody(req);
        await updateSource(env, Number(b.id), { enabled: b.enabled, favorite: b.favorite, topics: b.topics });
        return json({ ok: true }, 200);
      }
      if (path === '/api/admin/news/sources/delete' && req.method === 'POST') {
        const b = await readBody(req);
        await deleteSource(env, Number(b.id));
        return json({ ok: true }, 200);
      }
      if (path === '/api/admin/news/crawl' && req.method === 'POST') {
        if (!allow('crawl:' + actorId, 6, 600000)) return json({ error: 'RATE_LIMITED', hint: 'max 6 manual crawls per 10 min' }, 429);
        const b = await readBody(req);
        const c = await crawlCycle(env, { ids: Array.isArray(b.ids) ? b.ids.map(Number) : undefined, max: 10 });
        const d = b.digest === false ? null : await digestBatch(env);
        return json({ ok: true, crawl: c, digest: d }, 200);
      }
      if (path === '/api/admin/outlook/build' && req.method === 'POST') {
        if (!allow('outlook:' + actorId, 6, 600000)) return json({ error: 'RATE_LIMITED' }, 429);
        const o = await buildOutlook(env);
        return json({ ok: true, econ: o.econ.score, gold: o.gold.score, stance: o.gold.stance, inputs: o.inputs }, 200);
      }
      if (path === '/api/admin/insiders/refresh' && req.method === 'POST') {
        if (!allow('insiders:' + actorId, 3, 600000)) return json({ error: 'RATE_LIMITED' }, 429);
        return json(await refreshInsiders(env), 200);
      }
      if (path === '/api/admin/refs/refresh' && req.method === 'POST') {
        if (!allow('refs:' + actorId, 4, 600000)) return json({ error: 'RATE_LIMITED' }, 429);
        const [f, d] = await Promise.all([refreshFred(env, true), refreshDrought(env, true)]);
        return json({ ok: true, fred: f, drought: d }, 200);
      }

      /* ---- live API probes ---- */
      if (path === '/api/admin/apis') {
        const run = url.searchParams.get('run') === '1';
        const force = url.searchParams.get('force') === '1';
        let live: ProbeResult[] | null = null;
        let throttled = false;
        if (run) {
          const now = Date.now();
          const lastForced = force ? ((await env.CACHE.get('admin:forcedProbe', 'json').catch(() => null)) as { t: number } | null) : null;
          if (force && lastForced && now - lastForced.t < 5 * 60000) { throttled = true; }
          else if (!force && probeMemo && now - probeMemo.ts < 20000) { live = probeMemo.rs; throttled = true; }
          else {
            live = await runProbes(env, force);
            if (force) ctx.waitUntil(env.CACHE.put('admin:forcedProbe', JSON.stringify({ t: now }), { expirationTtl: 600 }).catch(() => { }));
            probeMemo = { ts: now, forced: force, rs: live };
            ctx.waitUntil(storeProbes(env, live).catch(e => console.error('PROBE_STORE_FAIL', errMsg(e))));
          }
        }
        const [hist, last, ph] = await Promise.all([
          probeHistory(env, 24).catch(() => ({})),
          lastProbes(env).catch(() => ({})),
          env.DB.prepare('SELECT provider, last_success, last_failure, latency_ms, status FROM provider_health ORDER BY provider').all().then(r => r.results ?? []).catch(() => []),
        ]);
        return json({
          ts: Date.now(), ran: !!live && !throttled, forced: force, throttled,
          probes: live ?? probeMemo?.rs ?? null,
          last, history: hist, providerHealth: ph,
          isolateErrors: healthErrors(),
          secrets: secretStates(env),
        }, 200);
      }

      /* ---- ML ---- */
      if (path === '/api/admin/ml') return json(await adminML(env), 200);
      if ((path === '/api/admin/ml/train' || path === '/api/ml/train') && req.method === 'POST') {
        const tr = await trainAndStore(env);
        const pr = tr.ok ? await predictAndStore(env) : null;
        return json({ ...tr, predict: pr }, tr.ok ? 200 : 500);
      }
      if (path === '/api/admin/ml/predict' && req.method === 'POST') {
        const pr = await predictAndStore(env);
        if (pr.ok) await env.CACHE.put('ml:last', JSON.stringify({ t: Date.now() }), { expirationTtl: 86400 }).catch(() => { });
        return json({ ...pr, snap: await env.CACHE.get('ml:snap', 'json') }, pr.ok ? 200 : 502);
      }
      if (path === '/api/admin/ml/grade' && req.method === 'POST') {
        const gr = await gradeOutcomes(env);
        return json(gr, gr.ok ? 200 : 502);
      }

      /* ---- DB / KV ---- */
      if (path === '/api/admin/db') return json(await adminDB(env), 200);
      if (path === '/api/admin/db/prune' && req.method === 'POST') return json({ ok: true, deleted: await pruneDB(env) }, 200);
      if (path === '/api/admin/kv') return json(await adminKV(env), 200);

      /* ---- warehouse (series store) ---- */
      if (path === '/api/admin/storage') {
        const [states, meta, cnt] = await Promise.all([
          unitStates(env), readMeta(env),
          env.DB.prepare('SELECT COUNT(*) n, COUNT(DISTINCT id) s FROM series_points').first<{ n: number; s: number }>(),
        ]);
        const due = new Map(dueUnits(states).map(d => [d.u.key, d]));
        const snaps = await readSnapshots(env);
        return json({
          ts: Date.now(), budget: ingestBudget(env), totalPoints: cnt?.n ?? 0, seriesWithData: cnt?.s ?? 0,
          units: UNITS.map(u => {
            const st = states[u.key];
            return {
              key: u.key, source: u.source, cadenceMin: u.cadenceMin, series: u.series.map(s => ({ id: s.id, label: s.label, cls: s.cls, points: meta[s.id]?.points ?? 0, firstTs: meta[s.id]?.first_ts ?? null, lastTs: meta[s.id]?.last_ts ?? null, last: meta[s.id]?.last_v ?? null })),
              fetchedAt: st?.fetched_at ?? null, okAt: st?.ok_at ?? null, error: st?.error ?? null, fails: st?.fails ?? 0,
              due: due.has(u.key), backfill: !st?.ok_at,
            };
          }),
          snapshots: Object.fromEntries(Object.entries(snaps).map(([k, v]) => [k, { ageMs: Date.now() - v.ts }])),
        }, 200);
      }
      if (path === '/api/admin/storage/ingest' && req.method === 'POST') {
        const b = await readBody(req);
        const keys = Array.isArray(b.keys) ? b.keys.map(String).filter((k: string) => UNITS.some(u => u.key === k)).slice(0, 40) : undefined;
        const r = await runIngest(env, ingestBudget(env), keys);
        const v = await refreshVol(env);
        volMemo = null;
        return json({ ok: true, ...r, volBuilt: v.built }, 200);
      }
      if (path === '/api/admin/storage/rebuild' && req.method === 'POST') {
        // one class per request (the admin page loops) — keeps each call inside the CPU limit
        const b = await readBody(req);
        const cls = VOL_CLASSES.find(c => c === String(b.cls || ''));
        if (!cls) return json({ error: 'cls must be one of ' + VOL_CLASSES.join(', ') }, 400);
        const v = await refreshVol(env, { cls });
        volMemo = null;
        return json({ ok: true, built: v.built }, 200);
      }

      /* ---- users ---- */
      if (path === '/api/admin/users') return json({ ...(await adminUsers(env)), me: { id: auth.id, name: auth.name } }, 200);
      if (path === '/api/admin/users/role' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await setUserRole(env, actorId, Number(b.id), String(b.role || ''));
        return json(r, r.ok ? 200 : 400);
      }
      if (path === '/api/admin/users/unlock' && req.method === 'POST') {
        const b = await readBody(req);
        return json(await unlockUser(env, Number(b.id)), 200);
      }
      if (path === '/api/admin/users/revoke' && req.method === 'POST') {
        const b = await readBody(req);
        if (Number(b.id) === actorId) return json({ ok: false, error: 'USE SIGN OUT FOR YOUR OWN SESSION' }, 400);
        return json(await revokeSessions(env, Number(b.id)), 200);
      }

      /* ---- legacy diagnostics (old /diagnostics.html) ---- */
      if (path === '/api/admin/diagnostics') {
        const hit = await new AppCache(env).read<any>('boot:15M');
        const ml: any = await env.CACHE.get('ml:snap', 'json');
        const [models, pc, oc, uc, sc] = await Promise.all([
          env.DB.prepare('SELECT id, name, trained_at, active FROM ml_models ORDER BY id DESC LIMIT 5').all(),
          env.DB.prepare('SELECT COUNT(*) as n FROM predictions').first<{ n: number }>(),
          env.DB.prepare('SELECT COUNT(*) as n, SUM(correct) as c FROM prediction_outcomes').first<{ n: number; c: number | null }>(),
          env.DB.prepare('SELECT COUNT(*) as n FROM users').first<{ n: number }>(),
          env.DB.prepare('SELECT COUNT(*) as n FROM sessions WHERE expires_at > ?').bind(Date.now()).first<{ n: number }>(),
        ]);
        const on = oc?.n ?? 0;
        return json({
          worker: { mode: hit?.v?.mode ?? 'unknown', builtAt: hit?.v?.builtAt ?? null, stale: hit ? hit.ageMs > hit.ttl * 1000 : true, providers: hit?.v?.health ?? [] },
          ml: { models: models.results, predictions: pc?.n ?? 0, graded: on, accuracy: on > 0 ? (((oc?.c ?? 0) / on) * 100).toFixed(1) + '%' : 'PENDING', signal: ml ? { dir: ml.direction, p: ml.p, regime: ml.regime?.state } : null },
          auth: { users: uc?.n ?? 0, sessions: sc?.n ?? 0 },
          dataFlow: {
            gold: 'gold-api.com > yahoo > metals.dev > stooq > sim',
            news: 'GDELT > keyword sentiment (Llama hourly override)',
            macro: 'FRED (CPI/PCE/PPI/SOFR/EFFR/yields)',
            energy: 'Yahoo futures + EIA v2 weekly',
            agri: 'Yahoo futures + USGS + Open-Meteo',
            shipping: 'Yahoo futures + reference indices + Open-Meteo marine',
            stable: 'CoinGecko (browser-side)',
            ml: 'hourly cron · predict ≤6h · retrain >7d',
          },
        }, 200);
      }

      return json({ error: 'UNKNOWN_ENDPOINT' }, 404);
    } catch (e) {
      console.error('API_FAIL', path, errMsg(e, 300));
      return json({ error: 'UPSTREAM_FAILURE', detail: errMsg(e, 300) }, 502);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await ensureSecrets(env);
      await ensureSchema(env).catch(e => console.error('SCHEMA_FAIL', errMsg(e)));
      if (controller.cron === '0 * * * *') { await hourly(env); return; }
      if (controller.cron === NEWS_CRON) { await newsCycle(env, controller.scheduledTime); return; }
      // every-minute trigger: gold tick + forecast ledger first (1–2 subrequests, ~7 D1 queries),
      // then :00 :10 :20… warm the UI cache, :05 :15 :25… ingest + vol, other minutes nothing else.
      try { const t = await tick(env, controller.scheduledTime); if (!t.ok && new Date(controller.scheduledTime).getUTCMinutes() % 30 === 0) console.log('TICK', t.note); }
      catch (e) { console.error('TICK_FAIL', errMsg(e)); }
      const mm = new Date(controller.scheduledTime).getUTCMinutes();
      if (mm % 10 === 5) { await ingestCycle(env, controller.scheduledTime); return; }
      if (mm % 10 === 0) await warm(env);
    })());
  },
};

/* ===== news cycle (every 10 min, own invocation): crawl → digest; :32 refreshes reference data ===== */
const NEWS_CRON = '2,12,22,32,42,52 * * * *';
async function newsCycle(env: Env, scheduledTime: number): Promise<void> {
  const min = new Date(scheduledTime).getUTCMinutes();
  if (min === 32) {
    // reference refresh slot: FRED release dates (11 calls, ≤ once/20 h) + drought map (1 call, ≤ once/12 h)
    try { const f = await refreshFred(env); if (f.ok || f.errors.length) console.log('CAL_FRED', JSON.stringify(f)); } catch (e) { console.error('CAL_FRED_FAIL', errMsg(e)); }
    try { const d = await refreshDrought(env); if (!d.ok) console.error('DROUGHT_FAIL', d.error); } catch (e) { console.error('DROUGHT_FAIL', errMsg(e)); }
    try { if (new Date(scheduledTime).getUTCHours() === 3) console.log('NEWS_PRUNE', await pruneNews(env)); } catch (e) { console.error('NEWS_PRUNE_FAIL', errMsg(e)); }
  }
  try {
    const c = await crawlCycle(env);
    if (c.fetched) console.log('NEWS_CRAWL', JSON.stringify({ fetched: c.fetched, added: c.added, errors: c.errors.slice(0, 4) }));
  } catch (e) { console.error('NEWS_CRAWL_FAIL', errMsg(e)); }
  await warmPages(env);
  // outlook: rebuilt in the :52 slot when the stored one is over 6 h old (≈ 4 builds a day)
  if (min === 52) {
    try {
      const l = await env.DB.prepare('SELECT ts FROM outlook_log ORDER BY day DESC LIMIT 1').first<{ ts: number }>().catch(() => null);
      if (!l || Date.now() - l.ts > 6 * 36e5) { const o = await buildOutlook(env); console.log('OUTLOOK', o.econ.score, o.gold.score, o.gold.stance); }
    } catch (e) { console.error('OUTLOOK_FAIL', errMsg(e)); }
  }
  // AI digest on every other run (~72 calls/day × 4 items) keeps Workers AI inside the free allowance
  if (min % 20 === 2) {
    try { const d = await digestBatch(env); if (d.done) console.log('NEWS_DIGEST', JSON.stringify(d)); } catch (e) { console.error('NEWS_DIGEST_FAIL', errMsg(e)); }
  }
}

/* ===== 5-min cycle: warm the cache the UI polls, snapshot price, persist health ===== */
async function warm(env: Env): Promise<void> {
  try {
    const boot = await buildBootstrap(env, '15M');
    // ttl 600 = warm cadence (every 10 min): requests read the cron copy instead of
    // rebuilding against upstream. D1 keeps it as the last good copy.
    await new AppCache(env).write('boot:15M', boot, 600);
    // home asks for 1D: build it here too (quotes, series, miners, fx, macro, news come from
    // this isolate's fresh micro cache, so it costs one candle fetch and one D1 write)
    try { await new AppCache(env).write('boot:1D', await buildBootstrap(env, '1D'), 600); }
    catch (e) { console.error('CRON_WARM_1D_FAIL', errMsg(e)); }
    const stmts: D1PreparedStatement[] = persistHealthRows().map(h => env.DB.prepare(
      `INSERT INTO provider_health(provider,last_success,last_failure,latency_ms,status) VALUES(?,?,?,?,?)
       ON CONFLICT(provider) DO UPDATE SET
         last_success=MAX(COALESCE(excluded.last_success,0), COALESCE(provider_health.last_success,0)),
         last_failure=MAX(COALESCE(excluded.last_failure,0), COALESCE(provider_health.last_failure,0)),
         latency_ms=COALESCE(excluded.latency_ms, provider_health.latency_ms),
         status=CASE
           WHEN MAX(COALESCE(excluded.last_success,0), COALESCE(provider_health.last_success,0)) = 0 THEN 'offline'
           WHEN MAX(COALESCE(excluded.last_success,0), COALESCE(provider_health.last_success,0))
             >= MAX(COALESCE(excluded.last_failure,0), COALESCE(provider_health.last_failure,0)) THEN 'online'
           ELSE 'degraded' END`
    ).bind(h.provider, h.last_success, h.last_failure, h.latency_ms, h.status));
    // only live prints go into history; a stale or daily-close fallback would repeat itself
    if (boot.gold.delay !== 'stale' && boot.gold.delay !== 'daily' && isFinite(boot.gold.price) && boot.gold.price > 0) {
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO price_snapshots(ts,symbol,price,source) VALUES(?,?,?,?)')
        .bind(Date.now(), 'XAU:USD', boot.gold.price, boot.gold.source));
    }
    if (stmts.length) await env.DB.batch(stmts);
  } catch (e) { console.error('CRON_WARM_FAIL', errMsg(e)); }
}

/* desk pages: rebuilt in the news slot (:x2), not the warm slot, so neither cron run goes near
   the Free plan's 50 D1 queries per invocation. a copy younger than ~15 min is left alone. */
async function warmPages(env: Env): Promise<void> {
  for (const [key, build] of [['page:energy', buildEnergyPage], ['page:agri', buildAgriPage]] as const) {
    try {
      const c = new AppCache(env);
      const cur = await c.read(key);
      if (cur && cur.ageMs < 840000) continue;
      await c.write(key, await build(env), 900);
    } catch (e) { console.error('CRON_PAGES_FAIL', key, errMsg(e)); }
  }
}

/* ===== 10-min ingest cycle: warehouse poll → vol snapshots ===== */
async function ingestCycle(env: Env, scheduledTime: number): Promise<void> {
  try {
    const r = await runIngest(env, ingestBudget(env));
    const bad = r.ran.filter(x => !x.ok);
    console.log('INGEST', JSON.stringify({ ran: r.ran.length, rows: r.rows, due: r.due, failed: bad.map(b => b.key + ': ' + b.error) }));
  } catch (e) { console.error('INGEST_FAIL', errMsg(e)); }
  try { await refreshVol(env, { slot: Math.floor(scheduledTime / 600000) }); }
  catch (e) { console.error('VOL_REFRESH_FAIL', errMsg(e)); }
}

/* ===== hourly cycle: each step isolated so one failure never skips the rest ===== */
async function hourly(env: Env): Promise<void> {
  // order matters: on Workers Free a CPU-limit kill cannot be caught, so the cheap
  // steps run first and ML (training is the CPU hog) runs last.

  // 0) forecast ledger roll-up just after midnight UTC, SEC Form 4 pull at 12 UTC (both cheap)
  const hr = new Date().getUTCHours();
  if (hr === 0) { try { console.log('FC_ROLLUP', JSON.stringify((await dailyRollup(env)).rows)); } catch (e) { console.error('FC_ROLLUP_FAIL', errMsg(e)); } }
  if (hr === 12) { try { console.log('INSIDERS', JSON.stringify(await refreshInsiders(env))); } catch (e) { console.error('INSIDERS_FAIL', errMsg(e)); } }

  // 1) live API probes (free endpoints only — quota APIs are admin-forced)
  try { await storeProbes(env, await runProbes(env, false)); }
  catch (e) { console.error('PROBE_CRON_FAIL', errMsg(e)); }

  // 2) Llama news sentiment (1 AI call/hour) — was defined but never called
  try { await newsSentimentHourly(env); }
  catch (e) { console.error('SENTIMENT_CRON_FAIL', errMsg(e)); }

  // 3) once per ~day: GoldAPI.io seed (2 calls/day ≈ 60/month) + retention prune
  try {
    const d = await env.CACHE.get('cron:daily', 'json') as { t: number } | null;
    if (!d || Date.now() - d.t > 20 * 36e5) {
      try {
        const seed = await goldapiIoSeed(env);
        await env.CACHE.put('goldio:daily', JSON.stringify(seed), { expirationTtl: 2 * 86400 });
      } catch (e) { console.error('GOLDIO_SEED_FAIL', errMsg(e)); }
      try { console.log('PRUNE', JSON.stringify(await pruneDB(env)), 'cache_kv', await pruneCache(env)); }
      catch (e) { console.error('PRUNE_FAIL', errMsg(e)); }
      await env.CACHE.put('cron:daily', JSON.stringify({ t: Date.now() }), { expirationTtl: 3 * 86400 });
    }
  } catch (e) { console.error('DAILY_CRON_FAIL', errMsg(e)); }

  // 4) ML — predict at most every 6h, retrain if the active model is > 7 days old
  try {
    const lastMl = await env.CACHE.get('ml:last', 'json') as { t: number } | null;
    if (!lastMl || Date.now() - lastMl.t >= 6 * 36e5) {
      // stamp first so a CPU-limit kill during training doesn't retry every hour
      await env.CACHE.put('ml:last', JSON.stringify({ t: Date.now() }), { expirationTtl: 86400 });
      await predictAndStore(env);
      await gradeOutcomes(env);
      const last = await env.DB.prepare('SELECT MAX(trained_at) t FROM ml_models WHERE active=1').first<{ t: number | null }>();
      if (!last?.t || Date.now() - last.t > 7 * 864e5) {
        const tr = await trainAndStore(env);
        if (!tr.ok) console.error('ML_TRAIN_FAIL', tr.error);
        else await predictAndStore(env);
      }
    }
  } catch (e) { console.error('ML_CRON_FAIL', errMsg(e)); }
}
