import type { Candle, MacroRow, NewsItem, Quote, Tf } from '../types';

function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const daySeed = () => Math.floor(Date.now() / 864e5);

const BASE: Record<string, { p: number; prev: number; name?: string }> = {
  'XAU:USD': { p: 4123.2, prev: 4029.1 }, 'XAG:USD': { p: 38.44, prev: 38.02 },
  'DXY': { p: 97.84, prev: 98.5 }, 'GDX': { p: 42.18, prev: 40.93 },
  'WTI': { p: 84.12, prev: 83.09 }, 'SPX': { p: 6112.4, prev: 6094.6 },
  'XPT:USD': { p: 1652.0, prev: 1659.0 }, 'XCU:USD': { p: 5.214, prev: 5.146 },
};

export function simQuote(symbol: string): Quote {
  const b = BASE[symbol] ?? { p: 100, prev: 99.5 };
  const r = rng(daySeed() + symbol.length * 131);
  const price = b.p * (1 + (r() - 0.5) * 0.002);
  const q: Quote = { symbol, price, prevClose: b.prev, currency: 'USD', source: 'simulated', delay: 'simulated', ts: Date.now() };
  q.change = price - b.prev; q.changePct = (price / b.prev - 1) * 100;
  return q;
}
export function simQuotes(symbols: string[]): Quote[] { return symbols.map(simQuote); }

export function simCandles(symbol: string, tf: Tf, n = 220): Candle[] {
  const step = { '5M': 1.2, '15M': 2.2, '1H': 4, '1D': 11, '1W': 26 }[tf];
  const r = rng(daySeed() + symbol.length * 977);
  const end = simQuote(symbol).price;
  let v = end / 1.09; const raw: number[] = [];
  for (let i = 0; i < n; i++) { v += (r() - 0.47) * step * (end / 4123); raw.push(v); }
  const k = end / raw[raw.length - 1];
  const tMs = ({ '5M': 3e5, '15M': 9e5, '1H': 36e5, '1D': 864e5, '1W': 6048e5 }[tf]);
  return raw.map((c, i) => {
    const o = i ? raw[i - 1] : c * 0.999, cc = c * k;
    return { t: Date.now() - (n - 1 - i) * tMs, o: o * k, h: Math.max(o, c) * k * 1.0015, l: Math.min(o, c) * k * 0.9985, c: cc, v: Math.round(6000 + r() * 24000) };
  });
}

export const SIM_MINERS = ['NEM', 'GOLD', 'AEM', 'WPM', 'RGLD', 'KGC', 'GFI', 'AU', 'PAAS', 'CDE', 'HL', 'IAG', 'BVN', 'DRD', 'HMY', 'NGD', 'AUQ', 'SBSW'];
export function simMiners(): Quote[] {
  const r = rng(daySeed() + 55);
  return SIM_MINERS.map((s, i) => {
    const prev = 8 + r() * 120, pct = (r() - 0.42) * 6;
    const price = prev * (1 + pct / 100);
    return { symbol: s, price, prevClose: prev, change: price - prev, changePct: pct, currency: 'USD', source: 'simulated', delay: 'simulated', ts: Date.now() };
  });
}
export function simFx(): Quote[] {
  const r = rng(daySeed() + 77);
  const pairs: [string, number][] = [['EUR/USD', 1.1124], ['USD/JPY', 149.32], ['GBP/USD', 1.2746], ['USD/CAD', 1.3572], ['AUD/USD', 0.6624], ['USD/CNY', 7.248], ['USD/CHF', 0.8621], ['USD/MXN', 17.912]];
  return pairs.map(([s, p]) => { const pct = (r() - 0.5) * 1.4, price = p * (1 + pct / 100), prev = p; return { symbol: s, price, prevClose: prev, change: price - prev, changePct: pct, currency: 'USD', source: 'simulated', delay: 'simulated', ts: Date.now(), wkHigh: price * 1.01, wkLow: price * 0.99 }; });
}
export function simMacro(): MacroRow[] {
  const r = rng(daySeed() + 13);
  const mk = (key: string, label: string, v: number, p: number, unit: MacroRow['unit'], freq: string, delay: MacroRow['delay']): MacroRow =>
    ({ key, label, value: v, prior: p, unit, freq, source: 'simulated', delay, asOf: new Date().toISOString().slice(0, 10), spark: Array.from({ length: 12 }, () => v - 1 + r() * 2.2) });
  return [mk('CPI', 'Headline CPI', 3.1, 3.3, 'pct', 'Monthly', 'monthly'), mk('CORE', 'Core CPI', 3.2, 3.2, 'pct', 'Monthly', 'monthly'), mk('PCE', 'PCE', 2.6, 2.7, 'pct', 'Monthly', 'monthly'), mk('COREPCE', 'Core PCE', 2.8, 2.8, 'pct', 'Monthly', 'monthly'), mk('PPI', 'PPI Final', 1.8, 2.1, 'pct', 'Monthly', 'monthly'), mk('US10Y', '10Y Nominal', 3.842, 3.858, 'bp', 'Daily', 'daily'), mk('REAL10Y', '10Y Real (TIPS)', 1.512, 1.593, 'bp', 'Daily', 'daily')];
}
export function simNews(): NewsItem[] {
  const t = Date.now();
  const mk = (title: string, source: string, topic: NewsItem['topic'], sentiment: NewsItem['sentiment'], minAgo: number): NewsItem =>
    ({ id: 'sim-' + minAgo + title.length, title, source, url: '#', publishedTs: t - minAgo * 6e4, topic, sentiment, sentimentNote: 'SIMULATED PREVIEW' });
  return [
    mk('Gold extends record run as 10Y real yield slides', 'SIM · GDELT-like', 'gold', 'bull', 22),
    mk('Central banks purchased 290t of gold in Q3', 'SIM · WGC-like', 'gold', 'bull', 64),
    mk('Dollar softens as ECB sources flag October cut', 'SIM · macro', 'macro', 'neutral', 91),
    mk('Newmont 8-K: Peñasquito ramp-up ahead of guidance', 'SIM · EDGAR-like', 'mining', 'bull', 115),
    mk('Red Sea transits down 18% m/m — war-risk premiums firm', 'SIM · trade', 'macro', 'bear', 138),
    mk('Bunker fuel (VLSFO) +1.1% w/w in Singapore', 'SIM · shipping', 'macro', 'bear', 160),
    mk('Barrick flags FY cost guidance cut on energy deflation', 'SIM · IR', 'mining', 'bull', 203),
    mk('Auto insurance CPI still sticky at +11.8% y/y', 'SIM · BLS-like', 'macro', 'bear', 245),
    mk('Gold Fields 6-K: South Deep grade miss, Q3 prod -4%', 'SIM · EDGAR-like', 'mining', 'bear', 298),
    mk('Fed’s Waller: policy is restrictive enough', 'SIM · Fed', 'gold', 'bull', 341),
  ];
}
