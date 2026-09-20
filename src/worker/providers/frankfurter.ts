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
  // PER-CURRENCY week series — a shared hi/lo mixed JPY~150 with EUR~0.9 and
  // made every range bar meaningless. Each pair now gets its own week band.
  const per: Record<string, number[]> = {};
  for (const dt of dates) for (const [c, v] of Object.entries(j.rates[dt] as Record<string, number>)) (per[c] ??= []).push(v);
  const ts = Date.parse(dates[dates.length - 1] + 'T16:00:00Z');
  return Object.entries(last as Record<string, number>).map(([ccy, rate]) => {
    const quoted = QUOTED.includes(ccy);
    const price = quoted ? 1 / rate : rate;
    const prevP = prev ? (quoted ? 1 / (prev as any)[ccy] : (prev as any)[ccy]) : undefined;
    const series = per[ccy] ?? [rate];
    const h = quoted ? 1 / Math.min(...series) : Math.max(...series);
    const l = quoted ? 1 / Math.max(...series) : Math.min(...series);
    const q: Quote = {
      symbol: quoted ? `${ccy}/USD` : `USD/${ccy}`,
      price, prevClose: prevP, currency: 'USD',
      source: 'frankfurter/ECB', delay: 'daily', ts: isFinite(ts) ? ts : Date.now(),
      wkHigh: isFinite(h) ? h : undefined, wkLow: isFinite(l) ? l : undefined,
    };
    if (prevP) { q.change = price - prevP; q.changePct = (price / prevP - 1) * 100; }
    return q;
  });
}
