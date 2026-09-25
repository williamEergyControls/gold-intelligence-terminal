import type { Env, Quote } from './types';
import { AppCache } from './cache';
import * as yahoo from './providers/yahoo';
import * as sim from './providers/simulated';

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
  const cache = new AppCache(env.CACHE);
  const out = (await cache.wrap(cacheKey, 300, async () => {
    try {
      const all = [...syms.map(s => s.sym), 'XAU:USD', 'DXY'];
      const q = await yahoo.yahooBatchQuotes(all);
      if (q.length >= 3) return q;
      throw new Error('thin: ' + q.length);
    } catch {
      return sim.simQuotes(syms.map(s => s.sym));
    }
  })).v as Quote[];
  return out.map(q => {
    const m = syms.find(s => s.sym === q.symbol);
    return { ...q, name: m?.name ?? q.name, unit: m?.unit ?? '' } as (Quote & { unit: string });
  });
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
  if (cl && xb && ho) {
    const prod = ((2 * xb.price + 1 * ho.price) * 42) / 3;
    spreads.push({ label: '3-2-1 Crack Spread', value: (prod - cl.price).toFixed(2) + ' $/bbl [CALC]', change: null });
  }

  const mode = monitor[0]?.source === 'simulated' ? 'simulated' : 'live';
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
    eia: [],
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

  const mode = monitor[0]?.source === 'simulated' ? 'simulated' : 'live';

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
