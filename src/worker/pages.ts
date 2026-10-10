import type { Env, Quote } from './types';
import { AppCache } from './cache';
import * as yahoo from './providers/yahoo';
import { eiaRows, type EiaRow } from './providers/eia';
import { readSeries } from './store/ingest';

/* 3-2-1 crack spread, $/bbl: 3 bbl crude → 2 bbl gasoline + 1 bbl distillate.
   (2 × RBOB × 42 + 1 × HO × 42 − 3 × WTI) / 3. RBOB and HO quote in $/gal (42 gal per bbl).
   a quote above $20/gal is a cents print or a bad tick → scaled or dropped, never shown as-is. */
export function crack321(cl: number, rb: number, ho: number): number | null {
  const g = (x: number) => (x > 20 && x < 2000 ? x / 100 : x);
  rb = g(rb); ho = g(ho);
  if (!(cl > 5 && cl < 400 && rb > 0.3 && rb < 15 && ho > 0.3 && ho < 15)) return null;
  const v = (2 * rb * 42 + ho * 42 - 3 * cl) / 3;
  return v > -40 && v < 150 ? +v.toFixed(2) : null;
}
async function crackHistory(env: Env): Promise<{ t: number; v: number; rb: number; ho: number; cl: number }[]> {
  const S = await readSeries(env, ['OIL', 'RBOB', 'HEATOIL'], Date.now() - 400 * 864e5);
  const rb = new Map((S.RBOB ?? []).map(p => [p.t, p.v])), ho = new Map((S.HEATOIL ?? []).map(p => [p.t, p.v]));
  const out: { t: number; v: number; rb: number; ho: number; cl: number }[] = [];
  for (const p of S.OIL ?? []) {
    const r = rb.get(p.t), h = ho.get(p.t);
    if (r == null || h == null) continue;
    const v = crack321(p.v, r, h);
    if (v != null) out.push({ t: p.t, v, rb: r, ho: h, cl: p.v });
  }
  return out;
}

const ENERGY: { sym: string; name: string; unit: string }[] = [
  { sym: 'CL1', name: 'WTI Crude Front', unit: '$/bbl' },
  { sym: 'CO1', name: 'Brent Crude Front', unit: '$/bbl' },
  { sym: 'NG1', name: 'Henry Hub Nat Gas', unit: '$/MMBtu' },
  { sym: 'HO1', name: 'Heating Oil', unit: '$/gal' },
  { sym: 'XB1', name: 'RBOB Gasoline', unit: '$/gal' },
];
const AGRI: { sym: string; name: string; unit: string }[] = [
  { sym: 'C1', name: 'Corn Front', unit: 'cents/bu' },
  { sym: 'S1', name: 'Soybeans Front', unit: 'cents/bu' },
  { sym: 'W1', name: 'Wheat Front', unit: 'cents/bu' },
  { sym: 'CT1', name: 'Cotton', unit: 'cents/lb' },
  { sym: 'LC1', name: 'Live Cattle', unit: 'cents/lb' },
  { sym: 'FC1', name: 'Feeder Cattle', unit: 'cents/lb' },
];

async function getQuotes(env: Env, syms: { sym: string; name: string; unit: string }[], cacheKey: string): Promise<(Quote & { unit: string })[]> {
  const cache = new AppCache(env);
  // yahoo → last good copy (labeled stale) → throw; the page endpoint then serves its own last good copy
  const r = await cache.wrap(cacheKey, 300, async () => {
    const all = [...syms.map(s => s.sym), 'XAU:USD', 'DXY'];
    const q = await yahoo.yahooBatchQuotes(all);
    if (q.length >= 3) return q;
    throw new Error('thin: ' + q.length);
  });
  const out = (r.v as Quote[]).map(q => (r.stale ? { ...q, delay: 'stale' as const } : q));
  return out.map(q => {
    const m = syms.find(s => s.sym === q.symbol);
    return { ...q, name: m?.name ?? q.name, unit: m?.unit ?? '' } as (Quote & { unit: string });
  });
}

/** crack spread KPI + 1-year history. live legs from the quote batch when there is one, else the warehouse close */
export async function crackBlock(env: Env, legs: { cl: number; rb: number; ho: number } | null) {
  const live = legs ? crack321(legs.cl, legs.rb, legs.ho) : null;
  let hist: Awaited<ReturnType<typeof crackHistory>> = [];
  // daily closes: one shared 6 h copy for the energy page and /api/energy/crack (≈ 750 rows per rebuild, 4 a day)
  try { hist = (await new AppCache(env).wrap('crack:hist', 21600, () => crackHistory(env))).v; } catch (e) { console.error('CRACK_HIST_FAIL', String((e as Error)?.message ?? e).slice(0, 120)); }
  const lastH = hist.length ? hist[hist.length - 1] : null;
  const crackNow = live ?? lastH?.v ?? null;
  const at = (days: number) => { const t = Date.now() - days * 864e5; for (let i = hist.length - 1; i >= 0; i--) if (hist[i].t <= t) return hist[i].v; return null; };
  const vals = hist.map(h => h.v).sort((a, b) => a - b);
  const pct = crackNow != null && vals.length > 50 ? Math.round(100 * vals.filter(v => v <= crackNow).length / vals.length) : null;
  return {
    now: crackNow, live: live != null, asOf: live != null ? Date.now() : lastH?.t ?? null,
    m1: at(30), y1: at(365), pct1y: pct,
    legs: live != null ? legs : lastH ? { cl: lastH.cl, rb: lastH.rb, ho: lastH.ho } : null,
    series: hist.map(h => ({ t: h.t, v: h.v })),
    formula: '(2 × RBOB × 42 + 1 × ULSD × 42 − 3 × WTI) ÷ 3, in $ per barrel of crude',
  };
}

export async function buildEnergyPage(env: Env): Promise<any> {
  const monitor = await getQuotes(env, ENERGY, 'page:energy:q');
  const get = (s: string) => monitor.find(q => q.symbol === s);
  const hero = get('CL1') ?? monitor[0];
  const xau = get('XAU:USD');
  const cl = get('CL1'), bz = get('CO1'), xb = get('XB1'), ho = get('HO1');

  const spreads: any[] = [];
  if (cl && bz) {
    spreads.push({ label: 'Brent-WTI Spread', value: (bz.price - cl.price).toFixed(2) + ' $/bbl', change: null });
  }
  const crack = await crackBlock(env, cl && xb && ho ? { cl: cl.price, rb: xb.price, ho: ho.price } : null);
  if (crack.now != null) spreads.push({ label: '3-2-1 crack spread', value: crack.now.toFixed(2) + ' $/bbl', change: null });

  // EIA weekly — own 6h cache so the 15-min page rebuild never re-hits EIA
  let eia: EiaRow[] = [];
  try { eia = (await new AppCache(env).wrap('eia:rows', 21600, () => eiaRows(env))).v; }
  catch (e) { console.error('EIA_FAIL', String((e as Error)?.message ?? e).slice(0, 200)); }

  const mode = monitor[0]?.delay === 'stale' ? 'stale' : 'live';
  return {
    mode, builtAt: Date.now(), tf: '1D',
    hero, tape: monitor.filter(q => q.symbol !== 'XAU:USD' && q.symbol !== 'DXY'),
    monitor,
    spotlights: monitor.filter(q => q.symbol !== 'XAU:USD' && q.symbol !== 'DXY')
      .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
      .slice(0, 3)
      .map(q => ({ symbol: q.symbol, name: q.name ?? q.symbol, price: q.price, changePct: q.changePct ?? 0, note: q.unit })),
    ratios: xau && cl ? [{ label: 'GOLD / OIL', value: +(xau.price / cl.price).toFixed(1), unit: 'barrels per ounce' }] : [],
    spreads,
    crack,
    eia,
    news: [],
    calendar: [
      { when: 'WED 09:30', event: 'EIA Petroleum Status', note: 'weekly stocks' },
      { when: 'THU 09:30', event: 'EIA Nat Gas Storage', note: 'weekly' },
      { when: 'FRI 12:00', event: 'Baker Hughes Rig Count', note: 'weekly' },
    ],
    health: [],
  };
}

export async function buildAgriPage(env: Env): Promise<any> {
  const monitor = await getQuotes(env, AGRI, 'page:agri:q');
  const get = (s: string) => monitor.find(q => q.symbol === s);
  const hero = get('C1') ?? monitor[0];
  const xau = get('XAU:USD');
  const c = get('C1');

  const mode = monitor[0]?.delay === 'stale' ? 'stale' : 'live';

  let water: any = null;
  try {
    const ws = await import('./providers/water');
    const wp = await ws.waterPanel(env);
    water = wp;
  } catch { water = null; }

  let weather: any = null;
  try {
    const om = await import('./providers/openmeteo');
    weather = await om.plainsWeather();
  } catch { weather = null; }

  return {
    mode, builtAt: Date.now(), tf: '1D',
    hero, tape: monitor.filter(q => q.symbol !== 'XAU:USD'),
    monitor,
    spotlights: monitor.filter(q => q.symbol !== 'XAU:USD')
      .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
      .slice(0, 3)
      .map(q => ({ symbol: q.symbol, name: q.name ?? q.symbol, price: q.price, changePct: q.changePct ?? 0, note: q.unit })),
    ratios: xau && c ? [{ label: 'GOLD / CORN', value: +(xau.price / (c.price / 100)).toFixed(0), unit: 'bushels per ounce' }] : [],
    spreads: [],
    water, weather,
    news: [],
    calendar: [
      { when: 'MON 15:00', event: 'USDA Crop Progress', note: 'weekly' },
      { when: 'MONTHLY', event: 'USDA WASDE', note: 'supply & demand' },
    ],
    health: [],
  };
}
