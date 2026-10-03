/* ================================================================
   VOL SNAPSHOTS — computed from the D1 warehouse, stored in D1 `snapshots`
   cycle (10-min cron, after ingest):
     POLL     read snapshot ages → pick ≤2 stale classes (round robin)
     EVALUATE per series: RV10/20/60/252, EWMA, GARCH(1,1) σ + 5d/20d horizon,
              1y percentile, regime, σ-move z-score; class extras (curve, VRP,
              depeg, insurance vs CPI)
     PUBLISH  snapshots['vol:<class>'] + snapshots['vol:x'] (stress, corr, alerts)
   readers (/api/vol, /api/ml/strip) do ONE D1 read; nothing recomputes per view.
   ================================================================ */
import type { Env } from '../types';
import { SERIES, CLASS_IDS, SOURCE_LABEL, type VolClass, type SeriesKind } from '../store/registry';
import { readSeries } from '../store/ingest';
import { changes, rv, rollingRv, ewma, pctRank, regime, garchFit, garchHorizon, corrAligned, maxDrawdownPct, stdev, mean, monthlyYoY, monthlyMap, monthIdx, type Pt } from '../analytics/vol';

export const VOL_CLASSES: VolClass[] = ['rates', 'fx', 'stable', 'insurance', 'equity', 'commod'];
const DAY = 864e5;
const LOOKBACK: Record<VolClass, number> = { rates: 760, fx: 760, stable: 400, insurance: 5600, equity: 760, commod: 760 };
const r2 = (x: number | null | undefined, d = 2) => (x == null || !isFinite(x) ? null : +x.toFixed(d));

function spark(pts: { v: number }[], n = 48): number[] {
  if (!pts.length) return [];
  const step = Math.max(1, Math.floor(pts.length / n));
  const o: number[] = [];
  for (let i = pts.length - 1; i >= 0 && o.length < n; i -= step) o.unshift(+pts[i].v.toPrecision(6));
  return o;
}
function valueAt(pts: Pt[], t: number): number | null {
  let v: number | null = null;
  for (const p of pts) { if (p.t <= t) v = p.v; else break; }
  return v;
}

export interface VolRow {
  id: string; label: string; kind: SeriesKind; unit: string; source: string; freq: string;
  lastTs: number | null; last: number | null; chg: number | null; chgUnit: string;
  rv10?: number | null; rv20?: number | null; rv60?: number | null; rv252?: number | null; ewma?: number | null;
  garch?: { sig1d: number; sig20Ann: number; persist: number; alpha: number; beta: number; fitTs: number } | null;
  exp5d?: number | null; volUnit?: string;
  pct: number | null; regime: string; z: number | null;
  spark: number[]; rvSpark?: number[];
  extra?: Record<string, number | string | null>;
  stale: boolean; n: number;
}

type PrevFit = { alpha: number; beta: number; fitTs: number } | null | undefined;
function buildRow(id: string, pts: Pt[], prevFit?: PrevFit): VolRow {
  const s = SERIES[id];
  const ann = s.freq === 'monthly' ? 12 : s.tradingDays;
  const last = pts.at(-1)?.v ?? null, prev = pts.at(-2)?.v ?? null;
  const lastTs = pts.at(-1)?.t ?? null;
  const base: VolRow = {
    id, label: s.label, kind: s.kind, unit: s.unit, source: SOURCE_LABEL[s.source] + ' · ' + s.srcId, freq: s.freq,
    lastTs, last: r2(last, 4), chg: null, chgUnit: '', pct: null, regime: '—', z: null, spark: spark(pts), stale: false, n: pts.length,
  };
  base.stale = lastTs == null || Date.now() - lastTs > (s.freq === 'monthly' ? 75 : 6) * DAY;
  if (pts.length < 3 || last == null) return base;
  const ch = changes(s.kind, pts);
  const cv = ch.map(c => c.v);

  if (s.kind === 'cpi') {
    // monthly index: YoY, MoM, 3m annualized, MoM vol + z
    // by calendar month, never by array position (a skipped release must not stretch the window)
    const yoySeries = monthlyYoY(pts);
    const mm = monthlyMap(pts), lastM = monthIdx(lastTs!);
    const yoy = yoySeries.at(-1)?.t === lastTs ? yoySeries.at(-1)!.v : null;
    const lastCh = ch.at(-1);
    const mom = lastCh && lastCh.t === lastTs ? lastCh.v : null;
    const m3 = mm.get(lastM - 3);
    const ann3 = m3 ? (Math.pow(last / m3.v, 4) - 1) * 100 : null;
    const y1 = yoySeries.find(p => monthIdx(p.t) === lastM - 12)?.v ?? null;
    const w = cv.slice(-37, -1);
    const sd = stdev(w), mu = mean(w);
    const z = mom != null && isFinite(sd) && sd > 0 ? (mom - mu) / sd : null;
    const pct = yoy != null ? pctRank(yoySeries.slice(-120).map(p => p.v), yoy) : null;
    return {
      ...base, chg: r2(mom, 2), chgUnit: '% m/m', pct, regime: regime(pct), z: r2(z, 2),
      spark: spark(yoySeries.slice(-60)), volUnit: '% m/m σ',
      extra: { yoy: r2(yoy, 2), ann3m: r2(ann3, 2), momVol36: r2(sd, 3), yoy1yAgo: r2(y1, 2) },
    };
  }

  if (s.kind === 'peg') {
    const dev = pts.map(p => ({ t: p.t, v: (p.v - 1) * 1e4 }));
    const absDev = dev.map(d => Math.abs(d.v));
    const cur = dev.at(-1)!.v;
    const max30 = Math.max(...absDev.slice(-30)), max90 = Math.max(...absDev.slice(-90));
    const sd20 = stdev(cv.slice(-20));
    const days10 = absDev.slice(-90).filter(x => x > 10).length;
    const pct = pctRank(absDev.slice(-365), Math.abs(cur));
    const reg = Math.abs(cur) < 10 ? 'LOW' : Math.abs(cur) < 50 ? 'NORMAL' : Math.abs(cur) < 100 ? 'ELEVATED' : 'STRESS';
    return {
      ...base, chg: r2(cv.at(-1) ?? null, 1), chgUnit: 'bp', pct, regime: reg, z: null, volUnit: 'bp/day σ',
      rv20: r2(sd20, 2), spark: spark(dev.slice(-90)),
      extra: { devBp: r2(cur, 1), max30Bp: r2(max30, 1), max90Bp: r2(max90, 1), daysOver10bp90: days10 },
    };
  }

  // refit α/β at most once a day; otherwise reuse the cached fit (O(n) recursion only)
  const reuse = prevFit && Date.now() - prevFit.fitTs < 864e5 ? prevFit : null;
  const g = garchFit(cv, reuse);
  const fitTs = reuse ? reuse.fitTs : Date.now();
  const isYield = s.kind === 'yield';
  const chg = cv.at(-1) ?? null;
  const zRaw = g && chg != null ? chg / g.cond[g.cond.length - 1] : null;
  const rolling = rollingRv(ch, 20, ann);
  const rv20 = rv(cv, 20, ann);
  const out: VolRow = {
    ...base,
    chg: r2(s.kind === 'index' ? last - (prev ?? last) : chg, 2),
    chgUnit: isYield ? 'bp' : s.kind === 'index' ? 'pts' : '%',
    rv10: r2(rv(cv, 10, ann), 2), rv20: r2(rv20, 2), rv60: r2(rv(cv, 60, ann), 2), rv252: r2(rv(cv, 252, ann), 2),
    ewma: r2((ewma(cv) ?? NaN) * Math.sqrt(ann), 2),
    garch: g ? { sig1d: +g.sigmaNext.toFixed(3), sig20Ann: +(garchHorizon(g, 20) / Math.sqrt(20) * Math.sqrt(ann)).toFixed(2), persist: +g.persist.toFixed(3), alpha: g.alpha, beta: g.beta, fitTs } : null,
    volUnit: isYield ? 'bp/yr' : '%/yr',
    z: r2(zRaw, 2),
    rvSpark: spark(rolling.slice(-120)),
  };
  if (s.kind === 'index') {
    // vol indices: the LEVEL is the signal → percentile of level over 1y
    const lv = pts.slice(-252).map(p => p.v);
    out.pct = pctRank(lv, last);
    out.regime = regime(out.pct);
    out.extra = { hi1y: r2(Math.max(...lv)), lo1y: r2(Math.min(...lv)), avg1y: r2(mean(lv)) };
  } else {
    const rvHist = rolling.slice(-252).map(p => p.v);
    out.pct = rv20 != null ? pctRank(rvHist, rv20) : null;
    out.regime = regime(out.pct);
    const g5 = g ? garchHorizon(g, 5) : null;
    out.exp5d = g5 == null ? null : isYield ? r2(g5, 1) : r2(last * (Math.exp(g5 / 100) - 1), last > 100 ? 2 : 4);
    const yr = pts.slice(-252);
    out.extra = {
      ret1m: isYield ? r2((last - (valueAt(pts, lastTs! - 30 * DAY) ?? last)) * 100, 1) : r2((last / (valueAt(pts, lastTs! - 30 * DAY) ?? last) - 1) * 100, 2),
      maxDD1y: isYield ? null : maxDrawdownPct(yr.map(p => p.v)),
    };
  }
  return out;
}

/* ---------------- class builders ---------------- */
export async function buildClass(env: Env, cls: VolClass, prev?: any): Promise<any> {
  const ids = CLASS_IDS(cls);
  const extraIds = cls === 'rates' ? ['FEDLO', 'FEDHI', 'ECBDFR'] : [];
  const data = await readSeries(env, [...ids, ...extraIds], Date.now() - LOOKBACK[cls] * DAY);
  const prevFit = new Map<string, PrevFit>(((prev?.rows ?? []) as VolRow[]).map(r => [r.id, r.garch ? { alpha: r.garch.alpha, beta: r.garch.beta, fitTs: r.garch.fitTs ?? 0 } : null]));
  const rows = ids.filter(id => SERIES[id].kind !== 'mcap').map(id => buildRow(id, data[id] ?? [], prevFit.get(id)));
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  const extras: Record<string, unknown> = {};

  if (cls === 'rates') {
    const tenors = ['UST3M', 'UST2Y', 'UST5Y', 'UST10Y', 'UST30Y'];
    const lastT = Math.max(...tenors.map(t => data[t]?.at(-1)?.t ?? 0));
    const at = (off: number) => tenors.map(t => r2(valueAt(data[t] ?? [], lastT - off * DAY), 3));
    extras.curve = { tenors: ['3M', '2Y', '5Y', '10Y', '30Y'], now: at(0), m1: at(30), y1: at(365), asOf: lastT || null };
    const s2 = data.UST2Y?.at(-1)?.v, s10 = data.UST10Y?.at(-1)?.v, s3m = data.UST3M?.at(-1)?.v;
    extras.spreads = { s2s10bp: s2 != null && s10 != null ? r2((s10 - s2) * 100, 1) : null, s3m10bp: s3m != null && s10 != null ? r2((s10 - s3m) * 100, 1) : null };
    extras.policy = {
      fed: data.FEDLO?.length && data.FEDHI?.length ? { lo: data.FEDLO.at(-1)!.v, hi: data.FEDHI.at(-1)!.v, asOf: data.FEDHI.at(-1)!.t, source: 'FRED DFEDTARL/DFEDTARU' } : null,
      ecb: data.ECBDFR?.length ? { rate: data.ECBDFR.at(-1)!.v, asOf: data.ECBDFR.at(-1)!.t, source: 'FRED ECBDFR' } : null,
    };
  }
  if (cls === 'stable') {
    const caps = ids.filter(id => SERIES[id].kind === 'mcap').map(id => ({ id: id.replace('.MCAP', ''), pts: data[id] ?? [] }));
    const tot = caps.reduce((s, c) => s + (c.pts.at(-1)?.v ?? 0), 0);
    extras.mcap = caps.map(c => {
      const v = c.pts.at(-1)?.v ?? null, m30 = c.pts.length > 30 ? c.pts[c.pts.length - 31].v : null;
      return { id: c.id, mcap: v, share: v && tot ? r2(v / tot * 100, 2) : null, chg30d: v && m30 ? r2((v / m30 - 1) * 100, 2) : null, asOf: c.pts.at(-1)?.t ?? null };
    });
    extras.totalMcap = tot || null;
  }
  if (cls === 'insurance') {
    const cpi = byId.CPI_ALL?.extra?.yoy as number | null | undefined;
    extras.vsCpi = ['INS_AUTO', 'INS_HOME', 'INS_HEALTH', 'INS_PC_PPI'].map(id => {
      const y = byId[id]?.extra?.yoy as number | null | undefined;
      return { id, label: SERIES[id].label, yoy: y ?? null, spreadPp: y != null && cpi != null ? r2(y - cpi, 2) : null };
    });
    extras.cpiYoy = cpi ?? null;
  }
  if (cls === 'equity') {
    const vrp = (iv: string, under: string) => {
      const a = byId[iv]?.last, b = byId[under]?.rv20;
      return a != null && b != null ? { implied: a, realized20: b, spread: r2(a - b, 2) } : null;
    };
    extras.vrp = { spx: vrp('VIX', 'SPX'), ndx: vrp('VXN', 'NDX') };
  }
  if (cls === 'commod') {
    const vrp = (iv: string, under: string) => {
      const a = byId[iv]?.last, b = byId[under]?.rv20;
      return a != null && b != null ? { implied: a, realized20: b, spread: r2(a - b, 2) } : null;
    };
    extras.vrp = { gold: vrp('GVZ', 'GOLD'), oil: vrp('OVX', 'OIL') };
  }
  return { cls, builtAt: Date.now(), rows, extras };
}

/* ---------------- cross-asset: stress, correlation, σ-move alerts ---------------- */
const CORR_IDS = ['SPX', 'NDX', 'VIX', 'UST10Y', 'DXY', 'EURUSD', 'USDJPY', 'GOLD', 'OIL', 'KIE'];

export async function buildCross(env: Env, classes: Record<string, any>): Promise<any> {
  const row = (cls: string, id: string): VolRow | undefined => classes[cls]?.rows?.find((r: VolRow) => r.id === id);
  const avg = (xs: (number | null | undefined)[]) => { const a = xs.filter((x): x is number => x != null && isFinite(x)); return a.length ? Math.round(mean(a)) : null; };
  const comps: Record<string, { pct: number | null; basis: string }> = {
    equity: { pct: row('equity', 'VIX')?.pct ?? null, basis: 'VIX level, 1y percentile' },
    rates: { pct: row('rates', 'MOVE')?.pct ?? avg(['UST2Y', 'UST10Y'].map(i => row('rates', i)?.pct)), basis: 'MOVE level (or UST RV20) percentile' },
    fx: { pct: avg((classes.fx?.rows ?? []).map((r: VolRow) => r.pct)), basis: 'avg RV20 percentile, majors + DXY' },
    commod: { pct: avg([row('commod', 'GVZ')?.pct, row('commod', 'OVX')?.pct]), basis: 'GVZ + OVX level percentiles' },
    stable: { pct: avg(['USDT', 'USDC'].map(i => row('stable', i)?.pct)), basis: '|depeg| percentile, USDT + USDC' },
  };
  const score = avg(Object.values(comps).map(c => c.pct));

  const data = await readSeries(env, CORR_IDS, Date.now() - 140 * DAY);
  const ch: Record<string, Pt[]> = {};
  for (const id of CORR_IDS) ch[id] = changes(SERIES[id].kind, data[id] ?? []);
  const m = CORR_IDS.map(a => CORR_IDS.map(b => (a === b ? 1 : corrAligned(ch[a], ch[b], 60))));

  const alerts: { id: string; label: string; cls: string; z: number; chg: number | null; chgUnit: string; ts: number | null }[] = [];
  for (const cls of VOL_CLASSES) for (const r of (classes[cls]?.rows ?? []) as VolRow[]) {
    if (r.z == null || r.stale) continue;
    const lim = r.freq === 'monthly' ? 2 : 2.5;
    if (Math.abs(r.z) >= lim) alerts.push({ id: r.id, label: r.label, cls, z: r.z, chg: r.chg, chgUnit: r.chgUnit, ts: r.lastTs });
  }
  alerts.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return {
    builtAt: Date.now(),
    stress: { score, regime: regime(score), components: comps, note: 'CALC · equal-weight average of the component percentiles · not an official index' },
    corr: { ids: CORR_IDS, m, window: '60 obs, daily changes (log % / bp)' },
    alerts: alerts.slice(0, 20),
  };
}

/* ---------------- scheduler + readers ---------------- */
export async function readSnapshots(env: Env, prefix = 'vol:'): Promise<Record<string, { ts: number; v: any }>> {
  const r = await env.DB.prepare(`SELECT key, ts, json FROM snapshots WHERE substr(key,1,?2) = ?1`).bind(prefix, prefix.length).all<{ key: string; ts: number; json: string }>();
  const o: Record<string, { ts: number; v: any }> = {};
  for (const x of r.results ?? []) { try { o[x.key.slice(prefix.length)] = { ts: x.ts, v: JSON.parse(x.json) }; } catch { /* skip corrupt */ } }
  return o;
}
async function writeSnap(env: Env, key: string, v: unknown): Promise<void> {
  await env.DB.prepare('INSERT INTO snapshots(key, ts, json) VALUES(?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET ts=excluded.ts, json=excluded.json')
    .bind(key, Date.now(), JSON.stringify(v)).run();
}

/** rebuild ONE class per call + the cross snapshot.
    pick: explicit class → else a class with no snapshot yet → else rotate by 10-min slot.
    rotation (not "oldest first") means a class that keeps dying on the CPU limit can never
    block the others; each class is rebuilt once an hour. */
export async function refreshVol(env: Env, opts: { cls?: VolClass; slot?: number } = {}): Promise<{ built: string[] }> {
  const snaps = await readSnapshots(env);
  const missing = VOL_CLASSES.filter(c => !snaps[c]);
  const slot = opts.slot ?? Math.floor(Date.now() / 600000);
  const pick: VolClass[] = opts.cls ? [opts.cls] : missing.length ? [missing[slot % missing.length]] : [VOL_CLASSES[slot % VOL_CLASSES.length]];
  const built: string[] = [];
  for (const c of pick) {
    try {
      const v = await buildClass(env, c, snaps[c]?.v);
      await writeSnap(env, 'vol:' + c, v);
      snaps[c] = { ts: Date.now(), v };
      built.push(c);
    } catch (e) { console.error('VOL_BUILD_FAIL', c, String((e as Error)?.message ?? e).slice(0, 160)); }
  }
  {
    const classes = Object.fromEntries(VOL_CLASSES.map(c => [c, snaps[c]?.v]));
    try { await writeSnap(env, 'vol:x', await buildCross(env, classes)); built.push('x'); }
    catch (e) { console.error('VOL_CROSS_FAIL', String((e as Error)?.message ?? e).slice(0, 160)); }
  }
  return { built };
}
