import type { Candle, Env, Quote, Tf } from '../types';
import { fetchJson } from './provider';

const Y: Record<string, string> = {
  'XAU:USD': 'GC=F',   // gold futures (spot proxy)
  'XAG:USD': 'SI=F',
  'DXY': 'DX-Y.NYB',
  'GDX': 'GDX', 'SPX': '^GSPC', 'WTI': 'CL=F',
};
export const toYahoo = (s: string) => Y[s] ?? s;

const TF_MAP: Record<Tf, { interval: string; range: string }> = {
  '5M': { interval: '5m', range: '1d' },
  '15M': { interval: '15m', range: '5d' },
  '1H': { interval: '60m', range: '1mo' },
  '1D': { interval: '1d', range: '2y' },
  '1W': { interval: '1wk', range: '5y' },
};

async function chart(sym: string, tf: Tf): Promise<{ meta: any; candles: Candle[] }> {
  const { interval, range } = TF_MAP[tf] ?? TF_MAP['15M'];
  // Unofficial endpoint: two hosts, retry once — 429/999s happen; failover chain covers the rest.
  let lastErr: unknown;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const j = await fetchJson(`https://${host}/v8/finance/chart/${encodeURIComponent(toYahoo(sym))}?interval=${interval}&range=${range}&includePrePost=false`);
      const res = j?.chart?.result?.[0];
      if (!res) throw new Error('empty');
      const ts: number[] = res.timestamp ?? [];
      const q = res.indicators?.quote?.[0] ?? {};
      const candles: Candle[] = [];
      for (let i = 0; i < ts.length; i++) {
        const c = q.close?.[i];
        if (c == null) continue;
        candles.push({ t: ts[i] * 1000, o: q.open?.[i] ?? c, h: q.high?.[i] ?? c, l: q.low?.[i] ?? c, c, v: q.volume?.[i] ?? 0 });
      }
      if (!candles.length) throw new Error('no candles');
      return { meta: res.meta ?? {}, candles };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('yahoo failed');
}

export async function yahooCandles(_env: Env, sym: string, tf: Tf): Promise<Candle[]> {
  return (await chart(sym, tf)).candles;
}
export async function yahooQuote(_env: Env, sym: string): Promise<Quote> {
  const { meta, candles } = await chart(sym, '5M');
  const price = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : candles[candles.length - 1].c;
  const prev = typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : undefined;
  const q: Quote = {
    symbol: sym, price, prevClose: prev,
    open: meta.regularMarketOpen ?? candles[0]?.o,
    high: meta.regularMarketDayHigh, low: meta.regularMarketDayLow,
    volume: meta.regularMarketVolume,
    currency: meta.currency === 'USD' ? 'USD' : (meta.currency ?? 'USD'),
    source: 'yahoo-finance(unofficial)', delay: 'near-live', ts: Date.now(),
  };
  if (prev != null) { q.change = price - prev; q.changePct = (price / prev - 1) * 100; }
  return q;
}
