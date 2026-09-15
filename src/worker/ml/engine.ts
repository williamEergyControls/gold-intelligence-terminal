/* ================================================================
   ML ENGINE — pure TypeScript, no libraries.
   - Logistic Regression: your P(Y=1) = 1/(1+e^-z), gradient descent
   - GBS: gradient boosting on stumps (XGBoost's core math, depth-1)
   - 3-state HMM: fixed transitions/emissions, forward-filtered
   All trained on REAL Yahoo/FRED data. All sized for Worker CPU.
   ================================================================ */

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/* ---------- 1. LOGISTIC REGRESSION ---------- */
export interface LogitModel { w: number[]; b: number; mean: number[]; std: number[] }
export function trainLogistic(X: number[][], y: number[], epochs = 120, lr = 0.05, l2 = 0.01): LogitModel {
  const n = X.length, d = X[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(1);
  for (let j = 0; j < d; j++) {
    let s = 0; for (let i = 0; i < n; i++) s += X[i][j]; mean[j] = s / n;
    let v = 0; for (let i = 0; i < n; i++) v += (X[i][j] - mean[j]) ** 2;
    std[j] = Math.sqrt(v / n) || 1;
  }
  const Z = X.map(r => r.map((v, j) => (v - mean[j]) / std[j]));
  const w = new Array(d).fill(0); let b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * Z[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b, mean, std };
}
export function predictLogistic(m: LogitModel, x: number[]): number {
  let z = m.b; for (let j = 0; j < m.w.length; j++) z += m.w[j] * (x[j] - m.mean[j]) / m.std[j];
  return sigmoid(z);
}

/* ---------- 2. GRADIENT-BOOSTED STUMPS (XGBoost-lite) ----------
   F_{k}(x) = F_{k-1}(x) + lr * f_k(x), f_k = depth-1 tree fitted to
   the logloss gradient g_i = y_i - sigmoid(F(x_i)).                */
export interface GBSModel { base: number; lr: number; stumps: { j: number; thr: number; left: number; right: number }[] }
export function trainGBS(X: number[][], y: number[], trees = 25, lr = 0.1): GBSModel {
  const n = X.length, d = X[0].length;
  const pos = y.reduce((a, b) => a + b, 0);
  const base = Math.log((pos + 0.5) / (n - pos + 0.5)); // init: log-odds of base rate
  const F = new Array(n).fill(base);
  const stumps: GBSModel['stumps'] = [];
  for (let k = 0; k < trees; k++) {
    const g = F.map((f, i) => y[i] - sigmoid(f)); // residuals = logloss gradient
    let best = { j: 0, thr: 0, left: 0, right: 0, gain: -Infinity };
    for (let j = 0; j < d; j++) {
      const vals = X.map(r => r[j]).sort((a, b) => a - b);
      for (let t = 1; t <= 7; t++) {
        const thr = vals[Math.floor(n * t / 8)];
        let ls = 0, lc = 0, rs = 0, rc = 0;
        for (let i = 0; i < n; i++) if (X[i][j] <= thr) { ls += g[i]; lc++; } else { rs += g[i]; rc++; }
        const gain = (ls * ls) / (lc || 1) + (rs * rs) / (rc || 1);
        if (gain > best.gain) best = { j, thr, left: ls / (lc || 1), right: rs / (rc || 1), gain };
      }
    }
    stumps.push({ j: best.j, thr: best.thr, left: best.left, right: best.right });
    for (let i = 0; i < n; i++) F[i] += lr * (X[i][best.j] <= best.thr ? best.left : best.right);
  }
  return { base, lr, stumps };
}
export function predictGBS(m: GBSModel, x: number[]): number {
  let f = m.base;
  for (const s of m.stumps) f += m.lr * (x[s.j] <= s.thr ? s.left : s.right);
  return sigmoid(f);
}

/* ---------- 3. 3-STATE HMM (fixed params, forward algorithm) ----------
   States: BULL / NEUTRAL / RISKOFF. Observations: (r20, vol20 z, drawdown).
   Fixed emission Gaussians + persistence-favoring transition matrix.
   No Baum-Welch — parameters fixed by design, filtering is the real math. */
export interface RegimeResult { state: 'BULL' | 'NEUTRAL' | 'RISKOFF'; probs: [number, number, number] }
const REG = {
  trans: [[0.90, 0.08, 0.02], [0.10, 0.80, 0.10], [0.05, 0.15, 0.80]],
  // emissions (mu, sigma) per state over [r20%, volZ, dd%]
  emis: [
    [[6, 6], [-0.3, 1.0], [-3, 4]],    // BULL: positive trend, normal vol, shallow dd
    [[0, 4], [0, 1.0], [-8, 6]],       // NEUTRAL
    [[-4, 5], [1.2, 1.0], [-16, 8]],   // RISKOFF: negative trend, high vol, deep dd
  ],
};
function emisLogLP(s: number, o: number[]): number {
  let lp = 0;
  for (let j = 0; j < 3; j++) {
    const [mu, sd] = REG.emis[s][j];
    lp += -0.5 * Math.log(2 * Math.PI * sd * sd) - ((o[j] - mu) ** 2) / (2 * sd * sd);
  }
  return lp;
}
export function regimeHMM(obs: number[] /* last ~60 days of [r20, volZ, dd] */): RegimeResult {
  let a = [1 / 3, 1 / 3, 1 / 3];
  for (const o of obs) {
    const na = [0, 0, 0];
    for (let s = 0; s < 3; s++) {
      let pre = 0;
      for (let p = 0; p < 3; p++) pre += a[p] * REG.trans[p][s];
      na[s] = pre * Math.exp(emisLogLP(s, o));
    }
    const sum = na[0] + na[1] + na[2] || 1;
    a = na.map(v => v / sum);
  }
  const idx = a.indexOf(Math.max(...a)) as 0 | 1 | 2;
  return { state: (['BULL', 'NEUTRAL', 'RISKOFF'] as const)[idx], probs: [a[0], a[1], a[2]] };
}

/* ---------- 4. FEATURE ENGINE (all from REAL data) ---------- */
export const FEATURE_NAMES = ['r5', 'r20', 'r50', 'rsi14', 'macdN', 'vol20', 'distSMA50', 'dxyR20', 'ryLvl', 'ryChg5', 'vix', 'oilR20'];
export interface DailyInput { gold: number[]; dxy: number[]; vix: number[]; oil: number[]; ry: { t: number; v: number }[] }

export function rsiF(c: number[], p = 14): number {
  if (c.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function emaF(a: number[], p: number): number[] { const k = 2 / (p + 1), o: number[] = []; a.forEach((v, i) => o.push(i ? v * k + o[i - 1] * (1 - k) : v)); return o; }
export function macdNorm(c: number[]): number {
  if (c.length < 35) return 0;
  const e12 = emaF(c, 12), e26 = emaF(c, 26);
  const line = c.map((_, i) => e12[i] - e26[i]);
  const sig = emaF(line.slice(25), 9);
  return (line[line.length - 1] - sig[sig.length - 1]) / (c[c.length - 1] || 1) * 100; // % of price
}
export function volAnn(c: number[], w = 20): number {
  const a = c.slice(-(w + 1)); if (a.length < 3) return 0;
  const r: number[] = []; for (let i = 1; i < a.length; i++) r.push(Math.log(a[i] / a[i - 1]));
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252) * 100;
}
const ret = (c: number[], n: number) => c.length > n ? (c[c.length - 1] / c[c.length - 1 - n] - 1) * 100 : 0;
const ff = (ry: { t: number; v: number }[], t: number) => {
  let v: number | null = null;
  for (const p of ry) { if (p.t <= t) v = p.v; else break; }
  return v ?? (ry[0]?.v ?? 1.5);
};

/** Build feature row at index i (needs i >= 50 history). Timestamps = candle times. */
export function featuresAt(d: DailyInput, ts: number[], i: number): number[] | null {
  if (i < 55 || i + 5 >= d.gold.length) return null; // need history + future label
  const g = d.gold.slice(0, i + 1);
  const sma50 = g.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const dd = (() => { let peak = -Infinity, last = g[g.length - 1]; for (const v of g) peak = Math.max(peak, v); return (peak - last) / peak * 100; })();
  const ryNow = ff(d.ry, ts[i]), ryPrev = ff(d.ry, ts[Math.max(0, i - 5)]);
  const f = [
    ret(g, 5), ret(g, 20), ret(g, 50),
    rsiF(g) / 100, macdNorm(g), volAnn(g) / 100,
    (g[g.length - 1] / sma50 - 1) * 100,
    ret(d.dxy.slice(0, i + 1), 20),
    ryNow, ryNow - ryPrev,
    d.vix[i] ?? 20, ret(d.oil.slice(0, i + 1), 20),
  ];
  if (f.some(v => !isFinite(v))) return null;
  return f;
}
export function labelAt(d: DailyInput, i: number): number | null {
  if (i + 5 >= d.gold.length) return null;
  return d.gold[i + 5] > d.gold[i] ? 1 : 0;
}
