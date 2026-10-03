/* ================================================================
   VOLATILITY MATH — pure functions, no I/O.
   returns convention by kind:
     price/index/mcap → log return ×100   (%)
     yield/rate       → level change ×100 (bp)
     peg              → change of deviation from 1.00 in bp
     cpi (monthly)    → m/m % change
   annualization: sqrt(252) trading days, sqrt(365) for 24/7 assets, sqrt(12) monthly
   ================================================================ */
import type { SeriesKind } from '../store/registry';

export interface Pt { t: number; v: number }

/* month index (UTC) — monthly math is by calendar month, never by array position:
   a skipped release (FRED '.') must not turn m/m into a 2-month change. */
export const monthIdx = (t: number) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
export function monthlyMap(pts: Pt[]): Map<number, Pt> { return new Map(pts.map(p => [monthIdx(p.t), p])); }
/** YoY % by exact month t vs t−12; months without both points are skipped */
export function monthlyYoY(pts: Pt[]): Pt[] {
  const m = monthlyMap(pts), o: Pt[] = [];
  for (const p of pts) { const b = m.get(monthIdx(p.t) - 12); if (b) o.push({ t: p.t, v: (p.v / b.v - 1) * 100 }); }
  return o;
}

export function changes(kind: SeriesKind, pts: Pt[]): Pt[] {
  const o: Pt[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].v, b = pts[i].v;
    if (kind === 'cpi' && monthIdx(pts[i].t) - monthIdx(pts[i - 1].t) !== 1) continue; // gap → no m/m
    let r: number;
    if (kind === 'yield' || kind === 'rate') r = (b - a) * 100;
    else if (kind === 'peg') r = (b - a) * 1e4;
    else if (kind === 'cpi') r = (b / a - 1) * 100;
    else r = Math.log(b / a) * 100;
    if (isFinite(r)) o.push({ t: pts[i].t, v: r });
  }
  return o;
}

export const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
export function stdev(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
/** realized vol of the last n changes, annualized */
export function rv(ch: number[], n: number, ann: number): number | null {
  if (ch.length < Math.min(n, 5)) return null;
  const s = stdev(ch.slice(-n));
  return isFinite(s) ? s * Math.sqrt(ann) : null;
}
/** rolling realized vol series (for percentiles and charts) */
export function rollingRv(ch: Pt[], n: number, ann: number): Pt[] {
  const o: Pt[] = [];
  if (ch.length < n) return o;
  let s = 0, s2 = 0;
  for (let i = 0; i < ch.length; i++) {
    s += ch[i].v; s2 += ch[i].v ** 2;
    if (i >= n) { s -= ch[i - n].v; s2 -= ch[i - n].v ** 2; }
    if (i >= n - 1) {
      const m = s / n, varr = Math.max(0, (s2 - n * m * m) / (n - 1));
      o.push({ t: ch[i].t, v: Math.sqrt(varr * ann) });
    }
  }
  return o;
}
/** RiskMetrics EWMA daily σ (λ = 0.94) */
export function ewma(ch: number[], lambda = 0.94): number | null {
  if (ch.length < 20) return null;
  let v = mean(ch.slice(0, 20).map(x => x * x));
  for (const x of ch.slice(20)) v = lambda * v + (1 - lambda) * x * x;
  return Math.sqrt(v);
}
/** percentile rank of x within arr (0–100) */
export function pctRank(arr: number[], x: number): number | null {
  const a = arr.filter(isFinite);
  if (a.length < 20 || !isFinite(x)) return null;
  let below = 0;
  for (const v of a) if (v < x) below++;
  return Math.round((below / a.length) * 100);
}
export function regime(pct: number | null): 'LOW' | 'NORMAL' | 'ELEVATED' | 'STRESS' | '—' {
  if (pct == null) return '—';
  return pct < 20 ? 'LOW' : pct < 60 ? 'NORMAL' : pct < 85 ? 'ELEVATED' : 'STRESS';
}

/* ---------------- GARCH(1,1) ----------------
   σ²_t = ω + α·r²_{t-1} + β·σ²_{t-1},  ω = V_L(1−α−β)  (variance targeting)
   fit = grid search over (α,β) maximizing Gaussian log-likelihood.
   cheap enough for Workers CPU (~70 combos × ≤500 obs).            */
export interface Garch { alpha: number; beta: number; persist: number; vl: number; sigmaNext: number; cond: number[]; ll: number }
// coarse grid (30 combos) on ≤250 obs ≈ 7.5k steps per series: fits the Workers Free CPU budget.
// params are cached in the snapshot and refit once a day; other runs only do the O(n) recursion.
const AL = [0.03, 0.06, 0.09, 0.13, 0.18];
const BE = [0.72, 0.8, 0.86, 0.9, 0.93, 0.96];

export function garchFit(r0: number[], fixed?: { alpha: number; beta: number } | null): Garch | null {
  const r = r0.slice(-250);
  if (r.length < 60) return null;
  const m = mean(r);
  const x = r.map(v => v - m);
  const vl = mean(x.map(v => v * v));
  if (!(vl > 0)) return null;
  let best: { a: number; b: number; ll: number } | null = null;
  const grid: [number, number][] = fixed && fixed.alpha + fixed.beta < 0.999 ? [[fixed.alpha, fixed.beta]] : AL.flatMap(a => BE.map(b => [a, b] as [number, number]));
  for (const [a, b] of grid) {
    if (a + b >= 0.995) continue;
    const w = vl * (1 - a - b);
    let s2 = vl, ll = 0;
    for (const e of x) {
      ll += -0.5 * (Math.log(s2) + (e * e) / s2);
      s2 = w + a * e * e + b * s2;
    }
    if (!best || ll > best.ll) best = { a, b, ll };
  }
  if (!best) return null;
  const w = vl * (1 - best.a - best.b);
  const cond: number[] = [];
  let s2 = vl;
  for (const e of x) { cond.push(Math.sqrt(s2)); s2 = w + best.a * e * e + best.b * s2; }
  return { alpha: best.a, beta: best.b, persist: best.a + best.b, vl, sigmaNext: Math.sqrt(s2), cond, ll: best.ll };
}
/** h-step cumulative σ (same units as returns) */
export function garchHorizon(g: Garch, h: number): number {
  const p = g.persist;
  let s = 0, next = g.sigmaNext ** 2;
  for (let k = 1; k <= h; k++) { s += g.vl + Math.pow(p, k - 1) * (next - g.vl); }
  return Math.sqrt(Math.max(0, s));
}

/* ---------------- correlation ---------------- */
export function corrAligned(a: Pt[], b: Pt[], n = 60): number | null {
  const mb = new Map(b.map(p => [p.t, p.v]));
  const xs: number[] = [], ys: number[] = [];
  for (const p of a) { const y = mb.get(p.t); if (y != null) { xs.push(p.v); ys.push(y); } }
  const X = xs.slice(-n), Yv = ys.slice(-n);
  if (X.length < 20) return null;
  const mx = mean(X), my = mean(Yv);
  let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < X.length; i++) { const dx = X[i] - mx, dy = Yv[i] - my; sxy += dx * dy; sx += dx * dx; sy += dy * dy; }
  return sx && sy ? +(sxy / Math.sqrt(sx * sy)).toFixed(2) : null;
}
export function maxDrawdownPct(v: number[]): number {
  let pk = -Infinity, dd = 0;
  for (const x of v) { pk = Math.max(pk, x); if (pk > 0) dd = Math.max(dd, (pk - x) / pk); }
  return +(dd * 100).toFixed(2);
}
