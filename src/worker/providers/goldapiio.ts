import type { Env, Quote } from '../types';
import { fetchJson, secret } from './provider';

/* GoldAPI.io — RICH data (OHLC, bid/ask, spread, prevClose, karat tables)
   but a ~100/month free quota. So it is NEVER in the request chain.
   It runs ONCE PER DAY in the cron (2 calls: XAU + XAG = ~60/month) and
   seeds the hero panel's OHLC/bid/ask via KV 'goldio:daily'. */

export interface GoldIoSeed {
  ts: number;
  gold: Partial<Quote> & { price: number };
  silver: Partial<Quote> & { price: number };
}

export async function goldapiIoSeed(env: Env): Promise<GoldIoSeed> {
  const key = secret(env, 'GOLDAPI_KEY');
  if (!key) throw new Error('GOLDAPI_KEY not configured');
  const get = async (metal: 'XAU' | 'XAG'): Promise<(Partial<Quote> & { price: number })> => {
    const j: any = await fetchJson(`https://www.goldapi.io/api/price/${metal}/USD`, { 'x-access-token': key }, 9000);
    const price = Number(j?.price);
    if (!isFinite(price) || price <= 0) throw new Error('goldapi.io: bad price');
    return {
      price,
      open: isFinite(Number(j?.open_price)) ? Number(j.open_price) : undefined,
      high: isFinite(Number(j?.high_price)) ? Number(j.high_price) : undefined,
      low: isFinite(Number(j?.low_price)) ? Number(j.low_price) : undefined,
      prevClose: isFinite(Number(j?.prev_close_price)) ? Number(j.prev_close_price) : undefined,
      bid: isFinite(Number(j?.bid)) ? Number(j.bid) : undefined,
      ask: isFinite(Number(j?.ask)) ? Number(j.ask) : undefined,
      change: isFinite(Number(j?.change)) ? Number(j.change) : undefined,
      changePct: isFinite(Number(j?.change_percent)) ? Number(j.change_percent) : undefined,
    };
  };
  const [gold, silver] = await Promise.all([get('XAU'), get('XAG')]);
  return { ts: Date.now(), gold, silver };
}
