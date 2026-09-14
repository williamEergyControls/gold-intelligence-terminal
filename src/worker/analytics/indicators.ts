import type { Candle } from '../types';

export const sma = (a: number[], p: number): (number | null)[] => a.map((_, i) => i < p - 1 ? null : a.slice(i - p + 1, i + 1).reduce((s, v) => s + v, 0) / p);
export const ema = (a: number[], p: number): number[] => { const k = 2 / (p + 1); const o: number[] = []; a.forEach((v, i) => o.push(i ? v * k + o[i - 1] * (1 - k) : v)); return o; };

export function rsi(closes: number[], p = 14): number {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
export function macdHist(closes: number[]): number {
  if (closes.length < 35) return 0;
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const line = closes.map((_, i) => e12[i] - e26[i]);
  const sig = ema(line.slice(25), 9);
  return line[line.length - 1] - sig[sig.length - 1];
}
export function atr(candles: Candle[], p = 14): number {
  const cs = candles.slice(-p - 1);
  if (cs.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < cs.length; i++) s += Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
  return s / (cs.length - 1);
}
export function annVolPct(closes: number[], win = 20): number {
  const c = closes.slice(-(win + 1));
  if (c.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
  const m = rets.reduce((s, v) => s + v, 0) / rets.length;
  const varr = rets.reduce((s, v) => s + (v - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr * 252) * 100;
}
export function drawdowns(closes: number[]): { maxPct: number; currentPct: number } {
  let peak = -Infinity, maxDD = 0;
  for (const c of closes) { peak = Math.max(peak, c); maxDD = Math.max(maxDD, (peak - c) / peak); }
  const last = closes[closes.length - 1] ?? 0;
  const hi = Math.max(...closes);
  return { maxPct: maxDD * 100, currentPct: hi > 0 ? (hi - last) / hi * 100 : 0 };
}
export function zLast(a: number[], win = 60): number | null {
  const w = a.slice(-win);
  if (w.length < 10) return null;
  const m = w.reduce((s, v) => s + v, 0) / w.length;
  const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / w.length);
  return sd > 0 ? (w[w.length - 1] - m) / sd : 0;
}
export function corr(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const A = a.slice(-n), B = b.slice(-n);
  const ma = A.reduce((s, v) => s + v, 0) / n, mb = B.reduce((s, v) => s + v, 0) / n;
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) { const x = A[i] - ma, y = B[i] - mb; sa += x * x; sb += y * y; sab += x * y; }
  return sa && sb ? sab / Math.sqrt(sa * sb) : null;
}
export const norm = (v: number, lo: number, hi: number) => Math.max(0, Math.min(100, Math.round(((v - lo) / (hi - lo)) * 100)));
