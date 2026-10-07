/* ================================================================
   ML STRIP — one compact payload rendered as a band on every page.
   inputs (all precomputed, no upstream calls):
     KV ml:snap (gold 5-day model) · D1 prediction_outcomes (live hit rate)
     D1 snapshots vol:* (GARCH, regimes, stress, σ alerts)
   ================================================================ */
import type { Env } from '../types';
import { cacheGet } from '../cache';
import { readSnapshots, type VolRow } from '../vol/snapshot';

const FOCUS: Record<string, string[]> = {
  home: ['GOLD', 'VIX', 'UST10Y', 'DXY'],
  gold: ['GOLD', 'GVZ', 'SILVER', 'TIPS10Y'],
  fx: ['DXY', 'EURUSD', 'USDJPY', 'USDCNY'],
  stable: ['USDT', 'USDC', 'DAI', 'USDE'],
  energy: ['OIL', 'BRENT', 'NATGAS', 'OVX'],
  agri: ['CORN', 'WHEAT', 'SOY', 'DXY'],
  vol: ['VIX', 'MOVE', 'GVZ', 'OVX'],
  ai: ['GOLD', 'GVZ', 'DXY', 'TIPS10Y'],
  shipping: ['BDRY', 'BWET', 'BRENT'],
  water: ['PHO', 'CORN'],
  land: ['LAND', 'FPI', 'UST10Y'],
  news: ['GOLD', 'VIX', 'DXY', 'OIL'],
  search: ['GOLD', 'VIX'],
};
/* page extras: non-vol facts the desk cares about, read from caches the crons already fill */
async function extras(env: Env, page: string): Promise<{ id: string; k: string; b: string; d: string; cls: string; href: string; title?: string }[]> {
  const out: { id: string; k: string; b: string; d: string; cls: string; href: string; title?: string }[] = [];
  const pct = (v: number | null | undefined, d = 1) => (v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : '') + v.toFixed(d) + '%');
  try {
    if (page === 'water' || page === 'agri') {
      const dr = await env.CACHE.get('drought:usdm', 'json') as any;
      if (dr?.conus) {
        const ch = dr.conus.prevDrought != null ? dr.conus.drought - dr.conus.prevDrought : null;
        out.push({ id: 'DROUGHT', k: 'US drought area', b: dr.conus.drought.toFixed(1) + '%', d: (ch != null ? (ch > 0 ? '+' : '') + ch.toFixed(1) + ' pts w/w · ' : '') + 'map ' + dr.mapDate, cls: ch != null && ch > 0 ? 'dn' : 'up', href: '/water.html', title: 'CONUS area in D1–D4, land-area weighted from USDM state data' });
      }
    }
    if (page === 'water') {
      const pg = await cacheGet(env, 'page:agri') as any;
      const w = pg?.v?.water;
      if (w?.nqH2o) out.push({ id: 'NQH2O', k: 'CA water index', b: '$' + Math.round(w.nqH2o.value).toLocaleString('en-US') + '/AF', d: pct((w.nqH2o.value / w.nqH2o.prior - 1) * 100) + ' vs prior · ' + w.nqH2o.asOf, cls: w.nqH2o.value >= w.nqH2o.prior ? 'up' : 'dn', href: '/water.html', title: 'Nasdaq Veles California Water Index via FRED' });
      const mead = (w?.levels ?? []).find((l: any) => l.site === '09420500');
      if (mead?.elevFt) out.push({ id: 'MEAD', k: 'Lake Mead elevation', b: mead.elevFt.toFixed(1) + ' ft', d: (mead.chg24 != null ? (mead.chg24 > 0 ? '+' : '') + mead.chg24.toFixed(2) + ' ft 24h · ' : '') + 'USGS', cls: 'mut', href: '/water.html' });
    }
    if (page === 'shipping') {
      const c = await env.CACHE.get('ship:choke', 'json') as any;
      const rows = (c?.v?.rows ?? []) as any[];
      for (const [id, label] of [['chokepoint1', 'Suez transits'], ['chokepoint2', 'Panama transits']] as const) {
        const s = rows.filter(r => r.portid === id).sort((a, b) => String(a.date).localeCompare(String(b.date))).map(r => Number(r.n_total) || 0);
        if (s.length >= 14) {
          const a7 = s.slice(-7).reduce((x, y) => x + y, 0) / 7, p = s.slice(-35, -7), p28 = p.reduce((x, y) => x + y, 0) / Math.max(1, p.length);
          out.push({ id, k: label + ' (7d avg)', b: a7.toFixed(0) + '/day', d: pct(p28 ? (a7 / p28 - 1) * 100 : null) + ' vs prior 4 wks · PortWatch', cls: a7 >= p28 ? 'up' : 'dn', href: '/shipping.html' });
        }
      }
      const w = await env.CACHE.get('ship:wci', 'json') as any;
      if (w?.v?.composite) out.push({ id: 'WCI', k: 'Container rate (WCI)', b: '$' + w.v.composite.toLocaleString('en-US') + '/FEU', d: pct(w.v.chgPct, 0) + ' w/w · Drewry ' + w.v.asOf, cls: (w.v.chgPct ?? 0) >= 0 ? 'up' : 'dn', href: '/shipping.html' });
    }
    if (page === 'news' || page === 'home') {
      const r = await env.DB.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN ai_json LIKE '%"idea":{%' THEN 1 ELSE 0 END) ideas FROM news_items WHERE published > ?`).bind(Date.now() - 864e5).first<{ n: number; ideas: number | null }>();
      if (r?.n) out.push({ id: 'NEWS', k: 'News, last 24h', b: r.n + ' stories', d: (r.ideas ?? 0) + ' with a trade idea', cls: 'mut', href: '/news.html' });
    }
  } catch { /* extras never break the strip */ }
  return out;
}
const memo = new Map<string, { ts: number; v: unknown }>();

export async function mlStrip(env: Env, page: string): Promise<unknown> {
  const key = FOCUS[page] ? page : 'home';
  const m = memo.get(key);
  if (m && Date.now() - m.ts < 60000) return m.v;

  const [snap, acc, vol] = await Promise.all([
    env.CACHE.get('ml:snap', 'json').catch(() => null) as Promise<any>,
    env.DB.prepare('SELECT COUNT(*) n, SUM(correct) c FROM prediction_outcomes').first<{ n: number; c: number | null }>().catch(() => null),
    readSnapshots(env).catch(() => ({} as Record<string, { ts: number; v: any }>)),
  ]);
  const rows: VolRow[] = [];
  for (const [k, s] of Object.entries(vol)) if (k !== 'x') rows.push(...((s.v?.rows ?? []) as VolRow[]));
  const byId = new Map(rows.map(r => [r.id, r]));
  const focusIds = FOCUS[key];
  const focus = focusIds.map(id => byId.get(id)).filter((r): r is VolRow => !!r).map(r => ({
    id: r.id, label: r.label, kind: r.kind, last: r.last, chg: r.chg, chgUnit: r.chgUnit,
    rv20: r.rv20 ?? null, volUnit: r.volUnit ?? null, garch20: r.garch?.sig20Ann ?? null,
    pct: r.pct, regime: r.regime, z: r.z, exp5d: r.exp5d ?? null, devBp: (r.extra?.devBp as number | undefined) ?? null,
    source: r.source, lastTs: r.lastTs, stale: r.stale,
  }));
  const x = vol.x?.v;
  const alerts = ((x?.alerts ?? []) as { id: string; label: string; z: number; chg: number | null; chgUnit: string; ts: number | null }[])
    .sort((a, b) => Number(focusIds.includes(b.id)) - Number(focusIds.includes(a.id)) || Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 3);
  const n = acc?.n ?? 0;
  const ex = await extras(env, key);
  const v = {
    ts: Date.now(), page: key, extras: ex,
    ml: snap?.direction ? {
      model: 'gold 5-day · LR + GBS + HMM + 10 agents', dir: snap.direction, p: snap.p, regime: snap.regime?.state ?? null,
      score: snap.final?.score ?? null, hit: n ? (acc!.c ?? 0) / n : null, graded: n, ts: snap.ts,
    } : null,
    stress: x?.stress ? { score: x.stress.score, regime: x.stress.regime } : null,
    focus, alerts,
    volBuiltAt: Math.max(0, ...Object.values(vol).map(s => s.ts)) || null,
  };
  memo.set(key, { ts: Date.now(), v });
  return v;
}
