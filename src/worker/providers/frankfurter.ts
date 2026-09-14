import type { Env, Quote } from '../types';
import { fetchJson } from './provider';

// ECB reference rates: published ~16:00 CET on TARGET days. DAILY — labeled as such, always.
const QUOTED = ['EUR', 'GBP', 'AUD']; // pairs quoted as XXX/USD → invert the USD→XXX rate
export async function frankfurterFx(_env: Env): Promise<Quote[]> {
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const to = ['EUR', 'JPY', 'GBP', 'CAD', 'AUD', 'CNY', 'CHF', 'MXN'].join(',');
  const j = await fetchJson(`https://api.frankfurter.app/${from}..?from=USD&to=${to}`);
  const dates = Object.keys(j?.rates ?? {}).sort();
  if (dates.length < 1) throw new Error('frankfurter: no dates');
  const last = j.rates[dates[dates.length - 1]];
  const prev = dates.length > 1 ? j.rates[dates[dates.length - 2]] : null;
  let wkHigh = -Infinity, wkLow = Infinity;
  for (const d of dates) for (const v of Object.values(j.rates[d] as Record<string, number>)) { wkHigh = Math.max(wkHigh, v); wkLow = Math.min(wkLow, v); }
  const ts = Date.parse(dates[dates.length - 1] + 'T16:00:00Z');
  return Object.entries(last as Record<string, number>).map(([ccy, rate]) => {
    const quoted = QUOTED.includes(ccy);
    const price = quoted ? 1 / rate : rate;
    const prevP = prev ? (quoted ? 1 / (prev as any)[ccy] : (prev as any)[ccy]) : undefined;
    const hi = quoted ? 1 / wkLow : wkHigh, lo = quoted ? 1 / wkHigh : wkLow;
    const q: Quote = {
      symbol: quoted ? `${ccy}/USD` : `USD/${ccy}`,
      price, prevClose: prevP, currency: 'USD',
      source: 'frankfurter/ECB', delay: 'daily', ts: isFinite(ts) ? ts : Date.now(),
      wkHigh: isFinite(hi) ? hi : undefined, wkLow: isFinite(lo) ? lo : undefined,
    };
    if (prevP) { q.change = price - prevP; q.changePct = (price / prevP - 1) * 100; }
    return q;
  });
}
