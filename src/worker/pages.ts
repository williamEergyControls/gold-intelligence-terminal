import type { Env, NewsItem, PagePayload, Quote, SpotCard, Tf } from './types';
import { AppCache } from './cache';
import { firstOk } from './providers/provider';
import * as yahoo from './providers/yahoo';
import * as gdelt from './providers/gdelt';
import * as sim from './providers/simulated';
import * as eia from './providers/eia';
import * as water from './providers/water';
import * as openmeteo from './providers/openmeteo';
import { persistQuotesAsBars } from './ml/pipeline';

/* ===================== page symbol registries ===================== */
const ENERGY: { sym: string; name: string; unit: string }[] = [
  { sym: 'CL1', name: 'WTI Crude Front', unit: '$/bbl' },
  { sym: 'CO1', name: 'Brent Crude Front', unit: '$/bbl' },
  { sym: 'NG1', name: 'Henry Hub Nat Gas', unit: '$/MMBtu' },
  { sym: 'HO1', name: 'Heating Oil', unit: '$/gal' },
  { sym: 'XB1', name: 'RBOB Gasoline', unit: '$/gal' },
];
const AGRI: { sym: string; name: string; unit: string }[] = [
  { sym: 'C1', name: 'Corn Front', unit: '$/bu' },
  { sym: 'S1', name: 'Soybeans Front', unit: '$/bu' },
  { sym: 'W1', name: 'Wheat Front', unit: '$/bu' },
  { sym: 'CT1', name: 'Cotton', unit: '¢/lb' },
  { sym: 'SB1', name: 'Sugar', unit: '¢/lb' },
  { sym: 'LC1', name: 'Live Cattle', unit: '¢/lb' },
  { sym: 'FC1', name: 'Feeder Cattle', unit: '¢/lb' },
];
const ENERGY_CAL = [
  { when: 'WED 09:30', event: 'EIA Petroleum Status', note: 'weekly stocks' },
  { when: 'THU 09:30', event: 'EIA Nat Gas Storage', note: 'weekly injection/withdrawal' },
  { when: 'FRI 12:00', event: 'Baker Hughes Rig Count', note: 'weekly' },
];
const AGRI_CAL = [
  { when: 'MON 15:00', event: 'USDA Crop Progress', note: 'weekly — planting/condition' },
  { when: 'MONTHLY', event: 'USDA WASDE', note: 'supply & demand — watch corn/wheat rows' },
  { when: '31-OCT', event: 'CFTC Commitments (legacy)', note: 'positioning' },
];

async function quotesFor(env: Env, syms: { sym: string; name: string; unit: string }[], cacheKey: string): Promise<(Quote & { unit: string })[]> {
  const cache = new AppCache(env.CACHE);
  const out = (await cache.wrap(cacheKey, 900, async () => {
    try {
      const q = await yahoo.yahooBatchQuotes(syms.map(s => s.sym).concat(['XAU:USD', 'DXY']));
      if (q.length >= 3) return q;
      throw new Error('thin: ' + q.length);
    } catch { return sim.simQuotes(syms.map(s => s.sym)); }
  })).v as Quote[];
  return out.map(q => {
    const m = syms.find(s => s.sym === q.symbol);
    return { ...q, name: m?.name ?? q.name, unit: m?.unit ?? '' } as (Quote & { unit: string });
  });
}

function movers(list: (Quote & { unit: string })[], n: number, notes: Record<string, string> = {}): SpotCard[] {
  return list.slice().sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0)).slice(0, n)
    .map(q => ({ symbol: q.symbol, name: q.name ?? q.symbol, price: q.price, changePct: q.changePct ?? 0, note: notes[q.symbol] ?? q.unit }));
}

async function newsFor(env: Env, topic: 'energy' | 'agri'): Promise<NewsItem[]> {
  const cache = new AppCache(env.CACHE);
  return (await cache.wrap('news:' + topic, 3600, () =>
    gdelt.gdeltNews(env, [topic]).catch(() => sim.simNews().map(n => ({ ...n, topic })))
  )).v.slice(0, 8);
}

/* ===================== ENERGY PAGE ===================== */
export async function buildEnergyPage(env: Env): Promise<PagePayload> {
  const monitor = await quotesFor(env, ENERGY, 'page:energy:q');
  const get = (s: string) => monitor.find(q => q.symbol === s);
  const hero = get('CL1') ?? monitor[0];
  const xau = get('XAU:USD');
  const cl = get('CL1'), bz = get('CO1'), xb = get('XB1'), ho = get('HO1');

  const spreads: PagePayload['spreads'] = [];
  if (cl && bz) {
    const v = bz.price - cl.price;
    const pv = (bz.prevClose ?? bz.price) - (cl.prevClose ?? cl.price);
    spreads.push({ label: 'Brent–WTI Spread', value: v.toFixed(2) + ' $/bbl', change: (pv !== v ? sgn(pv !== 0 ? v - pv : 0) + (v - pv).toFixed(2) : null) });
  }
  if (cl && xb && ho) {
    // 3-2-1 crack: 3 bbl crude -> 2 bbl gasoline + 1 bbl distillate. RB/HO are ¢/gal; 1 bbl = 42 gal.
    const prod = ((2 * xb.price + 1 * ho.price) * 42 / 100) / 3; // $/bbl product value
    spreads.push({ label: '3-2-1 Crack Spread', value: (prod - cl.price).toFixed(2) + ' $/bbl [CALC]', change: null });
  }
  const ratios = xau && cl ? [{ label: 'GOLD / OIL', value: +(xau.price / cl.price).toFixed(1), unit: 'barrels per ounce' }] : [];

  let eiaRows: PagePayload['eia'];
  try {
    const cache = new AppCache(env.CACHE);
    eiaRows = (await cache.wrap('eia:rows', 21600, () => eia.eiaRows(env))).v;
  } catch { eiaRows = undefined; }

  const mode = monitor[0]?.source === 'simulated' ? 'simulated' : 'live';
  const payload: PagePayload = {
    mode, builtAt: Date.now(),
    hero, tape: [hero, ...monitor.slice(1), xau, get('DXY')].filter(Boolean) as Quote[],
    monitor, spotlights: movers(monitor.filter(q => q.symbol !== 'XAU:USD' && q.symbol !== 'DXY'), 3),
    ratios, spreads, eia: eiaRows,
    news: await newsFor(env, 'energy'),
    calendar: ENERGY_CAL,
    health: [],
  };
  await persistQuotesAsBars(env, monitor);
  return payload;
}

/* ===================== AGRI PAGE ===================== */
export async function buildAgriPage(env: Env): Promise<PagePayload> {
  const monitor = await quotesFor(env, AGRI, 'page:agri:q');
  const get = (s: string) => monitor.find(q => q.symbol === s);
  const hero = get('C1') ?? monitor[0];
  const xau = get('XAU:USD'), c = get('C1');

  const ratios = xau && c ? [{ label: 'GOLD / CORN', value: +(xau.price / c.price).toFixed(0), unit: 'bushels per ounce' }] : [];

  let wp: PagePayload['water'];
  try {
    const cache = new AppCache(env.CACHE);
    wp = (await cache.wrap('water:panel', 21600, () => water.waterPanel(env))).v;
  } catch { wp = undefined; }

  let wx: PagePayload['weather'];
  try {
    const cache = new AppCache(env.CACHE);
    wx = (await cache.wrap('wx:plains', 1800, () => openmeteo.plainsWeather())).v;
  } catch { wx = undefined; }

  const mode = monitor[0]?.source === 'simulated' ? 'simulated' : 'live';
  const payload: PagePayload = {
    mode, builtAt: Date.now(),
    hero, tape: [hero, ...monitor.slice(1), xau].filter(Boolean) as Quote[],
    monitor, spotlights: movers(monitor.filter(q => q.symbol !== 'XAU:USD'), 3, {
      W1: 'weather driven', LC1: 'tight supplies', S1: 'export sales watch',
    }),
    ratios, spreads: [], water: wp, weather: wx,
    news: await newsFor(env, 'agri'),
    calendar: AGRI_CAL,
    health: [],
  };
  await persistQuotesAsBars(env, monitor);
  return payload;
}

const sgn = (n: number) => (n > 0 ? '+' : '');
