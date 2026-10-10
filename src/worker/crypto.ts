/* ================================================================
   BITCOIN + STABLECOINS vs GOLD — /api/markets/btc
   INIT     warehouse: BTC (CoinGecko daily), 6 stablecoin market caps, GOLD (GC), SPX, NDX, DXY
   EVALUATE align on common days → daily log returns → rolling 60-day correlation per pair
            stablecoin supply = sum of tracked caps; its daily growth is the "dry powder" series
            BTC vs gold market value: gold stock ≈ 218,000 t (World Gold Council scale, rounded) × GC price
   PUBLISH  kpis, index-100 series, correlation series, 60-day vol; shared D1 cache 30 min
   ================================================================ */
import type { Env } from './types';
import { readSeries } from './store/ingest';

const STABLES = ['USDT', 'USDC', 'DAI', 'USDE', 'FDUSD', 'PYUSD'];
const GOLD_TONNES = 218000;
const OZ_PER_T = 32150.75;
const W = 60;
type P = { t: number; v: number };

export function rollCorr(a: number[], b: number[], w: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < a.length; i++) {
    if (i + 1 < w) { out.push(null); continue; }
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let j = i - w + 1; j <= i; j++) { sa += a[j]; sb += b[j]; saa += a[j] * a[j]; sbb += b[j] * b[j]; sab += a[j] * b[j]; }
    const cov = sab / w - (sa / w) * (sb / w), va = saa / w - (sa / w) ** 2, vb = sbb / w - (sb / w) ** 2;
    out.push(va > 0 && vb > 0 ? +(cov / Math.sqrt(va * vb)).toFixed(3) : null);
  }
  return out;
}

export async function buildBtc(env: Env) {
  const ids = ['BTC', 'BTC.MCAP', 'GOLD', 'SPX', 'NDX', 'DXY', ...STABLES.map(s => s + '.MCAP')];
  const S = await readSeries(env, ids, Date.now() - 420 * 864e5);
  const btc = S.BTC ?? [];
  if (btc.length < 30) return { ready: false, note: 'Bitcoin history fills with the first CoinGecko pull (hourly unit, 365 days).', n: btc.length };
  // stablecoin supply: sum on days where USDT and USDC both report (they are ~85% of supply)
  const sup = new Map<number, number>();
  const usdt = new Map((S['USDT.MCAP'] ?? []).map(p => [p.t, p.v])), usdc = new Map((S['USDC.MCAP'] ?? []).map(p => [p.t, p.v]));
  const rest = ['DAI', 'USDE', 'FDUSD', 'PYUSD'].map(k => new Map((S[k + '.MCAP'] ?? []).map(p => [p.t, p.v])));
  for (const [t, v] of usdt) { if (!usdc.has(t)) continue; let s = v + usdc.get(t)!; for (const R of rest) s += R.get(t) ?? 0; sup.set(t, s); }
  const supply: P[] = [...sup.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
  // common trading days: BTC trades every day, the others on weekdays → align on the others
  const m = (id: string) => new Map((S[id] ?? []).map(p => [p.t, p.v]));
  const B = m('BTC'), Gd = m('GOLD'), SP = m('SPX'), NQ = m('NDX'), DX = m('DXY');
  const days = [...Gd.keys()].filter(t => B.has(t) && SP.has(t) && DX.has(t)).sort((a, b) => a - b);
  const r = (M: Map<number, number>) => days.slice(1).map((t, i) => Math.log(M.get(t)! / M.get(days[i])!));
  const rB = r(B), rG = r(Gd), rS = r(SP), rD = r(DX);
  const rN = days.every(t => NQ.has(t)) ? r(NQ) : null;
  // supply growth on the same days (carry the last known value across gaps)
  const sv: (number | null)[] = []; { let j = 0, v: number | null = null; for (const t of days) { while (j < supply.length && supply[j].t <= t) v = supply[j++].v; sv.push(v); } }
  const rU = days.slice(1).map((_, i) => (sv[i + 1] != null && sv[i] != null && sv[i]! > 0 ? Math.log(sv[i + 1]! / sv[i]!) : 0));
  const T = days.slice(1);
  const ser = (xs: (number | null)[]) => T.map((t, i) => ({ t, v: xs[i] })).filter(p => p.v != null) as P[];
  const corr = {
    gold: ser(rollCorr(rB, rG, W)), spx: ser(rollCorr(rB, rS, W)), dxy: ser(rollCorr(rB, rD, W)),
    ndx: rN ? ser(rollCorr(rB, rN, W)) : [], supply: ser(rollCorr(rB, rU, W)), goldSpx: ser(rollCorr(rG, rS, W)),
  };
  const vol = (x: number[], ann: number) => { const a = x.slice(-W); const mu = a.reduce((s, v) => s + v, 0) / a.length; return +(Math.sqrt(a.reduce((s, v) => s + (v - mu) ** 2, 0) / (a.length - 1)) * Math.sqrt(ann) * 100).toFixed(1); };
  // index 100 from one year ago, on BTC's own calendar for BTC and gold's for gold
  const yr = Date.now() - 365 * 864e5;
  const idx = (pts: P[]) => { const s = pts.filter(p => p.t >= yr); const b = s[0]?.v; return b ? s.map(p => ({ t: p.t, v: +(100 * p.v / b).toFixed(2) })) : []; };
  const last = (pts: P[]) => pts.at(-1) ?? null;
  const ago = (pts: P[], d: number) => { const t = (pts.at(-1)?.t ?? 0) - d * 864e5; for (let i = pts.length - 1; i >= 0; i--) if (pts[i].t <= t) return pts[i]; return null; };
  const pct = (pts: P[], d: number) => { const a = last(pts), b = ago(pts, d); return a && b ? +((a.v / b.v - 1) * 100).toFixed(2) : null; };
  const gLast = last(S.GOLD ?? []);
  const goldCap = gLast ? gLast.v * GOLD_TONNES * OZ_PER_T : null;
  const bCap = last(S['BTC.MCAP'] ?? []);
  return {
    ready: true, builtAt: Date.now(), window: W,
    kpi: {
      btc: last(btc), btc30: pct(btc, 30), btc365: pct(btc, 365), btcCap: bCap?.v ?? null,
      goldCap, btcGoldCapPct: goldCap && bCap ? +(100 * bCap.v / goldCap).toFixed(2) : null,
      supply: last(supply), supply30: pct(supply, 30), supply365: pct(supply, 365),
      volBtc: rB.length >= W ? vol(rB, 252) : null, volGold: rG.length >= W ? vol(rG, 252) : null,
      corrGold: corr.gold.at(-1)?.v ?? null, corrSpx: corr.spx.at(-1)?.v ?? null, corrDxy: corr.dxy.at(-1)?.v ?? null, corrSupply: corr.supply.at(-1)?.v ?? null,
    },
    norm: { btc: idx(btc), gold: idx(S.GOLD ?? []), spx: idx(S.SPX ?? []) },
    supply: supply.slice(-400).map(p => ({ t: p.t, v: +(p.v / 1e9).toFixed(2) })),   // $ bn
    corr,
    notes: { goldStock: GOLD_TONNES.toLocaleString('en-US') + ' tonnes above ground (rounded, World Gold Council scale)', days: days.length },
  };
}
