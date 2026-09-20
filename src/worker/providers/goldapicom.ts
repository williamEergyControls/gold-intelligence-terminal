import type { Quote } from '../types';
import { fetchJson } from './provider';

/* Gold-API.com — FREE, NO KEY, no stated rate limit.
   Spot prices: XAU XAG XPT XPD HG(copper) BTC ETH.
   Response: { name, price, symbol, updatedAt }.
   Per-isolate memo (20s) so the frontend 20s tick never hammers it.
   Labeled NEAR-LIVE — honest, like everything else. */
const SYMBOLS: Record<string, string> = {
  'XAU:USD': 'XAU', 'XAG:USD': 'XAG', 'XPT:USD': 'XPT', 'XPD:USD': 'XPD',
  'COPPER': 'HG', 'BTC:USD': 'BTC', 'ETH:USD': 'ETH',
};
const memo = new Map<string, { v: Quote; ts: number }>();

export async function goldapiComQuote(symbol: 'XAU:USD' | 'XAG:USD', ttlMs = 20000): Promise<Quote> {
  const m = memo.get(symbol);
  if (m && Date.now() - m.ts < ttlMs) return m.v;
  const s = SYMBOLS[symbol];
  if (!s) throw new Error('gold-api.com: unknown symbol ' + symbol);
  const j = await fetchJson(`https://api.gold-api.com/price/${s}`, {}, 6000);
  const price = Number(j?.price ?? j?.value);
  if (!isFinite(price) || price <= 0) throw new Error('gold-api.com: bad price');
  const tsRaw = Date.parse(String(j?.updatedAt ?? ''));
  const q: Quote = {
    symbol, price, currency: 'USD', unit: 'troy oz',
    source: 'gold-api.com', delay: 'near-live', ts: isFinite(tsRaw) ? tsRaw : Date.now(),
  };
  memo.set(symbol, { v: q, ts: Date.now() });
  return q;
}
