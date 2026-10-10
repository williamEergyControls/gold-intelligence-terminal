/* ================================================================
   FEATURE TABLE fx_daily — one row per gold trading day, one column per input.
   Point-in-time: a row only uses data that was published before that day's close.
   INIT     backfill (once, ~2 years): warehouse + CFTC history + weather archive
   POLL     daily 00 UTC: rebuild the last 30 rows (fills late data and forward targets)
   EVALUATE groups (each one gets a learned gate in the evolved networks):
     price       r1 r5 r20 r60 dist50 vol20          trend and speed
     behavior    rsi14 dist200 dd60 cot_pct cot_chg  crowd over-extension, panic, positioning
     macro       dxy20 ry ryd20 vix oil20 curve credit
     signals     ml_p gold_score econ_score          Loop B and Loop C outputs
     sentiment   crowd_bull crowd_n yt_share         your YouTube + RSS feeds (forward only)
     regulatory  epu epu_z reg_news ins_buys ins_net fomc_days
     weather     wx_temp wx_rain
   targets   y1 y5 y21 = forward log return % over 1, 5, 21 trading days (null until known)
   PUBLISH   one json_each upsert; COALESCE keeps forward-only columns already stored
   ================================================================ */
import type { Env } from '../types';
import { AppCache } from '../cache';
import { readSeries } from '../store/ingest';
import { cotGold, insiderSummary } from '../outlook/sources';
import { FOMC } from '../calendar';
import { wxAt, type WxHist } from './weather';

export const GROUPS: Record<string, string[]> = {
  price: ['r1', 'r5', 'r20', 'r60', 'dist50', 'vol20'],
  behavior: ['rsi14', 'dist200', 'dd60', 'cot_pct', 'cot_chg'],
  macro: ['dxy20', 'ry', 'ryd20', 'vix', 'oil20', 'curve', 'credit'],
  signals: ['ml_p', 'gold_score', 'econ_score'],
  sentiment: ['crowd_bull', 'crowd_n', 'yt_share'],
  regulatory: ['epu', 'epu_z', 'reg_news', 'ins_buys', 'ins_net', 'fomc_days'],
  weather: ['wx_temp', 'wx_rain'],
};
export const GROUP_NAMES = Object.keys(GROUPS);
export const FEATS: string[] = GROUP_NAMES.flatMap(g => GROUPS[g]);
export const FEAT_GROUP: number[] = FEATS.map(f => GROUP_NAMES.findIndex(g => GROUPS[g].includes(f)));
export const TARGETS = ['y1', 'y5', 'y21'];
export const LABELS: Record<string, string> = {
  r1: '1-day return %', r5: '5-day return %', r20: '20-day return %', r60: '60-day return %', dist50: '% vs 50-day avg', vol20: '20-day vol (ann. %)',
  rsi14: 'RSI 14', dist200: '% vs 200-day avg', dd60: 'drawdown from 60-day high %', cot_pct: 'CFTC net long, 3-yr pctl', cot_chg: 'CFTC net change 4 wk, % OI',
  dxy20: 'dollar 20-day %', ry: '10Y real yield %', ryd20: 'real yield 20-day Δ', vix: 'VIX', oil20: 'oil 20-day %', curve: '10Y–3M spread', credit: 'Baa spread',
  ml_p: 'Loop B p(up 5d)', gold_score: 'Loop C gold /10', econ_score: 'Loop C economy /10',
  crowd_bull: 'bullish share, 7 days', crowd_n: 'gold stories, 7 days', yt_share: 'YouTube share of stories',
  epu: 'policy uncertainty (EPU, 7-day avg)', epu_z: 'EPU vs 1-yr (z)', reg_news: 'regulatory stories, 7 days', ins_buys: 'insider buys, 90 days', ins_net: 'insider net $M, 90 days', fomc_days: 'days to next FOMC',
  wx_temp: 'US temp vs normal °C', wx_rain: 'Plains rain vs normal mm/wk',
  y1: 'next 1 day %', y5: 'next 5 days %', y21: 'next 21 days %',
};

const DAY = 864e5;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
type Pt = { t: number; v: number };
function ffill(src: Pt[], days: number[]): (number | null)[] {
  const out: (number | null)[] = []; let j = 0, last: number | null = null;
  for (const t of days) { while (j < src.length && src[j].t <= t) last = src[j++].v; out.push(last); }
  return out;
}
const REG_WORDS = ['tariff', 'sanction', 'export control', 'regulat', 'antitrust', 'probe', ' ban', 'basel', 'stress test', 'sec ', 'cftc', 'license', 'investigation', 'lawsuit', 'fine'];

export async function buildFeatures(env: Env, mode: 'backfill' | 'daily'): Promise<{ rows: number; from: string | null; to: string | null }> {
  const look = mode === 'backfill' ? 3700 : 420;
  const S = await readSeries(env, ['GOLD', 'DXY', 'TIPS10Y', 'VIX', 'OIL', 'CURVE', 'CREDIT', 'EPU'], Date.now() - look * DAY);
  const g = S.GOLD ?? [];
  if (g.length < 260) return { rows: 0, from: null, to: null };
  const days = g.map(p => p.t), px = g.map(p => p.v), n = g.length;
  // macro prints for date D are visible to the bar of D only after a half-day lag (FRED publishes next morning)
  const lag = (a: Pt[]) => a.map(p => ({ t: p.t + 12 * 36e5, v: p.v }));
  const dxy = ffill(S.DXY ?? [], days), ry = ffill(lag(S.TIPS10Y ?? []), days), vix = ffill(S.VIX ?? [], days), oil = ffill(S.OIL ?? [], days);
  const curve = ffill(lag(S.CURVE ?? []), days), credit = ffill(lag(S.CREDIT ?? []), days), epu = ffill(lag(S.EPU ?? []), days);

  const cot = await cotGold(env);
  // COT is as-of Tuesday, released Friday: usable 3 days after the report date
  const cotPts = (cot?.hist ?? []).map(([d, share, net]) => ({ t: Date.parse(d + 'T00:00:00Z') + 3 * DAY, share, net }));
  const wx = (await new AppCache(env).read<WxHist>('wx:hist'))?.v ?? null;

  // signals history: Loop B predictions + Loop C outlook log (forward only, since each went live)
  const [preds, outs] = await Promise.all([
    env.DB.prepare('SELECT ts, p_up FROM predictions WHERE ts >= ? ORDER BY ts').bind(days[0]).all<{ ts: number; p_up: number }>().then(r => r.results ?? []).catch(() => []),
    env.DB.prepare('SELECT day, econ, gold FROM outlook_log ORDER BY day').all<{ day: string; econ: number; gold: number }>().then(r => r.results ?? []).catch(() => []),
  ]);
  const mlp = ffill(preds.map(p => ({ t: p.ts, v: p.p_up })), days.map(t => t + DAY - 1));
  const gs = ffill(outs.map(o => ({ t: Date.parse(o.day + 'T00:00:00Z'), v: o.gold })), days.map(t => t + DAY - 1));
  const es = ffill(outs.map(o => ({ t: Date.parse(o.day + 'T00:00:00Z'), v: o.econ })), days.map(t => t + DAY - 1));

  // forward-only columns, written to today's row only (history keeps what was stored on its own day)
  let today: Record<string, number | null> = {};
  if (mode === 'daily') {
    const since = Date.now() - 7 * DAY;
    const crowd = await env.DB.prepare(
      `SELECT SUM(CASE WHEN i.sentiment='bull' THEN 1 ELSE 0 END) bull, SUM(CASE WHEN i.sentiment='bear' THEN 1 ELSE 0 END) bear,
              SUM(CASE WHEN s.kind='youtube' THEN 1 ELSE 0 END) yt, COUNT(*) n
       FROM news_items i JOIN news_sources s ON s.id = i.source_id
       WHERE i.published > ? AND (i.topics LIKE '%gold%' OR i.ai_json LIKE '%"XAU"%')`).bind(since).first<{ bull: number; bear: number; yt: number; n: number }>().catch(() => null);
    const like = REG_WORDS.map(() => 'lower(i.title) LIKE ?').join(' OR ');
    const reg = await env.DB.prepare(`SELECT COUNT(*) n FROM news_items i WHERE i.published > ? AND (${like})`)
      .bind(since, ...REG_WORDS.map(w => '%' + w + '%')).first<{ n: number }>().catch(() => null);
    const ins = await insiderSummary(env, 90);
    const dir = (crowd?.bull ?? 0) + (crowd?.bear ?? 0);
    today = {
      crowd_bull: dir >= 3 ? +((crowd!.bull ?? 0) / dir).toFixed(3) : null,
      crowd_n: crowd?.n ?? null,
      yt_share: crowd?.n ? +((crowd.yt ?? 0) / crowd.n).toFixed(3) : null,
      reg_news: reg?.n ?? null,
      ins_buys: ins ? ins.buys : null,
      ins_net: ins ? +((ins.buyUsd - ins.sellUsd) / 1e6).toFixed(2) : null,
    };
  }

  const fomc = FOMC.map(d => Date.parse(d.replace('*', '') + 'T18:00:00Z'));
  const ret = (i: number, k: number) => i - k >= 0 ? (Math.log(px[i] / px[i - k]) * 100) : null;
  const fwd = (i: number, k: number) => i + k < n ? +(Math.log(px[i + k] / px[i]) * 100).toFixed(3) : null;
  const pctChg = (a: (number | null)[], i: number, k: number) => i - k >= 0 && a[i] != null && a[i - k] ? ((a[i] as number) / (a[i - k] as number) - 1) * 100 : null;
  const r2 = (x: number | null, d = 3) => x == null || !isFinite(x) ? null : +x.toFixed(d);

  // rolling helpers (single pass)
  const pre = [0]; for (let i = 0; i < n; i++) pre.push(pre[i] + px[i]);
  const sma = (i: number, k: number) => i + 1 >= k ? (pre[i + 1] - pre[i + 1 - k]) / k : null;
  const lr = px.map((v, i) => i ? Math.log(v / px[i - 1]) : 0);
  const startI = mode === 'backfill' ? 252 : Math.max(252, n - 30);
  // EPU running sums for the 1-year z-score; COT pointer
  const eS = [0], eQ = [0], eC = [0];
  for (let i = 0; i < n; i++) { const x = epu[i]; eS.push(eS[i] + (x ?? 0)); eQ.push(eQ[i] + (x ?? 0) ** 2); eC.push(eC[i] + (x == null ? 0 : 1)); }
  let cpPtr = -1;
  while (cpPtr + 1 < cotPts.length && cotPts[cpPtr + 1].t <= days[startI - 1]) cpPtr++;
  const rows: Record<string, number | string | null>[] = [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= Math.min(14, n - 1); i++) { const d = px[i] - px[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= 14; loss /= 14;
  const rsiAt: (number | null)[] = new Array(n).fill(null);
  for (let i = 15; i < n; i++) { const d = px[i] - px[i - 1]; gain = (gain * 13 + Math.max(0, d)) / 14; loss = (loss * 13 + Math.max(0, -d)) / 14; rsiAt[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
  for (let i = startI; i < n; i++) {
    const t = days[i];
    let v20 = 0; for (let k = i - 19; k <= i; k++) v20 += lr[k] * lr[k];
    let hi = -Infinity; for (let k = i - 59; k <= i; k++) hi = Math.max(hi, px[k]);
    // COT as known on day t (pointer only moves forward: days are sorted)
    while (cpPtr + 1 < cotPts.length && cotPts[cpPtr + 1].t <= t) cpPtr++;
    const cpIdx = cpPtr, cp = cpIdx >= 0 && cotPts[cpIdx].t <= t ? cotPts[cpIdx] : null;
    let cotPct: number | null = null, cotChg: number | null = null;
    if (cp && cpIdx >= 20) {
      const win = cotPts.slice(Math.max(0, cpIdx - 155), cpIdx + 1).map(x => x.share);
      cotPct = win.filter(s => s <= cp!.share).length / win.length * 100;
      if (cpIdx >= 4) cotChg = cp.share - cotPts[cpIdx - 4].share;
    }
    let e7: number | null = null, ez: number | null = null;
    if (epu[i] != null) {
      let s = 0, c = 0; for (let k = Math.max(0, i - 4); k <= i; k++) if (epu[k] != null) { s += epu[k] as number; c++; }
      e7 = c ? s / c : null;
      const c1 = eC[i + 1] - eC[Math.max(0, i - 251)], m = c1 ? (eS[i + 1] - eS[Math.max(0, i - 251)]) / c1 : 0;
      const v = c1 ? (eQ[i + 1] - eQ[Math.max(0, i - 251)]) / c1 - m * m : 0;
      if (c1 > 60 && e7 != null) ez = (e7 - m) / (Math.sqrt(Math.max(v, 1e-9)) || 1);
    }
    const nf = fomc.find(f => f >= t);
    const w = wxAt(wx, t);
    const isToday = i === n - 1;
    rows.push({
      day: iso(t), ts: t, px: px[i],
      r1: r2(ret(i, 1)), r5: r2(ret(i, 5)), r20: r2(ret(i, 20)), r60: r2(ret(i, 60)),
      dist50: r2((px[i] / (sma(i, 50) as number) - 1) * 100), vol20: r2(Math.sqrt(v20 / 20 * 252) * 100, 2),
      rsi14: r2(rsiAt[i], 1), dist200: r2((px[i] / (sma(i, 200) as number) - 1) * 100), dd60: r2((hi - px[i]) / hi * 100),
      cot_pct: r2(cotPct, 1), cot_chg: r2(cotChg, 2),
      dxy20: r2(pctChg(dxy, i, 20)), ry: r2(ry[i], 2), ryd20: ry[i] != null && ry[i - 20] != null ? r2((ry[i] as number) - (ry[i - 20] as number)) : null,
      vix: r2(vix[i], 2), oil20: r2(pctChg(oil, i, 20)), curve: r2(curve[i], 2), credit: r2(credit[i], 2),
      ml_p: r2(mlp[i]), gold_score: r2(gs[i], 1), econ_score: r2(es[i], 1),
      crowd_bull: isToday ? today.crowd_bull ?? null : null, crowd_n: isToday ? today.crowd_n ?? null : null, yt_share: isToday ? today.yt_share ?? null : null,
      epu: r2(e7, 1), epu_z: r2(ez, 2), reg_news: isToday ? today.reg_news ?? null : null,
      ins_buys: isToday ? today.ins_buys ?? null : null, ins_net: isToday ? today.ins_net ?? null : null,
      // only inside the listed schedule: otherwise it becomes a disguised date trend for the networks
      fomc_days: nf && nf - t <= 60 * DAY ? Math.round((nf - t) / DAY) : null,
      wx_temp: w.t, wx_rain: w.p,
      y1: fwd(i, 1), y5: fwd(i, 5), y21: fwd(i, 21), updated: Date.now(),
    });
  }
  if (!rows.length) return { rows: 0, from: null, to: null };
  const cols = ['day', 'ts', 'px', ...FEATS, ...TARGETS, 'updated'];
  const keep = (c: string) => `${c} = COALESCE(excluded.${c}, fx_daily.${c})`;
  // chunked json_each upserts: ~300 rows per statement keeps each JSON value well under D1's limits
  for (let k = 0; k < rows.length; k += 300) {
    const chunk = rows.slice(k, k + 300).map(r => cols.map(c => r[c] ?? null));
    await env.DB.prepare(
      `INSERT INTO fx_daily (${cols.join(',')}) SELECT ${cols.map((_, j) => `json_extract(value,'$[${j}]')`).join(',')} FROM json_each(?1) WHERE 1
       ON CONFLICT(day) DO UPDATE SET ${cols.filter(c => c !== 'day').map(keep).join(', ')}`).bind(JSON.stringify(chunk)).run();
  }
  return { rows: rows.length, from: rows[0].day as string, to: rows[rows.length - 1].day as string };
}

export const FX_DDL = `CREATE TABLE IF NOT EXISTS fx_daily (day TEXT PRIMARY KEY, ts INTEGER NOT NULL, px REAL NOT NULL, ${FEATS.map(f => f + ' REAL').join(', ')}, ${TARGETS.map(f => f + ' REAL').join(', ')}, updated INTEGER)`;
