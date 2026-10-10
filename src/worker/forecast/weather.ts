/* ================================================================
   WEATHER INPUTS — Open-Meteo (free, no key), daily, point-in-time.
   temp anomaly   4 US load centres (NYC, Chicago, Houston, Atlanta): 7-day mean temp
                  minus the 5-year mean for the same days of the year (±7-day window)
   plains rain    2 crop points (Hays KS, Ames IA): 7-day rainfall minus its 5-year normal
   INIT     archive API once a week (≈ 6.5 years, 2 calls) → climatology + history
   POLL     forecast API daily with past_days=10 (archive lags ~5 days)
   PUBLISH  cache_kv 'wx:hist' { start, t[], p[] } anomalies per calendar day (UTC)
   ================================================================ */
import type { Env } from '../types';
import { AppCache } from '../cache';
import { fetchJson } from '../providers/provider';

const T_LOC = { lat: [40.71, 41.88, 29.76, 33.75], lon: [-74.01, -87.63, -95.37, -84.39] };
const P_LOC = { lat: [38.88, 42.03], lon: [-99.33, -93.62] };
const DAY = 864e5;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayKey = (s: string) => Date.parse(s + 'T00:00:00Z');
const doy = (t: number) => { const d = new Date(t); return Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY); };

export interface WxHist { built: number; start: number; t: (number | null)[]; p: (number | null)[]; note: string }

/** average a multi-location Open-Meteo daily response into one series keyed by day */
function avgSeries(j: any, varName: string): Map<number, number> {
  const arr = Array.isArray(j) ? j : [j];
  const sum = new Map<number, { s: number; n: number }>();
  for (const loc of arr) {
    const tm: string[] = loc?.daily?.time ?? [], v: (number | null)[] = loc?.daily?.[varName] ?? [];
    for (let i = 0; i < tm.length; i++) {
      const x = v[i]; if (x == null || !isFinite(x)) continue;
      const k = dayKey(tm[i]); const c = sum.get(k) ?? { s: 0, n: 0 }; c.s += x; c.n++; sum.set(k, c);
    }
  }
  const out = new Map<number, number>();
  for (const [k, c] of sum) if (c.n) out.set(k, c.s / c.n);
  return out;
}

/** weekly: rebuild climatology + anomaly history from the archive (2 subrequests) */
export async function rebuildWeather(env: Env, force = false): Promise<{ ok: boolean; days?: number; note?: string }> {
  const cache = new AppCache(env);
  const cur = await cache.read<WxHist>('wx:hist');
  if (!force && cur && Date.now() - cur.v.built < 7 * DAY) return { ok: true, days: cur.v.t.length, note: 'fresh' };
  const y = new Date().getUTCFullYear();
  const start = `${y - 6}-01-01`, end = iso(Date.now() - 6 * DAY);
  const base = 'https://archive-api.open-meteo.com/v1/archive?timezone=UTC&start_date=' + start + '&end_date=' + end;
  const [tj, pj] = await Promise.all([
    fetchJson(`${base}&latitude=${T_LOC.lat.join(',')}&longitude=${T_LOC.lon.join(',')}&daily=temperature_2m_mean`, {}, 20000),
    fetchJson(`${base}&latitude=${P_LOC.lat.join(',')}&longitude=${P_LOC.lon.join(',')}&daily=precipitation_sum`, {}, 20000),
  ]);
  const T = avgSeries(tj, 'temperature_2m_mean'), P = avgSeries(pj, 'precipitation_sum');
  // recent days the archive doesn't have yet
  try {
    const q = `https://api.open-meteo.com/v1/forecast?timezone=UTC&past_days=10&forecast_days=1`;
    const [rt, rp] = await Promise.all([
      fetchJson(`${q}&latitude=${T_LOC.lat.join(',')}&longitude=${T_LOC.lon.join(',')}&daily=temperature_2m_mean`, {}, 9000),
      fetchJson(`${q}&latitude=${P_LOC.lat.join(',')}&longitude=${P_LOC.lon.join(',')}&daily=precipitation_sum`, {}, 9000),
    ]);
    for (const [k, v] of avgSeries(rt, 'temperature_2m_mean')) if (!T.has(k)) T.set(k, v);
    for (const [k, v] of avgSeries(rp, 'precipitation_sum')) if (!P.has(k)) P.set(k, v);
  } catch { /* archive alone is fine */ }
  const hist = buildAnoms(T, P);
  await cache.write('wx:hist', hist, 30 * 86400);
  return { ok: true, days: hist.t.length };
}

/** daily: top up the last 10 days from the forecast API (2 subrequests) */
export async function topUpWeather(env: Env): Promise<{ ok: boolean; note?: string }> {
  const cache = new AppCache(env);
  const cur = (await cache.read<WxHist & { rawT?: [number, number][]; rawP?: [number, number][] }>('wx:hist'))?.v;
  if (!cur) return { ok: false, note: 'no archive yet' };
  const q = `https://api.open-meteo.com/v1/forecast?timezone=UTC&past_days=10&forecast_days=1`;
  const [rt, rp] = await Promise.all([
    fetchJson(`${q}&latitude=${T_LOC.lat.join(',')}&longitude=${T_LOC.lon.join(',')}&daily=temperature_2m_mean`, {}, 9000),
    fetchJson(`${q}&latitude=${P_LOC.lat.join(',')}&longitude=${P_LOC.lon.join(',')}&daily=precipitation_sum`, {}, 9000),
  ]);
  const T = new Map((cur as any).rawT ?? []) as Map<number, number>, P = new Map((cur as any).rawP ?? []) as Map<number, number>;
  for (const [k, v] of avgSeries(rt, 'temperature_2m_mean')) T.set(k, v);
  for (const [k, v] of avgSeries(rp, 'precipitation_sum')) P.set(k, v);
  const hist = buildAnoms(T, P);
  await cache.write('wx:hist', hist, 30 * 86400);
  return { ok: true };
}

/* climatology by day-of-year from the 5 full years before the current one, ±7-day window,
   then 7-day trailing anomalies for the last 2200 days. raw daily values are kept (≈ 15 KB) for top-ups. */
function buildAnoms(T: Map<number, number>, P: Map<number, number>): WxHist & { rawT: [number, number][]; rawP: [number, number][] } {
  const y = new Date().getUTCFullYear(), c0 = Date.UTC(y - 5, 0, 1), c1 = Date.UTC(y, 0, 1);
  const tS = new Array(366).fill(0), tN = new Array(366).fill(0), pS = new Array(366).fill(0), pN = new Array(366).fill(0);
  for (const [k, v] of T) if (k >= c0 && k < c1) { const d = doy(k); for (let o = -7; o <= 7; o++) { const j = (d + o + 366) % 366; tS[j] += v; tN[j]++; } }
  for (const [k, v] of P) if (k >= c0 && k < c1) { const d = doy(k); for (let o = -7; o <= 7; o++) { const j = (d + o + 366) % 366; pS[j] += v; pN[j]++; } }
  const tC = tS.map((s, i) => tN[i] ? s / tN[i] : null), pC = pS.map((s, i) => pN[i] ? s / pN[i] : null);
  const start = Math.floor((Date.now() - 2200 * DAY) / DAY) * DAY;
  const t: (number | null)[] = [], p: (number | null)[] = [];
  for (let k = start; k <= Date.now(); k += DAY) {
    let ts = 0, tn = 0, ps = 0, pn = 0, cs = 0, cn = 0, cps = 0, cpn = 0;
    for (let o = 0; o < 7; o++) {
      const kk = k - o * DAY, d = doy(kk);
      const tv = T.get(kk), pv = P.get(kk);
      if (tv != null && tC[d] != null) { ts += tv; tn++; cs += tC[d] as number; cn++; }
      if (pv != null && pC[d] != null) { ps += pv; pn++; cps += pC[d] as number; cpn++; }
    }
    t.push(tn >= 4 ? +(ts / tn - cs / cn).toFixed(2) : null);
    p.push(pn >= 4 ? +((ps / pn - cps / cpn) * 7).toFixed(1) : null);
  }
  const keep = (m: Map<number, number>) => [...m].filter(([k]) => k >= start - 7 * DAY).map(([k, v]) => [k, +v.toFixed(2)] as [number, number]);
  return { built: Date.now(), start, t, p, note: 'temp °C vs 5-yr normal (NYC, CHI, HOU, ATL) · Plains 7-day rain mm vs normal (Hays KS, Ames IA)', rawT: keep(T), rawP: keep(P) };
}

export function wxAt(h: WxHist | null, t: number): { t: number | null; p: number | null } {
  if (!h) return { t: null, p: null };
  const i = Math.floor((Math.floor(t / DAY) * DAY - h.start) / DAY);
  if (i < 0 || i >= h.t.length) return { t: null, p: null };
  // the bar for day D may only see weather up to D-1 (published after the close)
  const j = Math.max(0, i - 1);
  return { t: h.t[j] ?? null, p: h.p[j] ?? null };
}
