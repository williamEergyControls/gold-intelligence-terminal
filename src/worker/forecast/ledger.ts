/* ================================================================
   LOOP A — FORECAST LEDGER v2. Gold spot every market minute, graded against what happened.
   INIT     state row (cache_kv 'fc:state'): EWMA of 1-min returns, 30-min EMA, daily context
            (momentum, 50-day mean, daily vol, Loop B p, Loop C score, evolved champions), blend weights
   POLL     gold-api.com spot (no key). provider clock older than 6 min = market closed →
            no tick, no new forecasts (no fake flat minutes)
   EVALUATE outlier guard: a >1.5% jump is only accepted when a 2nd source agrees within 0.5%
            5 models per horizon:
              naive   price stays put (the baseline to beat)
              drift   damped momentum
              revert  pull toward the 30-min EMA (minutes) or 50-day mean (days)
              signal  Loop B p(up) + Loop C gold score → tilt of ±0.3 σ   (day horizons)
              evo     Loop D promoted champion network                      (day horizons)
            blend = Σ wₘ·modelₘ over the models present; w relearned nightly from 7-day error
   PUBLISH  1 D1 batch: tick + due forecasts + grading of matured forecasts + voids
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
import { champReturn, type Champ, type EvoData, type EH } from './evo';

export type H = '1m' | '30m' | '1d' | '1w' | '30d';
export const HZ: Record<H, { ms: number; everyMin: number; tolMs: number; band: number; label: string; tdays: number }> = {
  '1m': { ms: 60e3, everyMin: 1, tolMs: 90e3, band: 0.05, label: '1 minute', tdays: 0 },
  '30m': { ms: 30 * 60e3, everyMin: 5, tolMs: 180e3, band: 0.25, label: '30 minutes', tdays: 0 },
  '1d': { ms: 864e5, everyMin: 60, tolMs: 1800e3, band: 1, label: '1 day', tdays: 1 },
  '1w': { ms: 7 * 864e5, everyMin: 360, tolMs: 3 * 36e5, band: 2.5, label: '1 week', tdays: 5 },
  '30d': { ms: 30 * 864e5, everyMin: 1440, tolMs: 12 * 36e5, band: 5, label: '30 days', tdays: 21 },
};
export const HS = Object.keys(HZ) as H[];
export const MODELS = ['naive', 'drift', 'revert', 'signal', 'evo'] as const;
export type Model = typeof MODELS[number];
interface Daily { ts: number; mu: number; sma50: number; vol: number; p: number | null; score: number | null; evo: Partial<Record<EH, number>> }
interface State {
  last: number | null; lastTs: number | null;
  mu: number; vr: number;          // EWMA of 1-min log returns and their variance (60-min halflife)
  ema30: number | null;
  daily: Daily | null;
  w: Record<H, Partial<Record<Model, number>>>;
  wAt: number;
  rej?: number;                    // consecutive rejected ticks (outlier guard)
  cnt?: { day: string; ticks: number; made: number; graded: number; voided: number }; // today's counters (no COUNT(*) scans)
}
const LAMBDA = Math.pow(0.5, 1 / 60);
const A30 = 1 - Math.pow(0.5, 1 / 30);
const W0: Record<Model, number> = { naive: 0.5, drift: 0.15, revert: 0.15, signal: 0.1, evo: 0.1 };
const fresh = (): State => ({ last: null, lastTs: null, mu: 0, vr: 0, ema30: null, daily: null, w: Object.fromEntries(HS.map(h => [h, { ...W0 }])) as State['w'], wAt: 0 });
const isDay = (h: H) => h === '1d' || h === '1w' || h === '30d';

function predict(h: H, base: number, st: State): Partial<Record<Model, number>> {
  const mins = HZ[h].ms / 60e3;
  if (!isDay(h)) {
    const drift = base * Math.exp(0.5 * st.mu * mins);
    const revert = base + ((st.ema30 ?? base) - base) * (1 - Math.exp(-mins / 60));
    return { naive: base, drift, revert };
  }
  const d = st.daily, days = HZ[h].ms / 864e5;
  if (!d) return { naive: base };
  const out: Partial<Record<Model, number>> = {
    naive: base,
    drift: base * Math.exp(0.5 * d.mu * HZ[h].tdays),
    revert: base + (d.sma50 - base) * (1 - Math.exp(-days / 40)),
  };
  // Loop B + Loop C wired in: each signal in [-1, 1], averaged, tilts the price by up to 0.3 σ of the horizon
  const parts: number[] = [];
  if (d.p != null) parts.push(2 * d.p - 1);
  if (d.score != null) parts.push((d.score - 5) / 5);
  if (parts.length) out.signal = base * Math.exp(0.3 * d.vol * Math.sqrt(HZ[h].tdays) * parts.reduce((a, b) => a + b, 0) / parts.length);
  const e = d.evo[h as EH];
  if (e != null && isFinite(e)) out.evo = base * Math.exp(e / 100);
  return out;
}

async function refreshDaily(env: Env, st: State): Promise<void> {
  if (st.daily && Date.now() - st.daily.ts < 36e5) return;
  const pts = (await readSeries(env, ['GOLD'], Date.now() - 400 * 864e5))['GOLD'] ?? [];
  if (pts.length < 60) return;
  const c = pts.map(p => p.v), lam = Math.pow(0.5, 1 / 60);
  let mu = 0, vv = 0;
  for (let i = 1; i < c.length; i++) { const r = Math.log(c[i] / c[i - 1]); mu = lam * mu + (1 - lam) * r; vv = lam * vv + (1 - lam) * r * r; }
  const s50 = c.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, c.length);
  const cache = new AppCache(env);
  const [ml, out, D, champs] = await Promise.all([
    env.CACHE.get('ml:snap', 'json').catch(() => null) as Promise<any>,
    env.DB.prepare('SELECT gold FROM outlook_log ORDER BY day DESC LIMIT 1').first<{ gold: number }>().catch(() => null),
    cache.read<EvoData>('evo:data').then(r => r?.v ?? null).catch(() => null),
    cache.read<Record<string, Champ>>('evo:champ').then(r => r?.v ?? {}).catch(() => ({} as Record<string, Champ>)),
  ]);
  const evo: Daily['evo'] = {};
  for (const h of ['1d', '1w', '30d'] as EH[]) { const r = champReturn(champs[h], D, h); if (r != null) evo[h] = r; }
  st.daily = { ts: Date.now(), mu, sma50: s50, vol: Math.sqrt(vv), p: typeof ml?.p === 'number' ? ml.p : null, score: out?.gold ?? null, evo };
}

export async function tick(env: Env, scheduledTime: number): Promise<{ ok: boolean; note: string }> {
  const minute = Math.floor(scheduledTime / 60e3) * 60e3;
  const cache = new AppCache(env);
  const st: State = (await cache.read<State>('fc:state'))?.v ?? fresh();
  for (const h of HS) { st.w[h] = { ...W0, ...(st.w[h] ?? {}) }; }
  const stmts: D1PreparedStatement[] = [];
  let note = '';
  let q: Awaited<ReturnType<typeof goldapiComQuote>> | null = null;
  try { q = await goldapiComQuote('XAU:USD', 0); } catch (e) { note = 'no quote: ' + String((e as Error).message).slice(0, 60); }
  const open = q != null && Date.now() - q.ts < 6 * 60e3;
  if (q && !open) note = 'market closed (provider clock ' + Math.round((Date.now() - q.ts) / 60e3) + ' min old)';
  let px = open && q ? q.price : null;
  // outlier guard: a >1.5% jump vs the last tick needs a 2nd source. Yahoo's gold is the GC futures
  // contract (carries a basis to spot), so the agreement band is 1.5%. After a gap of 30+ min
  // (weekend, daily break) or 3 rejections in a row the new level is accepted: a real repricing
  // must never freeze the ledger.
  const gap = st.lastTs == null || minute - st.lastTs > 30 * 60e3;
  if (px != null && st.last != null && !gap && (st.rej ?? 0) < 3 && Math.abs(px / st.last - 1) > 0.015) {
    try {
      const y = await yahoo.yahooQuote(env, 'XAU:USD');
      if (Math.abs(y.price / px - 1) > 0.015) { note = 'jump not confirmed by 2nd source, tick skipped'; px = null; }
    } catch { note = 'jump unconfirmed (2nd source down), tick skipped'; px = null; }
    if (px == null) st.rej = (st.rej ?? 0) + 1;
  }
  if (px != null) st.rej = 0;
  const today = new Date(minute).toISOString().slice(0, 10);
  if (!st.cnt || st.cnt.day !== today) st.cnt = { day: today, ticks: 0, made: 0, graded: 0, voided: 0 };
  if (px != null && q) {
    if (st.last != null && st.lastTs != null && minute - st.lastTs <= 5 * 60e3) {
      const r = Math.log(px / st.last);
      st.mu = LAMBDA * st.mu + (1 - LAMBDA) * r;
      st.vr = LAMBDA * st.vr + (1 - LAMBDA) * r * r;
    }
    st.ema30 = st.ema30 == null ? px : st.ema30 + A30 * (px - st.ema30);
    st.last = px; st.lastTs = minute;
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO ticks (ts, price, src, src_ts) VALUES (?, ?, ?, ?)').bind(minute, px, q.source, q.ts));
    st.cnt.ticks++;
    const minIdx = Math.round(minute / 60e3);
    const due = HS.filter(h => minIdx % HZ[h].everyMin === 0);
    if (due.some(isDay)) { try { await refreshDaily(env, st); } catch { /* day models fall back to naive */ } }
    for (const h of due) {
      const m = predict(h, px, st), w = st.w[h];
      let sw = 0, sv = 0;
      for (const k of MODELS) { const v = m[k]; if (v != null && isFinite(v)) { sw += w[k] ?? 0; sv += (w[k] ?? 0) * v; } }
      const blend = sw ? sv / sw : px;
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO forecast_log (made, h, target, base, naive, drift, revert, signal, evo, blend) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(minute, h, minute + HZ[h].ms, px, m.naive ?? px, m.drift ?? null, m.revert ?? null, m.signal ?? null, m.evo ?? null, blend));
      st.cnt.made++;
    }
    stmts.push(env.DB.prepare(
      `UPDATE forecast_log SET actual = ?1, actual_ts = ?2 WHERE actual IS NULL AND target <= ?2 + 30000 AND target >= ?2 - CASE h
         WHEN '1m' THEN 90000 WHEN '30m' THEN 180000 WHEN '1d' THEN 1800000 WHEN '1w' THEN 10800000 ELSE 43200000 END`).bind(px, minute));
  }
  stmts.push(env.DB.prepare(
    `UPDATE forecast_log SET actual = 0, actual_ts = -1 WHERE actual IS NULL AND target < ?1 - CASE h
       WHEN '1m' THEN 90000 WHEN '30m' THEN 180000 WHEN '1d' THEN 1800000 WHEN '1w' THEN 10800000 ELSE 43200000 END`).bind(minute));
  const res = await env.DB.batch(stmts);
  // the last two statements are always grade (when a tick landed) and void
  const nv = res[res.length - 1]?.meta?.changes ?? 0, ng = px != null ? res[res.length - 2]?.meta?.changes ?? 0 : 0;
  st.cnt.graded += ng; st.cnt.voided += nv;
  await cache.write('fc:state', st, 86400 * 30);
  return { ok: px != null, note: note || 'tick ' + px };
}

/* ---------- daily: roll yesterday into forecast_stats, relearn blend weights, prune ---------- */
const mape = (m: string) => `AVG(CASE WHEN ${m} IS NULL THEN NULL ELSE ABS(${m} - actual) / actual END) * 100`;
export async function dailyRollup(env: Env): Promise<{ rows: number; weights: State['w'] | null }> {
  const d0 = new Date(); d0.setUTCHours(0, 0, 0, 0);
  const to = d0.getTime(), from = to - 864e5;
  const day = new Date(from).toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    `INSERT OR REPLACE INTO forecast_stats (day, h, n, mape_naive, mape_drift, mape_revert, mape_signal, mape_evo, mape_blend, hit_band, hit5, bias)
     SELECT ?1, h, COUNT(*), ${mape('naive')}, ${mape('drift')}, ${mape('revert')}, ${mape('signal')}, ${mape('evo')}, ${mape('blend')},
       AVG(CASE WHEN ABS(blend - actual) / actual * 100 <= CASE h WHEN '1m' THEN 0.05 WHEN '30m' THEN 0.25 WHEN '1d' THEN 1 WHEN '1w' THEN 2.5 ELSE 5 END THEN 1.0 ELSE 0 END),
       AVG(CASE WHEN ABS(blend - actual) / actual <= 0.05 THEN 1.0 ELSE 0 END),
       AVG((blend - actual) / actual) * 100
     FROM forecast_log WHERE actual_ts > 0 AND target >= ?2 AND target < ?3 GROUP BY h`).bind(day, from, to).run();
  // learn: each model's weight ∝ 1 / its 7-day error; models without 20 graded forecasts keep their prior
  const cache = new AppCache(env);
  const st = (await cache.read<State>('fc:state'))?.v ?? null;
  if (st) {
    const rs = (await env.DB.prepare(
      `SELECT h, SUM(n) n, SUM(mape_naive*n)/SUM(n) naive, SUM(mape_drift*n)/SUM(n) drift, SUM(mape_revert*n)/SUM(n) revert,
              SUM(mape_signal*n)/SUM(CASE WHEN mape_signal IS NULL THEN 0 ELSE n END) signal, SUM(mape_evo*n)/SUM(CASE WHEN mape_evo IS NULL THEN 0 ELSE n END) evo
       FROM forecast_stats WHERE day >= ? GROUP BY h`
    ).bind(new Date(to - 7 * 864e5).toISOString().slice(0, 10)).all<any>()).results ?? [];
    for (const x of rs) {
      if (!st.w[x.h as H] || x.n < 20) continue;
      const inv: Partial<Record<Model, number>> = {};
      for (const m of MODELS) if (x[m] > 0) inv[m] = 1 / x[m];
      const s = Object.values(inv).reduce((a, b) => a + (b as number), 0);
      if (!s) continue;
      const w: Partial<Record<Model, number>> = {};
      for (const m of MODELS) w[m] = inv[m] != null ? Math.max(m === 'naive' ? 0.1 : 0.03, (inv[m] as number) / s) : (st.w[x.h as H][m] ?? W0[m]);
      st.w[x.h as H] = w;
    }
    st.wAt = Date.now();
    await cache.write('fc:state', st, 86400 * 30);
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM forecast_log WHERE h = '1m' AND made < ?`).bind(to - 30 * 864e5),
    env.DB.prepare(`DELETE FROM forecast_log WHERE h = '30m' AND made < ?`).bind(to - 180 * 864e5),
    // minute ticks kept 400 days; the top-of-hour tick is kept forever (long history at ~9k rows/yr)
    env.DB.prepare(`DELETE FROM ticks WHERE ts < ? AND ts % 3600000 != 0`).bind(to - 400 * 864e5),
  ]);
  return { rows: r.meta?.changes ?? 0, weights: st?.w ?? null };
}

/* ---------- read side ---------- */
export async function ledgerSummary(env: Env, h: H) {
  const now = Date.now();
  // every query below walks idx_fl_h_made (h, made) or the ticks primary key: a few hundred rows
  // per call instead of a table scan (forecast_log reaches ~70k rows at steady state)
  const span = (h === '1m' ? 3 : h === '30m' ? 12 : 24 * 14) * 36e5, step = h === '1m' ? 60e3 : h === '30m' ? 300e3 : 36e5;
  const want: number[] = []; for (let t = Math.floor((now - span) / step) * step; t <= now; t += step) want.push(t);
  const [daily, today, pairs, open, ticks, stRow] = await Promise.all([
    env.DB.prepare(`SELECT day, n, mape_naive, mape_drift, mape_revert, mape_signal, mape_evo, mape_blend, hit_band, hit5, bias FROM forecast_stats WHERE h = ? ORDER BY day DESC LIMIT 30`).bind(h).all<any>(),
    env.DB.prepare(
      `SELECT COUNT(*) n, AVG(ABS(naive-actual)/actual)*100 mape_naive, AVG(ABS(blend-actual)/actual)*100 mape_blend,
         AVG(CASE WHEN ABS(blend-actual)/actual*100 <= ?2 THEN 1.0 ELSE 0 END) hit_band, AVG(CASE WHEN ABS(blend-actual)/actual <= 0.05 THEN 1.0 ELSE 0 END) hit5
       FROM forecast_log WHERE h = ?1 AND made >= ?3 AND made <= ?4 AND actual_ts > 0`).bind(h, HZ[h].band, now - 864e5 - HZ[h].ms - HZ[h].tolMs, now - HZ[h].ms + HZ[h].tolMs).first<any>(),
    env.DB.prepare(`SELECT made, target, base, naive, signal, evo, blend, actual FROM forecast_log WHERE h = ? AND actual_ts > 0 ORDER BY made DESC LIMIT 120`).bind(h).all<any>(),
    env.DB.prepare(`SELECT made, target, base, naive, drift, revert, signal, evo, blend FROM forecast_log WHERE h = ? AND actual IS NULL ORDER BY made DESC LIMIT 1`).bind(h).first<any>(),
    env.DB.prepare(`SELECT ts, price FROM ticks WHERE ts IN (SELECT value FROM json_each(?)) ORDER BY ts`).bind(JSON.stringify(want)).all<{ ts: number; price: number }>(),
    new AppCache(env).read<State>('fc:state'),
  ]);
  const D = daily.results ?? [];
  const N = D.reduce((a: number, x: any) => a + x.n, 0);
  const wavg = (k: string) => { const rows = D.filter((x: any) => x[k] != null); const n = rows.reduce((a: number, x: any) => a + x.n, 0); return n ? rows.reduce((a: number, x: any) => a + x[k] * x.n, 0) / n : null; };
  return {
    h, label: HZ[h].label, band: HZ[h].band,
    last30: { n: N, mapeNaive: wavg('mape_naive'), mapeDrift: wavg('mape_drift'), mapeRevert: wavg('mape_revert'), mapeSignal: wavg('mape_signal'), mapeEvo: wavg('mape_evo'), mapeBlend: wavg('mape_blend'), hitBand: wavg('hit_band'), hit5: wavg('hit5'), bias: wavg('bias') },
    today: today ?? null,
    weights: { ...W0, ...(stRow?.v?.w?.[h] ?? {}) },
    context: stRow?.v?.daily ? { p: stRow.v.daily.p, score: stRow.v.daily.score, evo: stRow.v.daily.evo, at: stRow.v.daily.ts } : null,
    open: open ?? null,
    pairs: (pairs.results ?? []).reverse(),
    ticks: ticks.results ?? [],
    history: D.reverse(),
  };
}

export async function ledgerStatus(env: Env) {
  // counters live in the tick state (no COUNT(*) scans); open = partial index on actual IS NULL (~100 rows)
  const [f, last, first, st] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) n FROM forecast_log WHERE actual IS NULL').first<{ n: number }>().catch(() => null),
    env.DB.prepare('SELECT ts, price FROM ticks ORDER BY ts DESC LIMIT 1').first<{ ts: number; price: number }>().catch(() => null),
    env.DB.prepare('SELECT ts FROM ticks ORDER BY ts ASC LIMIT 1').first<{ ts: number }>().catch(() => null),
    new AppCache(env).read<State>('fc:state'),
  ]);
  const c = st?.v?.cnt, today = new Date().toISOString().slice(0, 10);
  const cnt = c && c.day === today ? c : { day: today, ticks: 0, made: 0, graded: 0, voided: 0 };
  return { ticksToday: cnt.ticks, madeToday: cnt.made, gradedToday: cnt.graded, voidedToday: cnt.voided, open: f?.n ?? 0, lastTick: last ?? null, firstTick: first?.ts ?? null,
    weights: st?.v?.w ?? null, weightsAt: st?.v?.wAt ?? null, context: st?.v?.daily ?? null, rejected: st?.v?.rej ?? 0 };
}
