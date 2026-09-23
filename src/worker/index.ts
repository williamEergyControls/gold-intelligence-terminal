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
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.w > 60000) { hits.set(ip, { n: 1, w: now }); return true; }
  h.n++;
  if (hits.size > 5000) hits.clear();
  return h.n <= 240;
}
function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const m = qMemo.get(key);
  if (m && Date.now() - m.ts < ttlMs) return Promise.resolve(m.v as T);
  return fn().then(v => { qMemo.set(key, { v, ts: Date.now() }); return v; });
}
async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}
function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: JH });
}
async function cachedBoot(env: Env, tf: Tf) {
  return new AppCache(env.CACHE).wrap('boot:' + tf, 300, () => buildBootstrap(env, tf));
}
function parseTf(s: string | null): Tf { return TFS.includes(s as Tf) ? (s as Tf) : '15M'; }

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
    if (!allow(ip)) return json({ error: 'RATE_LIMITED' }, 429);
    await ensureSecrets(env);

    try {
      /* ===================== PUBLIC ROUTES (no auth) ===================== */
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
        const b = await readBody(req);
        await authLogout(env, String(b.token || ''));
        return json({ ok: true });
      }
      if (path === '/api/auth/me') {
        const token = req.headers.get('x-session') || url.searchParams.get('token') || '';
        const r = await authVerify(env, token);
        return json(r.valid ? { valid: true, name: r.name, role: r.role } : { valid: false });
      }
      if (path === '/api/health') {
        const boot = await cachedBoot(env, '15M');
        return json({ mode: boot.v.mode, builtAt: boot.v.builtAt, stale: boot.stale });
      }

      /* ===================== AUTH REQUIRED BELOW ===================== */
      const auth = await requireAuth(req, env);
      if (!auth.valid) return json({ error: 'UNAUTHORIZED', hint: 'sign in first' }, 401);

      if (path === '/api/bootstrap') {
        const tf = parseTf(url.searchParams.get('tf'));
        const boot = await cachedBoot(env, tf);
        return json(boot.v);
      }
      if (path === '/api/quote') {
        const out: any = { ts: Date.now() };
        try {
          const g = await goldapicom.goldapiComQuote('XAU:USD');
          const s = await goldapicom.goldapiComQuote('XAG:USD');
          out.gold = g.price; out.silver = s.price; out.source = 'gold-api.com';
        } catch {
          try {
            const g = await memo('q:gold', 60000, () => yahoo.yahooQuote(env, 'XAU:USD'));
            const s = await memo('q:silver', 60000, () => yahoo.yahooQuote(env, 'XAG:USD'));
            out.gold = g.price; out.silver = s.price; out.source = 'yahoo(unofficial)';
          } catch {
            const l = await metalsdev.metalsdevLatest(env);
            out.gold = l.gold; out.silver = l.silver; out.source = 'metals.dev';
          }
        }
        const d = await memo('q:dxy', 60000, () => yahoo.yahooQuote(env, 'DXY'));
        out.dxy = d.price; out.dxyPct = d.changePct ?? null;
        return json(out);
      }
      if (path === '/api/candles') {
        const tf = parseTf(url.searchParams.get('tf'));
        const sym = url.searchParams.get('sym') ?? 'XAU:USD';
        const cache = new AppCache(env.CACHE);
        const r = await cache.wrap('candles:' + sym + ':' + tf, tf === '1D' ? 3600 : 300, () =>
          firstOk([
            { name: 'yahoo', fn: () => yahoo.yahooCandles(env, sym, tf) },
            { name: 'simulated', fn: () => Promise.resolve(sim.simCandles(sym, tf)) },
          ]).then(rr => ({ candles: rr.value, source: rr.provider === 'yahoo' ? 'yahoo(unofficial)' : 'simulated', ts: Date.now() }))
        );
        return json({ tf, sym, ...r.v, stale: r.stale, ageMs: r.ageMs });
      }
      if (path === '/api/page/energy') {
        const cache = new AppCache(env.CACHE);
        const r = await cache.wrap('page:energy', 900, () => buildEnergyPage(env));
        return json(r.v);
      }
      if (path === '/api/page/agri') {
        const cache = new AppCache(env.CACHE);
        const r = await cache.wrap('page:agri', 900, () => buildAgriPage(env));
        return json(r.v);
      }
      if (path === '/api/watch') {
        const syms = (url.searchParams.get('syms') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 12);
        if (!syms.length) return json({ quotes: [] });
        const cache = new AppCache(env.CACHE);
        const r = await cache.wrap('watch:' + syms.join(','), 120, () => yahoo.yahooBatchQuotes(syms).catch(() => sim.simQuotes(syms)));
        return json({ quotes: r.v });
      }
      if (path === '/api/ml') {
        const raw = await env.CACHE.get('ml:snap', 'json');
        return raw ? json(raw) : json({ status: 'WARMING' });
      }
      if (path === '/api/macro') {
        const b = await cachedBoot(env, '15M');
        return json(b.v.macro);
      }
      if (path === '/api/news') {
        const b = await cachedBoot(env, '15M');
        return json(b.v.news);
      }
      if (path === '/api/analytics') {
        const b = await cachedBoot(env, '15M');
        return json(b.v.analytics);
      }
      if (path === '/api/why-gold') {
        const b = await cachedBoot(env, '15M');
        return json({ ...b.v.why, movePct: b.v.gold.changePct });
      }
      if (path === '/api/ai/analyst') {
        let profile: any = null;
        try { if (req.method === 'POST') profile = (await req.json())?.profile ?? null; } catch { }
        const cachedAi = profile ? null : (await env.CACHE.get('ai:cache', 'json')) as any;
        if (cachedAi && Date.now() - cachedAi.ts < 600000) return json(cachedAi);
        const b = await cachedBoot(env, parseTf(url.searchParams.get('tf')));
        const out = await aiAnalyst(env, b.v.analytics, b.v.why, {
          ml: (b.v as any).ml ?? null,
          profile,
          dxy: b.v.dxy.changePct,
          realYield: b.v.why.drivers[0]?.delta,
          newsSentiment: {
            bull: b.v.news.gold.filter(n => n.sentiment === 'bull').length,
            bear: b.v.news.gold.filter(n => n.sentiment === 'bear').length,
          },
        });
        if (!profile) await env.CACHE.put('ai:cache', JSON.stringify(out), { expirationTtl: 1200 });
        return json(out);
      }

      /* ===================== ADMIN ONLY ===================== */
      if (auth.role !== 'admin') return json({ error: 'FORBIDDEN - ADMIN ONLY' }, 403);

      if (path === '/api/env') {
        const mk = (n: string) => { const v = secret(env, n); return v ? 'SET' : 'MISSING'; };
        return json({ METALS_API_KEY: mk('METALS_API_KEY'), FRED_API_KEY: mk('FRED_API_KEY'), ADMIN_TOKEN: mk('ADMIN_TOKEN'), checkedAt: new Date().toISOString() });
      }
      if (path === '/api/ml/train') {
        const tr = await trainAndStore(env);
        await predictAndStore(env);
        return json(tr);
      }
        /* ===== SHIPPING ===== */
      if (path === '/api/page/shipping') {
        const cache = new AppCache(env.CACHE);
        const r = await cache.wrap('page:shipping', 900, async () => {
          const { buildShippingPanel } = await import('./providers/shipping');
          const panel = await buildShippingPanel(env);
          const newsR = await new AppCache(env.CACHE).wrap('news:shipping', 3600, async () => {
            const gdelt = await import('./providers/gdelt');
            try { return await gdelt.gdeltNews(env, ['macro']); } catch { return []; }
          });
          panel.news = (newsR.v as any[]).filter(n =>
            n.title?.toLowerCase().includes('ship') || n.title?.toLowerCase().includes('freight') ||
            n.title?.toLowerCase().includes('port') || n.title?.toLowerCase().includes('cargo') ||
            n.title?.toLowerCase().includes('container') || n.title?.toLowerCase().includes('red sea')
          ).slice(0, 8);
          return panel;
        });
        return json(r.v);
      }

      /* ===== AI DEEP ANALYSIS ===== */
      if (path === '/api/ai/ask') {
        if (req.method !== 'POST') return json({ error: 'POST ONLY' }, 405);
        const b = await readBody(req);
        const question = String(b.question || '').slice(0, 500);
        if (!question) return json({ error: 'ENTER A QUESTION' }, 400);

        // Gather comprehensive data for the AI to analyze
        const boot = await cachedBoot(env, '1D');
        const mlSnap = await env.CACHE.get('ml:snap', 'json');
        const newsCache = await env.CACHE.get('news', 'json');

        const context = {
          gold: { price: boot.v.gold.price, change: boot.v.gold.changePct, source: boot.v.gold.source },
          silver: { price: boot.v.silver.price, change: boot.v.silver.changePct },
          dxy: { price: boot.v.dxy.price, change: boot.v.dxy.changePct },
          macro: boot.v.macro.rows.slice(0, 10),
          analytics: boot.v.analytics,
          why: boot.v.why,
          ml: mlSnap,
          newsSummary: {
            bullCount: (boot.v.news.gold || []).filter((n: any) => n.sentiment === 'bull').length,
            bearCount: (boot.v.news.gold || []).filter((n: any) => n.sentiment === 'bear').length,
            topHeadlines: (boot.v.news.gold || []).slice(0, 5).map((n: any) => n.title),
          },
          question,
        };

        const SYSTEM = `You are a senior gold market analyst. Answer the operator's question using ONLY the data provided.
Rules: 1. Use ONLY the numbers in the JSON. 2. Be direct and specific. 3. Reference exact figures. 4. Max 10 lines. 5. End with: NOT FINANCIAL ADVICE.`;

        try {
          const res: any = await env.AI!.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: JSON.stringify(context) }
            ],
            max_tokens: 500, temperature: 0.3,
          });
          const text = String(res?.response ?? '').trim();
          if (!text) throw new Error('empty');
          return json({ ok: true, answer: text, engine: 'llama-3.1-8b', ts: Date.now() });
        } catch (e) {
          // deterministic fallback
          const w = boot.v.why;
          const g = boot.v.gold;
          return json({
            ok: true,
            answer: `Gold is ${g.changePct >= 0 ? 'up' : 'down'} ${(Math.abs(g.changePct ?? 0)).toFixed(2)}% at $${g.price}. ` +
              `Top driver: ${w.drivers[0]?.name} ${w.drivers[0]?.delta}. ` +
              `ML signal: ${mlSnap ? mlSnap.direction + ' ' + (mlSnap.p * 100).toFixed(0) + '%' : 'warming'}. ` +
              `News sentiment: ${context.newsSummary.bullCount} bull vs ${context.newsSummary.bearCount} bear. ` +
              `Your question: "${question}" requires deeper analysis. NOT FINANCIAL ADVICE.`,
            engine: 'deterministic', ts: Date.now()
          });
        }
      }

      /* ===== SEARCH ===== */
      if (path === '/api/search') {
        const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 100);
        if (!q || q.length < 2) return json({ results: [] });
        const results: { type: string; title: string; url: string; source: string }[] = [];

        // Search pages
        const PAGES = [
          { title: 'Gold Terminal', url: '/gold.html', keywords: 'gold xau price chart why moving miners heatmap inflation cpi' },
          { title: 'Energy Terminal', url: '/energy.html', keywords: 'energy oil wti brent natural gas heating rbob eia crude' },
          { title: 'Agri Terminal', url: '/agri.html', keywords: 'agri corn wheat soybean cattle cotton sugar water weather usda' },
          { title: 'FX Terminal', url: '/fx.html', keywords: 'fx forex dollar dxy euro yen pound currency majors' },
          { title: 'Water Terminal', url: '/water.html', keywords: 'water nq h2o california drought river usgs gauge' },
          { title: 'Land Terminal', url: '/land.html', keywords: 'land farm farmland acre rent usda nass values' },
          { title: 'Stablecoin Terminal', url: '/stable.html', keywords: 'stablecoin tether usdt usdc dai peg crypto' },
          { title: 'Shipping Terminal', url: '/shipping.html', keywords: 'shipping freight container port baltic bdi suez red sea' },
          { title: 'AI Analysis', url: '/ai.html', keywords: 'ai analyst machine learning ml deep analysis question ask' },
        ];
        for (const p of PAGES) {
          if (p.title.toLowerCase().includes(q) || p.keywords.includes(q)) {
            results.push({ type: 'PAGE', title: p.title, url: p.url, source: 'NAV' });
          }
        }

        // Search news
        try {
          const boot = await cachedBoot(env, '15M');
          const allNews = [...(boot.v.news.gold || []), ...(boot.v.news.mining || []), ...(boot.v.news.macro || [])];
          for (const n of allNews) {
            if (n.title.toLowerCase().includes(q) || n.source.toLowerCase().includes(q)) {
              results.push({ type: 'NEWS', title: n.title, url: n.url !== '#' ? n.url : '#', source: n.source });
            }
            if (results.length > 20) break;
          }
        } catch { /* news optional */ }

        // Search macro data
        try {
          const boot = await cachedBoot(env, '15M');
          for (const r of boot.v.macro.rows) {
            if (r.label.toLowerCase().includes(q) || r.key.toLowerCase().includes(q)) {
              results.push({ type: 'DATA', title: `${r.label}: ${r.value}%`, url: '/gold.html', source: r.source });
            }
          }
        } catch { /* macro optional */ }

        return json({ query: q, results: results.slice(0, 20) });
      }

      /* ===== ADMIN DIAGNOSTICS ===== */
      if (path === '/api/admin/diagnostics') {
        if (auth.role !== 'admin') return json({ error: 'FORBIDDEN' }, 403);
        const boot = await cachedBoot(env, '15M');
        const mlSnap = await env.CACHE.get('ml:snap', 'json');
        const mlModels = await env.DB.prepare('SELECT id, name, trained_at, active FROM ml_models ORDER BY id DESC LIMIT 5').all();
        const predictionCount = await env.DB.prepare('SELECT COUNT(*) as n FROM predictions').first();
        const outcomeCount = await env.DB.prepare('SELECT COUNT(*) as n, SUM(correct) as c FROM prediction_outcomes').first();
        const userCount = await env.DB.prepare('SELECT COUNT(*) as n FROM users').first();
        const sessionCount = await env.DB.prepare('SELECT COUNT(*) as n FROM sessions WHERE expires_at > ?').bind(Date.now()).first();

        return json({
          worker: {
            mode: boot.v.mode,
            builtAt: boot.v.builtAt,
            stale: boot.stale,
            providers: boot.v.health,
          },
          ml: {
            hasSnapshot: !!mlSnap,
            models: mlModels.results,
            totalPredictions: predictionCount?.n ?? 0,
            gradedOutcomes: outcomeCount?.n ?? 0,
            accuracy: outcomeCount?.n > 0 ? ((outcomeCount?.c ?? 0) / outcomeCount.n * 100).toFixed(1) + '%' : 'PENDING',
            latestSignal: mlSnap ? { direction: mlSnap.direction, p: mlSnap.p, regime: mlSnap.regime?.state } : null,
          },
          auth: {
            totalUsers: userCount?.n ?? 0,
            activeSessions: sessionCount?.n ?? 0,
          },
          cache: {
            note: 'KV keys expire via TTL - no manual purge needed',
            keysActive: 'auto-managed',
          },
          dataFlow: {
            gold: 'gold-api.com -> Yahoo -> metals.dev -> sim',
            news: 'GDELT -> keyword sentiment + hourly Llama sentiment',
            macro: 'FRED (CPI/PCE/PPI/SOFR/EFFR/yields)',
            energy: 'Yahoo futures -> EIA weekly',
            agri: 'Yahoo futures -> USGS water -> Open-Meteo weather',
            shipping: 'Yahoo futures -> public indices -> Open-Meteo marine',
            stable: 'CoinGecko (live, no key)',
            ml: 'Hourly cron -> train weekly -> predict 6h -> grade 5d',
          },
          timestamp: new Date().toISOString(),
        });
      }
      return json({ error: 'UNKNOWN_ENDPOINT' }, 404);
    } catch (e) {
      return json({ error: 'UPSTREAM_FAILURE', detail: String((e as Error).message).slice(0, 300) }, 502);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    await ensureSecrets(env);
    const hourly = event.cron === '0 * * * *';
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
    if (new Date(event.scheduledTime).getUTCMinutes() % 15 === 0) {
      ctx.waitUntil((async () => {
        try {
          const cache = new AppCache(env.CACHE);
          await cache.write('page:energy', await buildEnergyPage(env), 900);
          await cache.write('page:agri', await buildAgriPage(env), 900);
        } catch (e) { console.error('PAGE_WARM_FAIL', String((e as Error).message).slice(0, 200)); }
      })());
    }
    if (!hourly) return;
    ctx.waitUntil((async () => {
      try {
        const lastMl = await env.CACHE.get('ml:last', 'json') as { t: number } | null;
        if (lastMl && Date.now() - lastMl.t < 21600000) return;
        let mlOk = true;
        const last = await env.DB.prepare('SELECT MAX(trained_at) t FROM ml_models WHERE active=1').first<{ t: number | null }>();
        if (!last?.t || Date.now() - last.t > 604800000) {
          const tr = await trainAndStore(env);
          if (!tr.ok) { mlOk = false; console.error('ML_TRAIN_FAIL', tr.error); }
        }
        await predictAndStore(env);
        await gradeOutcomes(env);
        if (mlOk) await env.CACHE.put('ml:last', JSON.stringify({ t: Date.now() }), { expirationTtl: 86400 });
      } catch (e) { console.error('ML_CRON_FAIL', String((e as Error).message).slice(0, 300)); }
    })());
    ctx.waitUntil((async () => {
      try {
        const lastNse = await env.CACHE.get('nse:last', 'json') as { t: number } | null;
        if (lastNse && Date.now() - lastNse.t < 3600000) return;
        await newsSentimentHourly(env);
        await env.CACHE.put('nse:last', JSON.stringify({ t: Date.now() }), { expirationTtl: 86400 });
      } catch { }
    })());
  },
};
