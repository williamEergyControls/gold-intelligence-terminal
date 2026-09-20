import type { Env, Quote } from '../types';
import { fetchJson, secret } from './provider';

// ONE /latest call returns ALL metals. Cached per-isolate so gold+silver cost a
// single upstream request per TTL window. METALS_TTL (vars, seconds) throttles
// quota burn: 300s = ≤288 calls/day worst case. Check your plan's limit in the
// metals.dev dashboard; if it's monthly, set METALS_TTL=900 in wrangler vars.
interface MetalsLatest { gold: number; silver: number; ts: number }
const microMd = new Map<string, MetalsLatest>();

export async function metalsdevLatest(env: Env): Promise<MetalsLatest> {
  const m = microMd.get('md');
  const ttlMs = 1000 * Math.max(60, parseInt(env.METALS_TTL ?? '300', 10) || 300);
  if (m && Date.now() - m.ts < ttlMs) return m;
  const key = secret(env, 'METALS_API_KEY');
  if (!key) throw new Error('METALS_API_KEY not configured');
  const j = await fetchJson(`https://api.metals.dev/v1/latest?api_key=${key}&currency=USD&unit=toz`);
  const gold = j?.metals?.gold, silver = j?.metals?.silver;
  if (typeof gold !== 'number' || typeof silver !== 'number') throw new Error('metals.dev: bad payload');
  const out: MetalsLatest = { gold, silver, ts: Date.now() };
  microMd.set('md', out);
  return out;
}

export async function metalsdevQuote(env: Env, symbol: 'XAU:USD' | 'XAG:USD'): Promise<Quote> {
  const l = await metalsdevLatest(env);
  // /latest carries no prevClose — bootstrap fills it from stored day-close / daily series.
  return { symbol, price: symbol === 'XAU:USD' ? l.gold : l silver, currency: 'USD', unit: 'troy oz', source: 'metals.dev', delay: 'near-live', ts: l.ts };
}
