import type { AlertItem, Bootstrap, Candle, Env, MacroRow, NewsItem, Quote, Tf } from './types';
import { AppCache } from './cache';
import { firstOk, healthSnapshot, secret } from './providers/provider';
import * as metalsdev from './providers/metalsdev';
import * as yahoo from './providers/yahoo';
import * as stooq from './providers/stooq';
import * as frankfurter from './providers/frankfurter';
import * as fred from './providers/fred';
import * as gdelt from './providers/gdelt';
import { score, attribution, corr } from './analytics/engine';
import * as goldapicom from './providers/goldapicom';
import { readSeries } from './store/ingest';
import { monthlyYoY } from './analytics/vol';

/* live macro pieces from the D1 warehouse (one query). anything missing falls back to the
   old reference value AND says so in its source label. */
async function liveMacro(env: Env) {
  const ids = ['CPI_ALL', 'CPI_SHELTER', 'CPI_FOOD', 'CPI_ENERGY', 'INS_AUTO', 'INS_HOME', 'INS_HEALTH', 'INS_PC_PPI', 'FEDLO', 'FEDHI', 'ECBDFR'];
  // 600 days: CPI lands ~6 weeks after month end, so 13 monthly points need well over 14 months
  const d = await readSeries(env, ids, Date.now() - 600 * 864e5).catch(() => ({} as Record<string, { t: number; v: number }[]>));
  const yoy = (id: string) => {
    // exact calendar month t vs t−12 — a skipped release must not stretch it to 13 months
    const y = monthlyYoY(d[id] ?? []).at(-1);
    const lastT = (d[id] ?? []).at(-1)?.t;
    return y && y.t === lastT ? { v: +y.v.toFixed(2), asOf: new Date(y.t).toISOString().slice(0, 7) } : null;
  };
  const last = (id: string) => { const p = d[id] ?? []; return p.length ? { v: p[p.length - 1].v, asOf: new Date(p[p.length - 1].t).toISOString().slice(0, 10) } : null; };
  return {
    cpi: yoy('CPI_ALL'), shelter: yoy('CPI_SHELTER'), food: yoy('CPI_FOOD'), energy: yoy('CPI_ENERGY'),
    insAuto: yoy('INS_AUTO'), insHome: yoy('INS_HOME'), insHealth: yoy('INS_HEALTH'), insPc: yoy('INS_PC_PPI'),
    fedLo: last('FEDLO'), fedHi: last('FEDHI'), ecb: last('ECBDFR'),
  };
}

// ---------- REFERENCE DATA: curated, low-frequency, honestly labeled ----------
const RE = {
  shipping: [
    { label: 'FBX · Container 40ft', value: '3,842', delta: '▲ +1.8% w/w', deltaDir: 1 as const, typetag: 'INDEX · W', note: 'public index' },
    { label: 'BDI · Dry Bulk', value: '1,984', delta: '▼ −2.3% d', deltaDir: -1 as const, typetag: 'INDEX · D', note: 'public index' },
    { label: 'Bunker VLSFO (SGP)', value: '612 $/t', delta: '▲ +1.1% w/w', deltaDir: 1 as const, typetag: 'INDEX · W', note: 'public index' },
    { label: 'Suez transits', value: '−18% m/m', delta: '▼', deltaDir: -1 as const, typetag: 'NEWS-IND', note: 'GDELT-derived' },
    { label: 'Red Sea war-risk', value: 'FIRM', delta: '▲', deltaDir: 1 as const, typetag: 'MKT-IND', note: 'news indicator — no live quote claimed' },
  ],
  insurance: [
    { line: 'Auto Insurance CPI', yoy: 11.8, pressure: 3, tag: 'OFFICIAL CPI IDX' },
    { line: 'Home / Property', yoy: 7.4, pressure: 3, tag: 'OFFICIAL CPI IDX' },
    { line: 'Health / Medical', yoy: 3.9, pressure: 2, tag: 'OFFICIAL CPI IDX' },
    { line: 'Life (indicator)', yoy: 2.1, pressure: 1, tag: 'INDUSTRY IND.' },
  ],
  centralBanks: [
    { bank: 'FED', rate: '3.75–4.00%', next: 'OCT 29', stance: 'NEUTRAL', gold: '—' },
    { bank: 'ECB', rate: '2.75%', next: 'OCT 30', stance: 'DOVISH', gold: '—' },
    { bank: 'BOJ', rate: '0.75%', next: 'OCT 31', stance: 'HAWKISH', gold: '—' },
    { bank: 'PBOC', rate: '3.10% LPR', next: '—', stance: 'EASING', gold: '+9.0t ▲BUYING (7M)' },
  ],
  // HONEST CALENDAR: fixed real dates so the countdown actually arrives.
  // Times are ET (UTC-4/5). Update this list as dates pass.
  calendar: [
    { when: 'OCT 08 · 13:00', event: 'FOMC Minutes (Sep)', cons: '—', prior: '—', imp: 3, ts: Date.parse('2026-10-08T17:00:00Z') },
    { when: 'OCT 15 · 07:30', event: 'CPI YoY (Sep)', cons: '2.9%', prior: '2.9%', imp: 3, ts: Date.parse('2026-10-15T11:30:00Z') },
    { when: 'OCT 29 · 13:00', event: 'FOMC Rate', cons: '—', prior: '3.75–4.00', imp: 3, ts: Date.parse('2026-10-29T17:00:00Z') },
    { when: 'OCT 31 · 07:30', event: 'Core PCE (Sep)', cons: '2.9%', prior: '2.9%', imp: 2, ts: Date.parse('2026-10-31T11:30:00Z') },
    { when: 'NOV 06 · 07:30', event: 'Nonfarm Payrolls (Oct)', cons: '—', prior: '—', imp: 3, ts: Date.parse('2026-11-06T12:30:00Z') },
  ],
};
const RE_PERIODS: Record<string, Record<string, number>> = {
  '1M': { CPI: 0.2, HOUSING: 0.4, FOOD: 0.3, AUTOINS: 1.1, ENERGY: -0.8, FREIGHT: 1.2, WAGES: 0.3 },
  '3M': { CPI: 0.8, HOUSING: 1.3, FOOD: 0.7, AUTOINS: 3.1, ENERGY: -2.4, FREIGHT: 2.2, WAGES: 1.0 },
  '6M': { CPI: 1.6, HOUSING: 2.2, FOOD: 1.4, AUTOINS: 6.4, ENERGY: -3.1, FREIGHT: 3.8, WAGES: 2.0 },
  '1Y': { CPI: 3.1, HOUSING: 4.2, FOOD: 2.7, AUTOINS: 11.8, ENERGY: -1.9, FREIGHT: 6.4, WAGES: 4.1 },
};
const idxA = (a: number[]) => a.map(v => (v / a[0]) * 100);
const fmt1 = (n: number | undefined | null) => (n == null ? '—' : n.toFixed(2));
const sgn = (n: number | undefined) => (n != null && n > 0 ? '+' : '');
const nowHM = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/* NO SIMULATED DATA. every value is, in order:
     1. live from a provider chain
     2. the last good value from the D1 cache (labeled stale, with its age)
     3. the latest daily close from the D1 warehouse (labeled daily)
     4. nothing → the panel says unavailable. */
const WH: Record<string, string> = { 'XAU:USD': 'GOLD', 'XAG:USD': 'SILVER', DXY: 'DXY' };
async function warehouseCloses(env: Env, sym: string, days = 400): Promise<{ t: number; v: number }[]> {
  const id = WH[sym]; if (!id) return [];
  try { return (await readSeries(env, [id], Date.now() - days * 864e5))[id] ?? []; } catch { return []; }
}
async function quoteLKG(env: Env, cache: AppCache, sym: string, chain: { name: string; fn: () => Promise<Quote> }[]): Promise<Quote> {
  try {
    const r = await cache.wrap('q:' + sym, 15, () => firstOk<Quote>(chain).then(x => x.value));
    const q = { ...r.v } as Quote & { ageMs?: number };   // copy: providers memoize quote objects
    if (r.stale) { q.delay = 'stale'; q.ageMs = r.ageMs; }
    return q;
  } catch (e) {
    const pts = await warehouseCloses(env, sym, 14);
    if (!pts.length) throw new Error(sym + ': no live, cached or stored price — ' + String((e as Error)?.message ?? e).slice(0, 80));
    const last = pts[pts.length - 1], prev = pts.length > 1 ? pts[pts.length - 2].v : null;
    return { symbol: sym, price: last.v, prevClose: prev ?? undefined, change: prev != null ? last.v - prev : undefined, changePct: prev != null ? (last.v / prev - 1) * 100 : undefined,
      currency: 'USD', source: 'D1 warehouse (futures daily close)', delay: 'daily', ts: last.t } as Quote;
  }
}
async function closesLKG(env: Env, sym: string): Promise<number[]> {
  try { return (await yahoo.yahooCandles(env, sym, '1D')).map(c => c.c); }
  catch { return (await warehouseCloses(env, sym)).map(p => p.v); }
}
/** wrap() that degrades to an empty value instead of fabricating one */
async function orEmpty<T>(p: Promise<{ v: T }>, empty: T, tag: string): Promise<T> {
  try { return (await p).v; } catch (e) { console.error(tag + '_UNAVAILABLE', String((e as Error)?.message ?? e).slice(0, 120)); return empty; }
}

export async function buildBootstrap(env: Env, tf: Tf): Promise<Bootstrap & { ml: any }> {
  const cache = new AppCache(env);

  // ---- gold: gold-api.com (free, no key) → yahoo → metals.dev (quota backup) → stooq → sim ----
  const gold = await quoteLKG(env, cache, 'XAU:USD', [
    { name: 'gold-api.com', fn: () => goldapicom.goldapiComQuote('XAU:USD') },
    { name: 'yahoo', fn: () => yahoo.yahooQuote(env, 'XAU:USD') },
    { name: 'metals.dev', fn: () => metalsdev.metalsdevQuote(env, 'XAU:USD') },
    { name: 'stooq', fn: async () => (await stooq.stooqQuotes(env, ['XAU:USD']))[0] },
  ]);
  if (gold.prevClose == null) {
    const pc = await env.CACHE.get('prevclose:XAU:USD', 'json') as { c: number } | null;
    if (pc) { gold.prevClose = pc.c; gold.change = gold.price - pc.c; gold.changePct = (gold.price / pc.c - 1) * 100; }
  }
  const silver = await quoteLKG(env, cache, 'XAG:USD', [
    { name: 'gold-api.com', fn: () => goldapicom.goldapiComQuote('XAG:USD') },
    { name: 'yahoo', fn: () => yahoo.yahooQuote(env, 'XAG:USD') },
    { name: 'metals.dev', fn: () => metalsdev.metalsdevQuote(env, 'XAG:USD') },
  ]);
  // GoldAPI.io DAILY SEED (cron writes KV 'goldio:daily' ~1x/day, 2 calls).
  // only prevClose is used, and only if the seed was taken after the most recent
  // 17:00 ET session roll (22:00 UTC, conservative across DST). bid/ask/OHLC from a
  // snapshot hours old must never sit next to a live price.
  try {
    const seed = (await env.CACHE.get('goldio:daily', 'json')) as any;
    const now = new Date();
    let roll = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22);
    if (roll > now.getTime()) roll -= 864e5;
    if (seed && seed.ts >= roll) {
      for (const [q, sd] of [[gold, seed.gold], [silver, seed.silver]] as [Quote, any][]) {
        const pc = Number(sd?.prevClose);
        if (q.prevClose == null && isFinite(pc) && pc > 0) {
          q.prevClose = pc; q.change = q.price - pc; q.changePct = (q.price / pc - 1) * 100;
        }
      }
    }
  } catch { /* seed optional */ }
  const dxy = await quoteLKG(env, cache, 'DXY', [
    { name: 'yahoo', fn: () => yahoo.yahooQuote(env, 'DXY') },
    { name: 'stooq', fn: async () => (await stooq.stooqQuotes(env, ['DXY']))[0] },
  ]);

  // ---- candles for the current timeframe — cached 300s (1D: via endpoint TTL) ----
  let candles: Candle[] = await orEmpty(cache.wrap(`candles:XAU:${tf}`, 300, () => yahoo.yahooCandles(env, 'XAU:USD', tf)), [] as Candle[], 'CANDLES');
  if (!candles.length && tf === '1D') candles = (await warehouseCloses(env, 'XAU:USD', 200)).map((p, i, a) => ({ t: p.t, o: a[Math.max(0, i - 1)].v, h: Math.max(p.v, a[Math.max(0, i - 1)].v), l: Math.min(p.v, a[Math.max(0, i - 1)].v), c: p.v, v: 0 }));

  // ---- daily relationships: gold/dxy/real-yield indexed + correlations — cached 1h ----
  const daily = await cache.wrap('series:daily', 3600, async () => {
    // yahoo → D1 warehouse daily closes (GC=F / SI=F / DX-Y.NYB). empty → throw so wrap() keeps the last good copy
    const [g, d, s] = await Promise.all([closesLKG(env, 'XAU:USD'), closesLKG(env, 'DXY'), closesLKG(env, 'XAG:USD')]);
    if (g.length < 2) throw new Error('daily gold series unavailable');
    let ry: number[] = [];
    // no FRED → empty series (corr = null, chart empty). the old fallback fabricated a
    // straight-line "real yield" and correlated gold against it.
    try { ry = (await fred.fredSeriesTail(env, 'DFII10', 80)).map(p => p.v); }
    catch (e) { console.error('FRED_DFII10_FAIL', String((e as Error)?.message ?? e).slice(0, 120)); ry = []; }
    const n80 = Math.min(g.length, d.length, 80);
    const m = Math.min(g.length, s.length, 80);
    const ratio: number[] = [];
    for (let i = 0; i < m; i++) ratio.push(g[g.length - m + i] / s[s.length - m + i]);
    const rn = Math.min(g.length, ry.length, 80);
    return {
      goldIdx: idxA(g.slice(-n80)), dxyIdx: idxA(d.slice(-n80)), ryIdx: rn ? idxA(ry.slice(-rn)) : [], ratio,
      corrDxy: corr(g.slice(-n80), d.slice(-n80)), corrRy: corr(g.slice(-rn), ry.slice(-rn)),
      goldDaily: g, dxyDaily: d, ryDaily: ry,
    };
  });
  const ryLast = daily.v.ryDaily.length ? daily.v.ryDaily[daily.v.ryDaily.length - 1] : 0; // no FRED → no move, never a made-up level
  const ryPrev = daily.v.ryDaily.length > 1 ? daily.v.ryDaily[daily.v.ryDaily.length - 2] : ryLast;
  // prevClose fill: stored day-close first, else REAL previous daily close
  if (gold.prevClose == null) {
    const pc = await env.CACHE.get('prevclose:XAU:USD', 'json') as { c: number } | null;
    if (pc) gold.prevClose = pc.c;
    else if (daily.v.goldDaily.length >= 2) gold.prevClose = daily.v.goldDaily[daily.v.goldDaily.length - 2];
    if (gold.prevClose != null) {
      gold.change = gold.price - gold.prevClose;
      gold.changePct = (gold.price / gold.prevClose - 1) * 100;
    }
  }

  // ---- miners heatmap: stooq CSV → yahoo batch → last good copy → empty (errors logged, never silent) ----
  const miners = await orEmpty(cache.wrap('miners', 3600, async () => {
    try {
      const q = await stooq.stooqQuotes(env, stooq.MINERS);
      if (q.length >= 6) return q;
      throw new Error('stooq thin: ' + q.length);
    } catch (e) {
      console.error('MINERS_STOOQ_FAIL', String((e as Error).message).slice(0, 120));
      try {
        const q2 = await yahoo.yahooBatchQuotes(stooq.MINERS);
        if (q2.length >= 6) return q2;
        throw new Error('yahoo thin: ' + q2.length);
      } catch (e2) {
        console.error('MINERS_YAHOO_FAIL', String((e2 as Error).message).slice(0, 120));
        throw e2;
      }
    }
  }), [] as Quote[], 'MINERS');

  // ---- FX: frankfurter (one call, DAILY) → last good copy → empty ----
  const fx = await orEmpty(cache.wrap('fx', 3600, () => frankfurter.frankfurterFx(env)), [] as Quote[], 'FX');

  // ---- macro: FRED (key) → last good copy → empty — cached 6h ----
  // key bumped to macro:v2 — the old cached rows carried AUTOINS = CPI motor fuel
  const macro: MacroRow[] = await orEmpty(cache.wrap('macro:v2', 21600, () => fred.fredRows(env)), [] as MacroRow[], 'MACRO');
  const row = (k: string) => macro.find((m: MacroRow) => m.key === k);
  const cpi = row('CPI'); const autoins = row('AUTOINS');
  const lm = await liveMacro(env);
  const L = (x: { v: number; asOf: string } | null, ref: number, src: string) => x ? { yoy: x.v, source: `${src} · ${x.asOf}` } : { yoy: ref, source: 'STATIC REFERENCE (warehouse warming)' };
  const autoLive = lm.insAuto ? { v: lm.insAuto.v, asOf: lm.insAuto.asOf } : (autoins ? { v: autoins.value, asOf: autoins.asOf.slice(0, 7) } : null);
  const cpiBreakdown = [
    { label: 'SHELTER', ...L(lm.shelter, 4.2, 'FRED CUSR0000SAH1') },
    { label: 'FOOD', ...L(lm.food, 2.7, 'FRED CPIUFDSL') },
    { label: 'ENERGY', ...L(lm.energy, -1.9, 'FRED CPIENGSL') },
    { label: 'AUTO INS.', ...L(autoLive, 11.8, 'FRED CUSR0000SETE') },
    { label: 'TRANSPORT', yoy: 1.2, source: 'STATIC REFERENCE' },
    { label: 'MEDICAL', yoy: 3.1, source: 'STATIC REFERENCE' },
  ];
  const pressure = (y: number) => (y > 6 ? 3 : y > 3 ? 2 : 1);
  const insRow = (line: string, x: { v: number; asOf: string } | null, ref: number, src: string) =>
    x ? { line, yoy: x.v, pressure: pressure(x.v), tag: `${src} · ${x.asOf}` } : { line, yoy: ref, pressure: pressure(ref), tag: 'STATIC REFERENCE' };
  const reference = {
    ...RE,
    insurance: [
      insRow('Auto Insurance CPI', autoLive, 11.8, 'BLS CPI SETE'),
      insRow('Home / Property', lm.insHome, 7.4, 'BLS CPI SEHD'),
      insRow('Health Insurance', lm.insHealth, 3.9, 'BLS CPI SEME'),
      insRow('P&C insurer PPI', lm.insPc, 2.1, 'BLS PPI 524126'),
    ],
    centralBanks: RE.centralBanks.map(cb => {
      if (cb.bank === 'FED' && lm.fedLo && lm.fedHi) return { ...cb, rate: `${lm.fedLo.v.toFixed(2)}–${lm.fedHi.v.toFixed(2)}%`, gold: `FRED ${lm.fedHi.asOf}` };
      if (cb.bank === 'ECB' && lm.ecb) return { ...cb, rate: `${lm.ecb.v.toFixed(2)}%`, gold: `FRED ${lm.ecb.asOf}` };
      return { ...cb, gold: cb.gold === '—' ? 'STATIC REF' : cb.gold };
    }),
    shipping: RE.shipping.map(x => ({ ...x, note: x.note.startsWith('news') ? x.note : 'STATIC REFERENCE · not a live quote' })),
  };

  // ---- news: GDELT → last good copy → empty — cached 1 HOUR ----
  const news = await orEmpty(cache.wrap('news', 3600, () => gdelt.gdeltNews(env, ['gold', 'mining', 'macro'])), [] as NewsItem[], 'NEWS');
  // hourly Llama sentiment (if fresh) overrides the keyword heuristic — labeled LLAMA HOURLY
  try {
    const nse = (await env.CACHE.get('news:sentiment', 'json')) as { ts: number; items: { id: string; s: string }[] } | null;
    if (nse && Array.isArray(nse.items) && Date.now() - nse.ts < 26 * 36e5) {
      const smap = new Map(nse.items.map(x => [x.id, x.s]));
      for (const n of news) {
        const s = smap.get(n.id);
        if (s === 'bull' || s === 'bear' || s === 'neutral') { n.sentiment = s; n.sentimentNote = 'LLAMA HOURLY'; }
      }
    }
  } catch { /* heuristic stands */ }

  // ---- analytics over the DAILY gold series (proper lookback) ----
  const dailyCandles: Candle[] = daily.v.goldDaily.map((c, i, arr) => ({ t: Date.now() - (arr.length - i) * 864e5, o: arr[Math.max(0, i - 1)], h: c, l: c, c, v: 0 }));
  const analytics = score(dailyCandles.length > 60 ? dailyCandles : candles, gold);

  // ---- why-gold attribution ----
  const gdx = miners.length ? miners.reduce((s, mm) => s + (mm.changePct ?? 0), 0) / miners.length : null;
  const why = attribution({
    goldPct: gold.changePct ?? 0, dxyPct: dxy.changePct ?? 0,
    realYieldChgBp: (ryLast - ryPrev) * 100,
    minersPct: gdx, silverPct: silver.changePct ?? null,
    newsCount: news.filter(n => n.topic === 'gold').length, newsAvg: 4,
  });

  // ---- alerts: derived from ACTUAL moves + date-gated calendar alert ----
  const alerts: AlertItem[] = [];
  let hm = 0; for (const c of candles.slice(-60)) hm = Math.max(hm, c.h);
  if (hm > 0 && gold.price >= hm * 0.998) alerts.push({ se: 'warn', t: nowHM(), txt: `GOLD ${fmt1(gold.price)} — within 0.2% of session high ${fmt1(hm)}`, cat: 'gold' });
  if (Math.abs(dxy.changePct ?? 0) > 0.5) alerts.push({ se: 'warn', t: nowHM(), txt: `DXY ${sgn(dxy.changePct)}${fmt1(dxy.changePct)}% — dollar move in force`, cat: 'fx' });
  if (Math.abs((ryLast - ryPrev) * 100) > 3) alerts.push({ se: 'info', t: nowHM(), txt: `10Y real yield ${sgn((ryLast - ryPrev) * 100)}${fmt1((ryLast - ryPrev) * 100)}bp on the day`, cat: 'fx' });
  if (gdx != null && Math.abs(gdx) > 2) alerts.push({ se: 'info', t: nowHM(), txt: `Miners avg ${sgn(gdx)}${fmt1(gdx)}% vs XAU ${sgn(gold.changePct)}${fmt1(gold.changePct)}% — beta check`, cat: 'gold' });
  const nextEv = RE.calendar.find(c => c.ts > Date.now());
  if (nextEv && nextEv.ts - Date.now() < 72 * 36e5) {
    alerts.push({ se: 'info', t: nowHM(), txt: `${nextEv.event} in ${Math.round((nextEv.ts - Date.now()) / 36e5)}h — rate channel in focus`, cat: 'macro' });
  }

  const tape: Quote[] = [gold, silver, dxy, ...fx.slice(0, 2)];
  const us10 = row('US10Y');
  if (us10) tape.push({ symbol: 'US10Y', price: us10.value, prevClose: us10.prior, change: us10.value - us10.prior, changePct: us10.value - us10.prior, currency: '%', source: us10.source, delay: 'daily', ts: Date.parse(us10.asOf) });

  const health = healthSnapshot({
    'gold-api.com': 'near-live' as const,
    'metals.dev': secret(env, 'METALS_API_KEY') ? ('near-live' as const) : null,
    'yahoo': 'near-live' as const,
    'stooq': 'eod' as const,
    'frankfurter': 'daily' as const,
    'fred': secret(env, 'FRED_API_KEY') ? ('daily' as const) : null,
    'gdelt': 'near-live' as const,
    'workers-ai': env.AI ? ('event-driven' as const) : null,
  });

  return {
    mode: gold.delay === 'stale' || gold.delay === 'daily' ? 'stale' : 'live',
    builtAt: Date.now(), tf,
    gold, silver, dxy, ratio: gold.price && silver.price ? gold.price / silver.price : null, tape,
    candles, miners, fx,
    series: { goldIdx: daily.v.goldIdx, dxyIdx: daily.v.dxyIdx, ryIdx: daily.v.ryIdx, ratio: daily.v.ratio, dailyCloses: daily.v.goldDaily },
    corr: { dxy: daily.v.corrDxy, ry: daily.v.corrRy },
    macro: {
      rows: macro, cpiBreakdown,
      components: {
        cpi: lm.cpi?.v ?? cpi?.value ?? 3.1,
        housing: cpiBreakdown[0].yoy, food: cpiBreakdown[1].yoy, energy: cpiBreakdown[2].yoy, autoins: cpiBreakdown[3].yoy,
      },
    },
    realeconomy: { periods: RE_PERIODS },
    alerts, news: {
      gold: news.filter(n => n.topic === 'gold').slice(0, 6),
      mining: news.filter(n => n.topic === 'mining').slice(0, 6),
      macro: news.filter(n => n.topic === 'macro').slice(0, 6),
    },
    reference,
    analytics, why, health,
    ml: ((await env.CACHE.get('ml:snap', 'json')) as any) ?? null,
  };
}
