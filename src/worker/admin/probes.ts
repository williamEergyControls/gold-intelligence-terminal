/* ================================================================
   ADMIN · LIVE API PROBES
   cycle:  INIT (resolve keys) → POLL (one tiny real request per API,
           parallel, 7s timeout each) → EVALUATE (http + payload sanity
           → ok / sample / dataTs) → PUBLISH (D1 api_probes + provider_health)
   quota-limited APIs (metals.dev ~100/mo, goldapi.io ~100/mo, workers-ai
   neurons) only run when the admin explicitly forces them.
   ================================================================ */
import type { Env } from '../types';
import { UA, secret } from '../providers/provider';

export interface ProbeResult {
  provider: string; label: string; ok: boolean; skipped: boolean;
  http: number | null; latencyMs: number | null;
  sample: string | null; dataTs: string | null;
  detail: string | null; key: string | null; keyState: 'none' | 'resolved' | 'missing';
  quota: boolean; usedBy: string; ts: number;
}

interface ProbeDef {
  provider: string; label: string; usedBy: string;
  key?: string; quota?: boolean;
  run: (env: Env, key: string | undefined) => Promise<{ http: number; sample: string; dataTs?: string | null }>;
}

async function get(url: string, headers: Record<string, string> = {}, as: 'json' | 'text' = 'json'): Promise<{ http: number; body: any }> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : '*/*', ...headers }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) {
    const t = (await r.text().catch(() => '')).slice(0, 120).replace(/\s+/g, ' ');
    throw Object.assign(new Error(`HTTP ${r.status}${t ? ' · ' + t : ''}`), { http: r.status });
  }
  return { http: r.status, body: as === 'json' ? await r.json() : await r.text() };
}
const n2 = (v: unknown, d = 2) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const need = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

export const PROBES: ProbeDef[] = [
  {
    provider: 'gold-api.com', label: 'Gold-API.com spot', usedBy: 'gold/silver spot (primary)',
    run: async () => {
      const { http, body } = await get('https://api.gold-api.com/price/XAU');
      need(isFinite(Number(body?.price)) && Number(body.price) > 0, 'bad price payload');
      return { http, sample: 'XAU ' + n2(body.price), dataTs: body?.updatedAt ?? null };
    },
  },
  {
    provider: 'yahoo', label: 'Yahoo Finance chart (unofficial)', usedBy: 'candles, DXY, futures, miners, ML inputs',
    run: async () => {
      const { http, body } = await get('https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=5d');
      const m = body?.chart?.result?.[0]?.meta;
      need(typeof m?.regularMarketPrice === 'number', 'no regularMarketPrice');
      return { http, sample: 'GC=F ' + n2(m.regularMarketPrice), dataTs: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null };
    },
  },
  {
    provider: 'stooq', label: 'Stooq CSV quotes', usedBy: 'miners heatmap, gold/DXY fallback',
    run: async () => {
      const { http, body } = await get('https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv', {}, 'text');
      const lines = String(body).trim().split(/\r?\n/);
      need(lines.length >= 2, 'empty csv');
      const cols = lines[0].toLowerCase().split(','), f = lines[1].split(',');
      const close = parseFloat(f[cols.indexOf('close')]);
      need(isFinite(close), 'no close (N/D)');
      return { http, sample: 'XAUUSD ' + n2(close), dataTs: `${f[cols.indexOf('date')] ?? ''} ${f[cols.indexOf('time')] ?? ''}`.trim() };
    },
  },
  {
    provider: 'frankfurter', label: 'Frankfurter (ECB ref rates)', usedBy: 'FX panel',
    run: async () => {
      const { http, body } = await get('https://api.frankfurter.app/latest?from=USD&to=EUR,JPY');
      need(isFinite(Number(body?.rates?.EUR)), 'no EUR rate');
      return { http, sample: `USD/EUR ${Number(body.rates.EUR).toFixed(4)}`, dataTs: body?.date ?? null };
    },
  },
  {
    provider: 'fred', label: 'FRED (St. Louis Fed)', usedBy: 'macro rows, real yield, ML real-yield feature', key: 'FRED_API_KEY',
    run: async (_env, key) => {
      const { http, body } = await get(`https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${key}&file_type=json&sort_order=desc&limit=5`);
      const o = (body?.observations ?? []).find((x: any) => x.value !== '.');
      need(o, 'no observations');
      return { http, sample: `DGS10 ${o.value}%`, dataTs: o.date };
    },
  },
  {
    provider: 'eia', label: 'EIA API v2', usedBy: 'energy desk weekly stocks + retail fuel', key: 'EIA_API_KEY',
    run: async (_env, key) => {
      const { http, body } = await get(`https://api.eia.gov/v2/seriesid/PET.WCRSTUS1.W?api_key=${key}`);
      const rows = (body?.response?.data ?? []).filter((r: any) => isFinite(Number(r?.value)))
        .sort((a: any, b: any) => (String(a.period) < String(b.period) ? 1 : -1));
      need(rows.length, 'no data rows');
      return { http, sample: `crude stocks ${n2(rows[0].value, 0)} k bbl`, dataTs: rows[0].period };
    },
  },
  {
    provider: 'metals.dev', label: 'metals.dev latest', usedBy: 'gold/silver fallback #2', key: 'METALS_API_KEY', quota: true,
    run: async (_env, key) => {
      const { http, body } = await get(`https://api.metals.dev/v1/latest?api_key=${key}&currency=USD&unit=toz`);
      need(typeof body?.metals?.gold === 'number', 'bad payload');
      return { http, sample: 'gold ' + n2(body.metals.gold), dataTs: body?.timestamps?.metal ?? null };
    },
  },
  {
    provider: 'goldapi.io', label: 'GoldAPI.io', usedBy: 'daily OHLC / bid-ask seed (cron, 1x/day)', key: 'GOLDAPI_KEY', quota: true,
    run: async (_env, key) => {
      const { http, body } = await get('https://www.goldapi.io/api/XAU/USD', { 'x-access-token': key! });
      need(isFinite(Number(body?.price)), 'bad payload');
      return { http, sample: 'XAU ' + n2(body.price) + (isFinite(Number(body?.prev_close_price)) ? ' · pc ' + n2(body.prev_close_price) : ''), dataTs: body?.timestamp ? new Date(body.timestamp * 1000).toISOString() : null };
    },
  },
  {
    provider: 'gdelt', label: 'GDELT DOC 2.0', usedBy: 'news + keyword sentiment',
    run: async () => {
      const { http, body } = await get('https://api.gdeltproject.org/api/v2/doc/doc?query=%22gold%20price%22%20sourcelang%3Aenglish&mode=artlist&maxrecords=3&format=json&timespan=1d');
      const a = body?.articles ?? [];
      need(a.length, 'no articles');
      return { http, sample: `${a.length} articles · ${String(a[0]?.domain ?? '')}`, dataTs: a[0]?.seendate ?? null };
    },
  },
  {
    provider: 'usgs-legacy', label: 'USGS WaterServices (legacy, retiring)', usedBy: 'agri/water gage levels',
    run: async () => {
      const { http, body } = await get('https://waterservices.usgs.gov/nwis/iv/?format=json&sites=09380000&parameterCd=00065');
      const vals = body?.value?.timeSeries?.[0]?.values?.[0]?.value ?? [];
      const last = vals[vals.length - 1];
      need(last && isFinite(parseFloat(last.value)), 'no gage value');
      return { http, sample: `Lees Ferry gage ${last.value} ft`, dataTs: last.dateTime };
    },
  },
  {
    provider: 'usgs-ogc', label: 'USGS Water Data OGC API (new)', usedBy: 'migration target for water page',
    run: async () => {
      const { http, body } = await get('https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?f=json&monitoring_location_id=USGS-09380000&parameter_code=00065&limit=1');
      const p = body?.features?.[0]?.properties;
      need(p && isFinite(Number(p.value)), 'no feature value');
      return { http, sample: `Lees Ferry gage ${p.value} ${p.unit_of_measure ?? ''}`.trim(), dataTs: p.time ?? null };
    },
  },
  {
    provider: 'open-meteo', label: 'Open-Meteo forecast', usedBy: 'agri plains weather',
    run: async () => {
      const { http, body } = await get('https://api.open-meteo.com/v1/forecast?latitude=33.58&longitude=-101.86&current=temperature_2m');
      need(isFinite(Number(body?.current?.temperature_2m)), 'no current temp');
      return { http, sample: `Lubbock ${body.current.temperature_2m}°C`, dataTs: body.current.time ?? null };
    },
  },
  {
    provider: 'coingecko', label: 'CoinGecko simple/price', usedBy: 'stablecoin page (browser-side today)',
    run: async () => {
      const { http, body } = await get('https://api.coingecko.com/api/v3/simple/price?ids=tether,usd-coin&vs_currencies=usd&include_last_updated_at=true');
      need(isFinite(Number(body?.tether?.usd)), 'no USDT price');
      return { http, sample: `USDT ${Number(body.tether.usd).toFixed(4)} · USDC ${Number(body['usd-coin']?.usd).toFixed(4)}`, dataTs: body.tether.last_updated_at ? new Date(body.tether.last_updated_at * 1000).toISOString() : null };
    },
  },
  {
    provider: 'workers-ai', label: 'Workers AI (Llama 3.1 8B)', usedBy: 'AI analyst / ask / chat / hourly sentiment', quota: true,
    run: async (env) => {
      need(env.AI, 'AI binding missing');
      const res: any = await env.AI!.run('@cf/meta/llama-3.1-8b-instruct', { messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 4 });
      const t = String(res?.response ?? '').trim();
      need(t, 'empty response');
      return { http: 200, sample: `reply "${t.slice(0, 20)}"`, dataTs: null };
    },
  },
];

/** runs every probe in parallel. quota probes only when force=true. */
export async function runProbes(env: Env, force: boolean): Promise<ProbeResult[]> {
  const ts = Date.now();
  return Promise.all(PROBES.map(async (p): Promise<ProbeResult> => {
    const key = p.key ? secret(env, p.key) : undefined;
    const keyState: ProbeResult['keyState'] = !p.key ? 'none' : key ? 'resolved' : 'missing';
    const base = { provider: p.provider, label: p.label, key: p.key ?? null, keyState, quota: !!p.quota, usedBy: p.usedBy, ts };
    if (p.key && !key) return { ...base, ok: false, skipped: true, http: null, latencyMs: null, sample: null, dataTs: null, detail: `${p.key} not resolved — check Secrets Store binding` };
    if (p.quota && !force) return { ...base, ok: false, skipped: true, http: null, latencyMs: null, sample: null, dataTs: null, detail: 'quota-limited — run FORCE PROBE to spend 1 call' };
    const t0 = Date.now();
    try {
      const r = await p.run(env, key);
      return { ...base, ok: true, skipped: false, http: r.http, latencyMs: Date.now() - t0, sample: r.sample, dataTs: r.dataTs ?? null, detail: null };
    } catch (e) {
      const err = e as Error & { http?: number };
      return { ...base, ok: false, skipped: false, http: err.http ?? null, latencyMs: Date.now() - t0, sample: null, dataTs: null, detail: String(err?.message ?? e).slice(0, 200) };
    }
  }));
}

/** PUBLISH: history rows + latest status per provider. skipped probes are not logged. */
export async function storeProbes(env: Env, rs: ProbeResult[]): Promise<void> {
  const live = rs.filter(r => !r.skipped);
  if (!live.length) return;
  const stmts: D1PreparedStatement[] = [];
  for (const r of live) {
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO api_probes(ts,provider,ok,http,latency_ms,sample,detail) VALUES(?,?,?,?,?,?,?)')
      .bind(r.ts, r.provider, r.ok ? 1 : 0, r.http, r.latencyMs, r.sample, r.detail));
    stmts.push(env.DB.prepare(
      `INSERT INTO provider_health(provider,last_success,last_failure,latency_ms,status) VALUES(?,?,?,?,?)
       ON CONFLICT(provider) DO UPDATE SET
         last_success=COALESCE(excluded.last_success, provider_health.last_success),
         last_failure=COALESCE(excluded.last_failure, provider_health.last_failure),
         latency_ms=excluded.latency_ms, status=excluded.status`)
      .bind('probe:' + r.provider, r.ok ? r.ts : null, r.ok ? null : r.ts, r.latencyMs, r.ok ? 'online' : 'offline'));
  }
  await env.DB.batch(stmts);
}

/** 24h history per provider for sparklines + uptime. */
export async function probeHistory(env: Env, hours = 24): Promise<Record<string, { ts: number; ok: number; latency_ms: number | null }[]>> {
  const since = Date.now() - hours * 36e5;
  const rows = await env.DB.prepare('SELECT ts, provider, ok, latency_ms FROM api_probes WHERE ts > ? ORDER BY ts ASC')
    .bind(since).all<{ ts: number; provider: string; ok: number; latency_ms: number | null }>();
  const out: Record<string, { ts: number; ok: number; latency_ms: number | null }[]> = {};
  for (const r of rows.results ?? []) (out[r.provider] ??= []).push({ ts: r.ts, ok: r.ok, latency_ms: r.latency_ms });
  return out;
}

/** last stored probe per provider (so the page paints before a live run finishes). */
export async function lastProbes(env: Env): Promise<Record<string, { ts: number; ok: number; http: number | null; latency_ms: number | null; sample: string | null; detail: string | null }>> {
  const rows = await env.DB.prepare(
    `SELECT a.ts, a.provider, a.ok, a.http, a.latency_ms, a.sample, a.detail FROM api_probes a
     JOIN (SELECT provider, MAX(ts) mt FROM api_probes GROUP BY provider) m ON a.provider=m.provider AND a.ts=m.mt`
  ).all<{ ts: number; provider: string; ok: number; http: number | null; latency_ms: number | null; sample: string | null; detail: string | null }>();
  const out: Record<string, any> = {};
  for (const r of rows.results ?? []) out[r.provider] = r;
  return out;
}
