import type { Env, Quote } from '../types';
import { fetchText } from './provider';

const S: Record<string, string> = {
  'XAU:USD': 'xauusd', 'XAG:USD': 'xagusd', 'DXY': 'dx.f', 'GDX': 'gdx.us',
  'WTI': 'cl.f', 'SPX': '^spx',
  'GOLD': 'b.us',   // Barrick trades as B on NYSE since May 2025 (GOLD was the old ticker)
  'AGI': 'agi.us',  // Alamos Gold (AUQ was a dead AuRico ticker)
};
const NAMES: Record<string, string> = {
  NEM: 'Newmont', GOLD: 'Barrick', AEM: 'Agnico Eagle', WPM: 'Wheaton PM', RGLD: 'Royal Gold',
  KGC: 'Kinross', GFI: 'Gold Fields', AU: 'AngloGold', PAAS: 'Pan American', CDE: 'Coeur',
  HL: 'Hecla', IAG: 'IAMGOLD', BVN: 'Buenaventura', DRD: 'DRDGOLD', HMY: 'Harmony',
  NGD: 'New Gold', AGI: 'Alamos Gold', SBSW: 'Sibanye',
};
export const minerNames = NAMES;
export const MINERS = Object.keys(NAMES);

export async function stooqQuotes(_env: Env, syms: string[]): Promise<Quote[]> {
  const ours = new Map<string, string>();
  const list = syms.map(s => {
    const mapped = S[s] ?? (s.includes(':') ? s.replace(':', '').toLowerCase() : s.toLowerCase() + '.us');
    ours.set(mapped, s);
    return mapped;
  });
  const csv = await fetchText(`https://stooq.com/q/l/?s=${list.join(',')}&f=sd2t2ohlcv&h&e=csv`);
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('stooq: empty');
  const cols = lines[0].toLowerCase().split(',');
  const ix = (n: string) => cols.indexOf(n);
  const out: Quote[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    const sym = ours.get(f[ix('symbol')]);
    const close = parseFloat(f[ix('close')]);
    if (!sym || !isFinite(close)) continue; // unknown ticker → dropped honestly, not fabricated
    const open = parseFloat(f[ix('open')]);
    const chg = (isFinite(open) && open > 0) ? (close / open - 1) * 100 : undefined;
    const d = f[ix('date')] ?? '';
    const t = f[ix('time')] ?? '';
    const ts = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T${/^\d{2}:\d{2}/.test(t) ? t.slice(0, 8) : '00:00:00'}Z`) : Date.now();
    out.push({
      symbol: sym, name: NAMES[sym], price: close,
      open: isFinite(open) ? open : undefined,
      change: chg != null ? close - open : undefined, changePct: chg,
      currency: 'USD', source: 'stooq', delay: 'eod', ts: isFinite(ts) ? ts : Date.now(),
    });
  }
  if (!out.length) throw new Error('stooq: no rows');
  return out;
}
