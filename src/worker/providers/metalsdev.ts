import type { Env, Quote } from '../types';
import { fetchJson, secret } from './provider';

// Free plan, key required, provider states ≤60s delay. We label it NEAR-LIVE, never LIVE.
export async function metalsdevQuote(env: Env, symbol: 'XAU:USD' | 'XAG:USD'): Promise<Quote> {
  const key = secret(env, 'METALS_API_KEY');
  if (!key) throw new Error('METALS_API_KEY not configured');
  const j = await fetchJson(`https://api.metals.dev/v1/latest?api_key=${key}&currency=USD&unit=toz`);
  const k = symbol === 'XAU:USD' ? 'gold' : 'silver';
  const price = j?.metals?.[k];
  if (typeof price !== 'number') throw new Error('metals.dev: no ' + k);
  // metals.dev /latest carries no prevClose — bootstrap fills it from our own stored day-close.
  return { symbol, price, currency: 'USD', unit: 'troy oz', source: 'metals.dev', delay: 'near-live', ts: Date.now() };
}
