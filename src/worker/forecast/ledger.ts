/* ================================================================
   FORECAST LEDGER — gold spot, every minute, graded against what happened.
   INIT     state row (cache_kv 'fc:state'): EWMA of 1-min returns, 30-min EMA,
            daily closes summary, blend weights (learned daily)
   POLL     gold-api.com spot (no key). provider clock older than 6 min = market
            closed → no tick, no new forecasts (no fake flat minutes)
   EVALUATE outlier guard: a >1.5% jump vs the last tick is only accepted when a
            2nd source (yahoo spot) agrees within 0.5%
            4 models per horizon: naive (random walk = the baseline to beat),
            drift (momentum), revert (pull to the mean), blend (weights learned
            from each model's error over the last 7 days)
   PUBLISH  1 D1 batch: tick + due forecasts + grading of matured forecasts
   horizon   new forecast every   graded if a tick lands within   tight band
   1m        1 min                ±90 s                           0.05 %
   30m       5 min                ±3 min                          0.25 %
   1d        60 min               ±30 min                         1 %
   1w        6 h                  ±3 h                            2.5 %
   30d       24 h                 ±12 h                           5 %
   ================================================================ */
import type { Env } from '../types';
import { AppCache } from '../cache';
import { goldapiComQuote } from '../providers/goldapicom';
import * as yahoo from '../providers/yahoo';
import { readSeries } from '../store/ingest';

export type H = '1m' | '30m' | '1d' | '1w' | '30d';
export const HZ: Record<H, { ms: number; everyMin: number; tolMs: number; band: number; label: string }> = {
  '1m': { ms: 60e3, everyMin: 1, tolMs: 90e3, band: 0.05, label: '1 minute' },
  '30m': { ms: 30 * 60e3, everyMin: 5, tolMs: 180e3, band: 0.25, label: '30 minutes' },
  '1d': { ms: 864e5, everyMin: 60, tolMs: 1800e3, band: 1, label: '1 day' },
  '1w': { ms: 7 * 864e5, everyMin: 360, tolMs: 3 * 36e5, band: 2.5, label: '1 week' },
  '30d': { ms: 30 * 864e5, everyMin: 1440, tolMs: 12 * 36e5, band: 5, label: '30 days' },
};
export const HS = Object.keys(HZ) as H[];
type Models = 'naive' | 'drift' | 'revert';
interface State {
  last: number | null; lastTs: number | null;
  mu: number; vr: number;          // EWMA of 1-min log returns and their variance (halflife 60 min)
  ema30: number | null;            // 30-min EMA of price
  daily: { ts: number; mu: number; sma50: number; last: number } | null; // from the warehouse, refreshed hourly
  w: Record<H, Record<Models, number>>; // blend weights
  wAt: number;
}
const LAMBDA = Math.pow(0.5, 1 / 60);      // per-minute decay, 60-min halflife
const A30 = 1 - Math.pow(0.5, 1 / 30);     // 30-min EMA
const W0: Record<Models, number> = { naive: 0.6, drift: 0.2, revert: 0.2 };
const fresh = (): State => ({ last: null, lastTs: null, mu: 0, vr: 0, ema30: null, daily: null, w: Object.fromEntries(HS.map(h => [h, { ...W0 }])) as State['w'], wAt: 0 });

function predict(h: H, base: number, st: State): Record<Models, number> {
  const mins = HZ[h].ms / 60e3;
  if (h === '1m' || h === '30m') {
    const drift = base * Math.exp(0.5 * st.mu * mins);                       // damped momentum
    const tgt = st.ema30 ?? base;
    const revert = base + (tgt - base) * (1 - Math.exp(-mins / 60));           // pull toward 30-min EMA
    return { naive: base, drift, revert };
  }
  const days = HZ[h].ms / 864e5;
  const d = st.daily;
  if (!d) return { naive: base, drift: base, revert: base };
  const drift = base * Math.exp(0.5 * d.mu * days);                            // damped daily momentum
  const revert = base + (d.sma50 - base) * (1 - Math.exp(-days / 40));         // pull toward the 50-day mean
  return { naive: base, drift, revert };
}

async function refreshDaily(env: Env, st: State): Promise<void> {
  if (st.daily && Date.now() - st.daily.ts < 36e5) return;
  const pts = (await readSeries(env, ['GOLD'], Date.now() - 400 * 864e5))['GOLD'] ?? [];
  if (pts.length < 60) return;
  const c = pts.map(p => p.v);
  const lam = Math.pow(0.5, 1 / 60);
  let mu = 0;
  for (let i = 1; i < c.length; i++) mu = lam * mu + (1 - lam) * Math.log(c[i] / c[i - 1]);
  const s50 = c.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, c.length);
  st.daily = { ts: Date.now(), mu, sma50: s50, last: c[c.length - 1] };
}

export async function tick(env: Env, scheduledTime: number): Promise<{ ok: boolean; note: string }> {
  const minute = Math.floor(scheduledTime / 60e3) * 60e3;
  const cache = new AppCache(env);
  const st: State = (await cache.read<State>('fc:state'))?.v ?? fresh();
  for (const h of HS) st.w[h] ??= { ...W0 };
  const stmts: D1PreparedStatement[] = [];
  let note = '';
  let q: Awaited<ReturnType<typeof goldapiComQuote>> | null = null;
  try { q = await goldapiComQuote('XAU:USD', 0); } catch (e) { note = 'no quote: ' + String((e as Error).message).slice(0, 60); }
  const open = q != null && Date.now() - q.ts < 6 * 60e3;
  if (q && !open) note = 'market closed (provider clock ' + Math.round((Date.now() - q.ts) / 60e3) + ' min old)';
  let px = open && q ? q.price : null;
  if (px != null && st.last != null && Math.abs(px / st.last - 1) > 0.015) {
    // big jump: confirm with a second source before it enters history
    try {
      const y = await yahoo.yahooQuote(env, 'XAU:USD');
      if (Math.abs(y.price / px - 1) > 0.005) { note = 'jump not confirmed by 2nd source, tick skipped'; px = null; }
    } catch { note = 'jump unconfirmed (2nd source down), tick skipped'; px = null; }
  }
  if (px != null && q) {
    if (st.last != null && st.lastTs != null && minute - st.lastTs <= 5 * 60e3) {
      const r = Math.log(px / st.last);
      st.mu = LAMBDA * st.mu + (1 - LAMBDA) * r;
      st.vr = LAMBDA * st.vr + (1 - LAMBDA) * r * r;
    }
    st.ema30 = st.ema30 == null ? px : st.ema30 + A30 * (px - st.ema30);
    st.last = px; st.lastTs = minute;
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO ticks (ts, price, src, src_ts) VALUES (?, ?, ?, ?)').bind(minute, px, q.source, q.ts));
    const minIdx = Math.round(minute / 60e3);
    const due = HS.filter(h => minIdx % HZ[h].everyMin === 0);
    if (due.some(h => h !== '1m' && h !== '30m')) { try { await refreshDaily(env, st); } catch { /* daily models fall back to naive */ } }
    for (const h of due) {
      const m = predict(h, px, st), w = st.w[h];
      const blend = (w.naive * m.naive + w.drift * m.drift + w.revert * m.revert) / (w.naive + w.drift + w.revert);
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO forecasts (made, h, target, base, naive, drift, revert, blend) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(minute, h, minute + HZ[h].ms, px, m.naive, m.drift, m.revert, blend));
    }
    // grade every open forecast whose target time is within its tolerance of this tick
    stmts.push(env.DB.prepare(
      `UPDATE forecasts SET actual = ?1, actual_ts = ?2 WHERE actual IS NULL AND target <= ?2 + 30000 AND target >= ?2 - CASE h
         WHEN '1m' THEN 90000 WHEN '30m' THEN 180000 WHEN '1d' THEN 1800000 WHEN '1w' THEN 10800000 ELSE 43200000 END`).bind(px, minute));
  }
  // forecasts whose target passed with no tick in the window (market closed) are voided, not guessed
  stmts.push(env.DB.prepare(
    `UPDATE forecasts SET actual = 0, actual_ts = -1 WHERE actual IS NULL AND target < ?1 - CASE h
       WHEN '1m' THEN 90000 WHEN '30m' THEN 180000 WHEN '1d' THEN 1800000 WHEN '1w' THEN 10800000 ELSE 43200000 END`).bind(minute));
  await env.DB.batch(stmts);
  await cache.write('fc:state', st, 86400 * 30);
  return { ok: px != null, note: note || 'tick ' + px };
}

/* ---------- daily: roll yesterday into forecast_daily, relearn blend weights, prune ---------- */
export async function dailyRollup(env: Env): Promise<{ rows: number; weights: State['w'] | null }> {
  const d0 = new Date(); d0.setUTCHours(0, 0, 0, 0);
  const to = d0.getTime(), from = to - 864e5;
  const day = new Date(from).toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    `INSERT OR REPLACE INTO forecast_daily (day, h, n, mape_naive, mape_drift, mape_revert, mape_blend, hit_band, hit5, bias)
     SELECT ?1, h, COUNT(*),
       AVG(ABS(naive - actual) / actual) * 100, AVG(ABS(drift - actual) / actual) * 100,
       AVG(ABS(revert - actual) / actual) * 100, AVG(ABS(blend - actual) / actual) * 100,
       AVG(CASE WHEN ABS(blend - actual) / actual * 100 <= CASE h WHEN '1m' THEN 0.05 WHEN '30m' THEN 0.25 WHEN '1d' THEN 1 WHEN '1w' THEN 2.5 ELSE 5 END THEN 1.0 ELSE 0 END),
       AVG(CASE WHEN ABS(blend - actual) / actual <= 0.05 THEN 1.0 ELSE 0 END),
       AVG((blend - actual) / actual) * 100
     FROM forecasts WHERE actual_ts > 0 AND target >= ?2 AND target < ?3 GROUP BY h`).bind(day, from, to).run();
  // learn: weight each model by 1 / its 7-day MAPE (floor so no model is ever switched off)
  const cache = new AppCache(env);
  const st = (await cache.read<State>('fc:state'))?.v ?? null;
  if (st) {
    const rs = (await env.DB.prepare(
      `SELECT h, SUM(n) n, SUM(mape_naive*n)/SUM(n) a, SUM(mape_drift*n)/SUM(n) b, SUM(mape_revert*n)/SUM(n) c FROM forecast_daily WHERE day >= ? GROUP BY h`
    ).bind(new Date(to - 7 * 864e5).toISOString().slice(0, 10)).all<{ h: H; n: number; a: number; b: number; c: number }>()).results ?? [];
    for (const x of rs) {
      if (!st.w[x.h] || x.n < 20 || !(x.a > 0 && x.b > 0 && x.c > 0)) continue;
      const inv = { naive: 1 / x.a, drift: 1 / x.b, revert: 1 / x.c }, s = inv.naive + inv.drift + inv.revert;
      st.w[x.h] = { naive: Math.max(0.1, inv.naive / s), drift: Math.max(0.05, inv.drift / s), revert: Math.max(0.05, inv.revert / s) };
    }
    st.wAt = Date.now();
    await cache.write('fc:state', st, 86400 * 30);
  }
  // keep: 1m rows 30 days, 30m rows 180 days, longer horizons forever (they are the long-run record)
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM forecasts WHERE h = '1m' AND made < ?`).bind(to - 30 * 864e5),
    env.DB.prepare(`DELETE FROM forecasts WHERE h = '30m' AND made < ?`).bind(to - 180 * 864e5),
  ]);
  return { rows: r.meta?.changes ?? 0, weights: st?.w ?? null };
}

/* ---------- read side for the page ---------- */
export async function ledgerSummary(env: Env, h: H) {
  const now = Date.now();
  const [daily, today, pairs, open, ticks, stRow] = await Promise.all([
    env.DB.prepare(`SELECT day, n, mape_naive, mape_drift, mape_revert, mape_blend, hit_band, hit5, bias FROM forecast_daily WHERE h = ? ORDER BY day DESC LIMIT 30`).bind(h).all<any>(),
    env.DB.prepare(
      `SELECT COUNT(*) n, AVG(ABS(naive-actual)/actual)*100 mape_naive, AVG(ABS(blend-actual)/actual)*100 mape_blend,
         AVG(CASE WHEN ABS(blend-actual)/actual*100 <= ?2 THEN 1.0 ELSE 0 END) hit_band, AVG(CASE WHEN ABS(blend-actual)/actual <= 0.05 THEN 1.0 ELSE 0 END) hit5
       FROM forecasts WHERE h = ?1 AND actual_ts > 0 AND target >= ?3`).bind(h, HZ[h].band, now - 864e5).first<any>(),
    env.DB.prepare(`SELECT made, target, base, naive, blend, actual FROM forecasts WHERE h = ? AND actual_ts > 0 ORDER BY made DESC LIMIT 120`).bind(h).all<any>(),
    env.DB.prepare(`SELECT made, target, base, naive, drift, revert, blend FROM forecasts WHERE h = ? AND actual IS NULL ORDER BY made DESC LIMIT 1`).bind(h).first<any>(),
    env.DB.prepare(`SELECT ts, price FROM ticks WHERE ts >= ?1 AND ts % ?2 = 0 ORDER BY ts`).bind(now - (h === '1m' ? 3 : h === '30m' ? 12 : 24 * 14) * 36e5, h === '1m' ? 60e3 : h === '30m' ? 300e3 : 36e5).all<{ ts: number; price: number }>(),
    new AppCache(env).read<State>('fc:state'),
  ]);
  const D = daily.results ?? [];
  const N = D.reduce((a: number, x: any) => a + x.n, 0);
  const wavg = (k: string) => N ? D.reduce((a: number, x: any) => a + (x[k] ?? 0) * x.n, 0) / N : null;
  return {
    h, label: HZ[h].label, band: HZ[h].band,
    last30: { n: N, mapeNaive: wavg('mape_naive'), mapeDrift: wavg('mape_drift'), mapeRevert: wavg('mape_revert'), mapeBlend: wavg('mape_blend'), hitBand: wavg('hit_band'), hit5: wavg('hit5'), bias: wavg('bias') },
    today: today ?? null,
    weights: stRow?.v?.w?.[h] ?? W0,
    open: open ?? null,
    pairs: (pairs.results ?? []).reverse(),
    ticks: ticks.results ?? [],
    history: D.reverse(),
  };
}
