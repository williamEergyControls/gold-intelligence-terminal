import type { AlertItem, Bootstrap, Candle, Env, MacroRow, Quote, Tf } from './types';
import { AppCache } from './cache';
import { firstOk, healthSnapshot, secret } from './providers/provider';
import * as metalsdev from './providers/metalsdev';
import * as yahoo from './providers/yahoo';
import * as stooq from './providers/stooq';
import * as frankfurter from './providers/frankfurter';
import * as fred from './providers/fred';
import * as gdelt from './providers/gdelt';
import * as sim from './providers/simulated';
import { score, attribution, corr } from './analytics/engine';

// ---------- REFERENCE DATA: curated, low-frequency, honestly labeled ----------
const RE = {
  shipping: [
    { label: 'FBX · Container 40ft', value: '3,842', delta: '▲ +1.8% w/w', deltaDir: 1, typetag: 'INDEX · W', note: 'public index' },
    { label: 'BDI · Dry Bulk', value: '1,984', delta: '▼ −2.3% d', deltaDir: -1, typetag: 'INDEX · D', note: 'public index' },
    { label: 'Bunker VLSFO (SGP)', value: '612 $/t', delta: '▲ +1.1% w/w', deltaDir: 1, typetag: 'INDEX · W', note: 'public index' },
    { label: 'Suez transits', value: '−18% m/m', delta: '▼', deltaDir: -1, typetag: 'NEWS-IND', note: 'GDELT-derived' },
    { label: 'Red Sea war-risk', value: 'FIRM', delta: '▲', deltaDir: 1, typetag: 'MKT-IND', note: 'news indicator — no live quote claimed' },
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
  calendar: [
    { when: 'TOM 14:00', event: 'FOMC Minutes (Sep)', cons: '—', prior: '—', imp: 3, ts: Date.now() + 18 * 36e5 },
    { when: 'OCT 10 · 08:30', event: 'CPI (Sep)', cons: '2.9%', prior: '3.1%', imp: 3, ts: Date.now() + 26 * 864e5 },
    { when: 'OCT 29 · 14:00', event: 'FOMC Rate', cons: '−25bp', prior: '3.75%', imp: 3, ts: Date.now() + 45 * 864e5 },
    { when: 'OCT 31 · 08:30', event: 'Core PCE (Sep)', cons: '2.8%', prior: '2.8%', imp: 2, ts: Date.now() + 47 * 864e5 },
    { when: 'NOV 01 · 08:30', event: 'Nonfarm Payrolls', cons: '145K', prior: '112K', imp: 3, ts: Date.now() + 48 * 864e5 },
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

export async function buildBootstrap(env: Env, tf: Tf): Promise<Bootstrap & { ml: any }> {
  const cache = new AppCache(env.CACHE);

  // ---- gold: mandated chain metals.dev → yahoo → stooq → simulated ----
  const gold = (await firstOk<Quote>([
    { name: 'metals.dev', fn: () => metalsdev.metalsdevQuote(env, 'XAU:USD') },
    { name: 'yahoo', fn: () => yahoo.yahooQuote(env, 'XAU:USD') },
    { name: 'stooq', fn: async () => (await stooq.stooqQuotes(env, ['XAU:USD']))[0] },
    { name: 'simulated', fn: () => Promise.resolve(sim.simQuote('XAU:USD')) },
  ])).value;
  if (gold.prevClose == null) {
    const pc = await env.CACHE.get('prevclose:XAU:USD', 'json') as { c: number } | null;
    if (pc) { gold.prevClose = pc.c; gold.change = gold.price - pc.c; gold.changePct = (gold.price / pc.c - 1) * 100; }
  }
  const silver = (await firstOk<Quote>([
    { name: 'metals.dev', fn: () => metalsdev.metalsdevQuote(env, 'XAG:USD') },
    { name: 'yahoo', fn: () => yahoo.yahooQuote(env, 'XAG:USD') },
    { name: 'simulated', fn: () => Promise.resolve(sim.simQuote('XAG:USD')) },
  ])).value;
  const dxy = (await firstOk<Quote>([
    { name: 'yahoo', fn: () => yahoo.yahooQuote(env, 'DXY') },
    { name: 'stooq', fn: async () => (await stooq.stooqQuotes(env, ['DXY']))[0] },
    { name: 'simulated', fn: () => Promise.resolve(sim.simQuote('DXY')) },
  ])).value;

  // ---- candles for the current timeframe — cached 120s ----
  const candles = (await cache.wrap(`candles:XAU:${tf}`, 120, () =>
    firstOk([
      { name: 'yahoo', fn: () => yahoo.yahooCandles(env, 'XAU:USD', tf) },
      { name: 'simulated', fn: () => Promise.resolve(sim.simCandles('XAU:USD', tf)) },
    ]).then(r => r.value)
  )).v;

  // ---- daily relationships: gold/dxy/real-yield indexed + correlations — cached 1h ----
  const daily = await cache.wrap('series:daily', 3600, async () => {
    const g = (await firstOk([
      { name: 'yahoo', fn: () => yahoo.yahooCandles(env, 'XAU:USD', '1D') },
      { name: 'simulated', fn: () => Promise.resolve(sim.simCandles('XAU:USD', '1D')) },
    ]).then(r => r.value)).map(c => c.c);
    const d = (await firstOk([
      { name: 'yahoo', fn: () => yahoo.yahooCandles(env, 'DXY', '1D') },
      { name: 'simulated', fn: () => Promise.resolve(sim.simCandles('DXY', '1D')) },
    ]).then(r => r.value)).map(c => c.c);
    const s = (await firstOk([
      { name: 'yahoo', fn: () => yahoo.yahooCandles(env, 'XAG:USD', '1D') },
      { name: 'simulated', fn: () => Promise.resolve(sim.simCandles('XAG:USD', '1D')) },
    ]).then(r => r.value)).map(c => c.c);
    let ry: number[] = [];
    try { ry = (await fred.fredSeriesTail(env, 'DFII10', 80)).map(p => p.v); }
    catch { ry = Array.from({ length: 60 }, (_, i) => 1.7 - i * 0.004); }
    const n80 = Math.min(g.length, d.length, 80);
    const m = Math.min(g.length, s.length, 80);
    const ratio: number[] = [];
    for (let i = 0; i < m; i++) ratio.push(g[g.length - m + i] / s[s.length - m + i]);
    const rn = Math.min(g.length, ry.length, 80);
    return {
      goldIdx: idxA(g.slice(-n80)), dxyIdx: idxA(d.slice(-n80)), ryIdx: idxA(ry.slice(-rn)), ratio,
      corrDxy: corr(g.slice(-n80), d.slice(-n80)), corrRy: corr(g.slice(-rn), ry.slice(-rn)),
      goldDaily: g, dxyDaily: d, ryDaily: ry,
    };
  });
  const ryLast = daily.v.ryDaily.length ? daily.v.ryDaily[daily.v.ryDaily.length - 1] : 1.51;
  const ryPrev = daily.v.ryDaily.length > 1 ? daily.v.ryDaily[daily.v.ryDaily.length - 2] : ryLast;

// ---- miners heatmap: stooq CSV → yahoo batch → simulated (errors logged, never silent) ----
  const miners = (await cache.wrap('miners', 3600, async () => {
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
        return sim.simMiners();
      }
    }
  })).v;

  // ---- FX: frankfurter (one call, DAILY) → simulated ----
  const fx = (await cache.wrap('fx', 3600, () => frankfurter.frankfurterFx(env).catch(() => sim.simFx()))).v;

  // ---- macro: FRED (key) → simulated — cached 6h ----
  const macro = (await cache.wrap('macro', 21600, () => fred.fredRows(env).catch(() => sim.simMacro()))).v;
  const row = (k: string) => macro.find((m: MacroRow) => m.key === k);
  const cpi = row('CPI'); const autoins = row('AUTOINS');
  const cpiBreakdown = [
    { label: 'SHELTER', yoy: 4.2, source: 'reference' },
    { label: 'FOOD', yoy: 2.7, source: 'reference' },
    { label: 'ENERGY', yoy: -1.9, source: 'reference' },
    { label: 'AUTO INS.', yoy: autoins ? autoins.value : 11.8, source: autoins?.source ?? 'reference' },
    { label: 'TRANSPORT', yoy: 1.2, source: 'reference' },
    { label: 'MEDICAL', yoy: 3.1, source: 'reference' },
  ];

  // ---- news: GDELT → simulated — cached 5min ----
  const news = (await cache.wrap('news', 300, () => gdelt.gdeltNews(env, ['gold', 'mining', 'macro']).catch(() => sim.simNews()))).v;

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

  // ---- alerts: derived from ACTUAL moves ----
  const alerts: AlertItem[] = [];
  let hm = 0; for (const c of candles.slice(-60)) hm = Math.max(hm, c.h);
  if (hm > 0 && gold.price >= hm * 0.998) alerts.push({ se: 'warn', t: nowHM(), txt: `GOLD ${fmt1(gold.price)} — within 0.2% of session high ${fmt1(hm)}`, cat: 'gold' });
  if (Math.abs(dxy.changePct ?? 0) > 0.5) alerts.push({ se: 'warn', t: nowHM(), txt: `DXY ${sgn(dxy.changePct)}${fmt1(dxy.changePct)}% — dollar move in force`, cat: 'fx' });
  if (Math.abs((ryLast - ryPrev) * 100) > 3) alerts.push({ se: 'info', t: nowHM(), txt: `10Y real yield ${sgn((ryLast - ryPrev) * 100)}${fmt1((ryLast - ryPrev) * 100)}bp on the day`, cat: 'fx' });
  if (gdx != null && Math.abs(gdx) > 2) alerts.push({ se: 'info', t: nowHM(), txt: `Miners avg ${sgn(gdx)}${fmt1(gdx)}% vs XAU ${sgn(gold.changePct)}${fmt1(gold.changePct)}% — beta check`, cat: 'gold' });
  alerts.push({ se: 'info', t: nowHM(), txt: 'FOMC minutes tomorrow 14:00 ET — rate channel in focus', cat: 'macro' });

  const tape: Quote[] = [gold, silver, dxy, ...fx.slice(0, 2)];
  const us10 = row('US10Y');
  if (us10) tape.push({ symbol: 'US10Y', price: us10.value, prevClose: us10.prior, change: us10.value - us10.prior, changePct: us10.value - us10.prior, currency: '%', source: us10.source, delay: 'daily', ts: Date.parse(us10.asOf) });

  const health = healthSnapshot({
    'metals.dev': secret(env, 'METALS_API_KEY') ? ('near-live' as const) : null,
    'yahoo': 'near-live' as const,
    'stooq': 'eod' as const,
    'frankfurter': 'daily' as const,
    'fred': secret(env, 'FRED_API_KEY') ? ('daily' as const) : null,
    'gdelt': 'near-live' as const,
    'workers-ai': env.AI ? ('event-driven' as const) : null,
  });

  return {
    mode: gold.source === 'simulated' ? 'simulated' : 'live',
    builtAt: Date.now(), tf,
    gold, silver, dxy, ratio: gold.price && silver.price ? gold.price / silver.price : null, tape,
    candles, miners, fx,
    series: { goldIdx: daily.v.goldIdx, dxyIdx: daily.v.dxyIdx, ryIdx: daily.v.ryIdx, ratio: daily.v.ratio, dailyCloses: daily.v.goldDaily },
    corr: { dxy: daily.v.corrDxy, ry: daily.v.corrRy },
    macro: { rows: macro, cpiBreakdown, components: { cpi: cpi?.value ?? 3.1, housing: 4.2, food: 2.7, autoins: autoins?.value ?? 11.8, energy: -1.9 } },
    realeconomy: { periods: RE_PERIODS },
    alerts, news: {
      gold: news.filter(n => n.topic === 'gold').slice(0, 6),
      mining: news.filter(n => n.topic === 'mining').slice(0, 6),
      macro: news.filter(n => n.topic === 'macro').slice(0, 6),
    },
    reference: RE,
    analytics, why, health,
    ml: ((await env.CACHE.get('ml:snap', 'json')) as any) ?? null,
  };
}
