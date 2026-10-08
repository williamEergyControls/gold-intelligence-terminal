/* ================================================================
   OUTLOOK ENGINE — connects the slow dots for a 3–12 month holder. No day trading.
   INIT     read once: warehouse (~20 series), shipping + drought caches, COT, Form 4, crowd
   EVALUATE every factor → score s in [-1, +1] × weight, with a plain-language reading
            Economy  c/10 = 5 + 5 × Σ(w·s)/Σw   (10 = strong expansion, 0 = contraction)
            Gold     y/10 = 5 + 5 × Σ(w·s)/Σw   (10 = best setup to accumulate)
            stance   ≥ 6.8 accumulate · 4.5–6.8 hold · < 4.5 trim / wait
            odds     the 4 gold factors with 2 years of daily history are replayed on every
                     past day; of the days that scored like today, how often was gold higher
                     63 trading days later (overlapping windows, so a rough guide)
   PUBLISH  outlook_log (one row per day, point-in-time: the training record for later models)
   ================================================================ */
import type { Env } from '../types';
import { AppCache, cacheGet } from '../cache';
import { readSeries } from '../store/ingest';
import { cotGold, insiderSummary, crowdGold, type Cot, type Insiders, type Crowd } from './sources';

type Pt = { t: number; v: number };
export interface Factor { key: string; group: 'econ' | 'gold'; label: string; w: number; s: number | null; pts: number; reading: string; source: string; asOf: string | null }
export interface Outlook {
  ts: number; day: string;
  econ: { score: number; phase: string; factors: Factor[]; coverage: string };
  gold: { score: number; stance: string; stanceNote: string; horizon: string; price: number | null; factors: Factor[]; coverage: string; flips: string[];
    odds: { n: number; up: number; median: number; from: string; to: string; note: string } | null };
  outlooks: { key: string; title: string; dir: 'up' | 'down' | 'flat'; call: string; conf: string; horizon: string; why: string[] }[];
  missing: { title: string; detail: string; tone: 'pos' | 'neg' | 'neu' }[];
  narrative: { text: string; engine: string };
  ml: { p: number; dir: string } | null;
  inputs: Record<string, string>;
}

const clamp = (x: number, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const DAY = 864e5;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const pct = (x: number | null | undefined, d = 1) => x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
const num = (x: number | null | undefined, d = 2) => x == null || !isFinite(x) ? '–' : x.toFixed(d);
const last = (p: Pt[]) => p.length ? p[p.length - 1] : null;
function at(p: Pt[], t: number): Pt | null { let r: Pt | null = null; for (const x of p) { if (x.t <= t) r = x; else break; } return r; }
function chg(p: Pt[], days: number): number | null { const L = last(p); if (!L) return null; const a = at(p, L.t - days * DAY); return a && a.v ? L.v / a.v - 1 : null; }
function dlt(p: Pt[], days: number): number | null { const L = last(p); if (!L) return null; const a = at(p, L.t - days * DAY); return a ? L.v - a.v : null; }
function sma(v: number[], n: number): number | null { if (v.length < n) return null; let s = 0; for (let i = v.length - n; i < v.length; i++) s += v[i]; return s / n; }
const ord = (n: number) => { const k = Math.round(n), t = k % 100; return k + (t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][k % 10] || 'th'); };
function rank(v: number[], x: number): number { return v.length ? v.filter(y => y <= x).length / v.length : 0.5; }

function score(fs: Factor[]): { score: number; coverage: string } {
  const on = fs.filter(f => f.s != null);
  const W = on.reduce((a, f) => a + f.w, 0);
  const S = on.reduce((a, f) => a + f.w * (f.s as number), 0);
  return { score: W ? +(5 + 5 * S / W).toFixed(1) : 5, coverage: on.length + ' of ' + fs.length + ' inputs live' };
}
function mk(group: Factor['group'], key: string, label: string, w: number, s: number | null, reading: string, source: string, asOf: number | string | null): Factor {
  const sv = s == null || !isFinite(s) ? null : +clamp(s).toFixed(2);
  return { key, group, label, w, s: sv, pts: sv == null ? 0 : +(sv * w).toFixed(2), reading, source, asOf: asOf == null ? null : typeof asOf === 'number' ? iso(asOf) : asOf };
}

/* partial gold score from the 4 factors that have daily history — used for the replay */
function goldCore(c: number[], i: number, ry: (number | null)[], dx: (number | null)[]): number | null {
  if (i < 252 || i - 63 < 0) return null;
  let s200 = 0; for (let k = i - 199; k <= i; k++) s200 += c[k];
  const stretch = c[i] / (s200 / 200) - 1;
  const tr = c[i] / c[i - 252] - 1;
  const ryd = ry[i] != null && ry[i - 63] != null ? (ry[i] as number) - (ry[i - 63] as number) : null;
  const dxc = dx[i] != null && dx[i - 63] != null && dx[i - 63] ? (dx[i] as number) / (dx[i - 63] as number) - 1 : null;
  const parts: [number, number][] = [[1.2, clamp((0.08 - stretch) / 0.12)], [1.0, clamp(tr / 0.2)]];
  if (ryd != null) parts.push([1.0, clamp(-ryd / 0.5)]);
  if (dxc != null) parts.push([0.7, clamp(-dxc / 0.05)]);
  const W = parts.reduce((a, p) => a + p[0], 0);
  return 5 + 5 * parts.reduce((a, p) => a + p[0] * p[1], 0) / W;
}

export async function buildOutlook(env: Env): Promise<Outlook> {
  const now = Date.now();
  const A = await readSeries(env, ['CURVE', 'CREDIT', 'CLAIMS', 'COPPER', 'SPX', 'VIX', 'BDRY', 'GDX', 'SILVER', 'BE10Y', 'GVZ', 'OIL'], now - 420 * DAY);
  const B = await readSeries(env, ['GOLD', 'TIPS10Y', 'DXY', 'UNRATE', 'CONSENT', 'NQH2O', 'CPI_ALL'], now - 760 * DAY);
  const S = { ...A, ...B };
  const [cot, ins, crowd, ship, drought, mlSnap] = await Promise.all([
    cotGold(env), insiderSummary(env), crowdGold(env),
    cacheGet<any>(env, 'page:shipping').then(r => r?.v ?? null).catch(() => null),
    env.CACHE.get('drought:usdm', 'json').catch(() => null) as Promise<any>,
    env.CACHE.get('ml:snap', 'json').catch(() => null) as Promise<any>,
  ]);
  const L = (id: string) => last(S[id] ?? []);

  /* ================= ECONOMY ================= */
  const E: Factor[] = [];
  const curve = S.CURVE ?? [];
  {
    const c = last(curve);
    const inv12 = curve.filter(p => p.t >= now - 365 * DAY && p.v < 0).length > 20;
    let s: number | null = null, r = 'No yield-curve data yet.';
    if (c) {
      if (c.v >= 0 && inv12) { s = -0.5; r = `10Y–3M spread is ${num(c.v)} pts after being inverted in the past year. Re-steepening after an inversion has come before recent recessions.`; }
      else { s = clamp(c.v / 1.5); r = c.v < 0 ? `Curve inverted at ${num(c.v)} pts: bond market pricing slower growth ahead.` : `Curve positive at ${num(c.v)} pts: normal, growth-friendly shape.`; }
    }
    E.push(mk('econ', 'curve', 'Yield curve (10Y–3M)', 1.5, s, r, 'FRED T10Y3M', c?.t ?? null));
  }
  {
    const c = L('CREDIT'), d = dlt(S.CREDIT ?? [], 91);
    const s = c ? 0.6 * clamp(-(d ?? 0) / 0.5) + 0.4 * clamp((2.5 - c.v) / 1.0) : null;
    E.push(mk('econ', 'credit', 'Corporate credit spread', 1.5, s, c ? `Baa spread ${num(c.v)} pts, ${d == null ? 'flat' : (d > 0 ? 'wider' : 'tighter') + ' by ' + num(Math.abs(d)) + ' over 3 months'}. Widening means lenders want more to take company risk.` : 'No credit-spread data yet.', 'FRED BAA10Y', c?.t ?? null));
  }
  {
    const p = S.CLAIMS ?? [];
    let s: number | null = null, r = 'No jobless-claims data yet.';
    if (p.length > 10) {
      const v = p.map(x => x.v), a4 = sma(v, 4) as number, yr = p.filter(x => x.t >= now - 365 * DAY).map(x => x.v), lo = Math.min(...yr);
      const ratio = a4 / lo - 1;
      s = clamp(1 - ratio / 0.15);
      r = `4-week average ${Math.round(a4 / 1000)}k claims, ${pct(ratio, 0)} above the 52-week low. A rise of 20–30% off the low has marked past turns in hiring.`;
    }
    E.push(mk('econ', 'claims', 'Jobless claims', 1.2, s, r, 'FRED ICSA', last(p)?.t ?? null));
  }
  {
    const p = S.UNRATE ?? [];
    let s: number | null = null, r = 'No unemployment data yet.';
    if (p.length >= 15) {
      const v = p.map(x => x.v), a3 = (v[v.length - 1] + v[v.length - 2] + v[v.length - 3]) / 3, lo = Math.min(...v.slice(-15, -3));
      const gap = a3 - lo;
      s = clamp((0.5 - gap) / 0.5);
      r = `Sahm gap ${num(gap)} pts (3-month average jobless rate vs its 12-month low). 0.5 or more has flagged every US recession since 1970.`;
    }
    E.push(mk('econ', 'sahm', 'Unemployment trend (Sahm rule)', 1.2, s, r, 'FRED UNRATE', last(p)?.t ?? null));
  }
  {
    const c = L('CONSENT');
    E.push(mk('econ', 'consumer', 'Consumer sentiment', 0.6, c ? clamp((c.v - 75) / 20) : null, c ? `UMich sentiment ${num(c.v, 1)} (long-run average ≈ 85).` : 'No consumer-sentiment data yet.', 'FRED UMCSENT', c?.t ?? null));
  }
  let cuAu: number | null = null;
  {
    const cu = S.COPPER ?? [], au = S.GOLD ?? [];
    const a = chg(cu, 91), b = chg(au, 91);
    cuAu = a != null && b != null ? (1 + a) / (1 + b) - 1 : null;
    E.push(mk('econ', 'cuau', 'Copper vs gold', 1.0, cuAu == null ? null : clamp(cuAu / 0.1), cuAu == null ? 'No copper/gold data yet.' : `Copper-to-gold ratio ${pct(cuAu)} over 3 months. Copper tracks factories and building; gold tracks fear. A falling ratio is the market leaning defensive.`, 'Yahoo HG=F / GC=F', last(cu)?.t ?? null));
  }
  {
    const b = chg(S.BDRY ?? [], 91);
    E.push(mk('econ', 'freight', 'Dry-bulk freight', 0.7, b == null ? null : clamp(b / 0.25), b == null ? 'No freight data yet.' : `Dry-bulk freight (BDRY) ${pct(b)} over 3 months: the price of moving iron ore, coal and grain.`, 'Yahoo BDRY', last(S.BDRY ?? [])?.t ?? null));
  }
  let transits: number | null = null;
  {
    const ch = (ship?.chokepoints ?? []) as any[];
    let t = 0, p = 0; for (const c of ch) if (c.avg7 != null && c.prev28 != null) { t += c.avg7; p += c.prev28; }
    transits = p ? t / p - 1 : null;
    E.push(mk('econ', 'transits', 'Chokepoint ship traffic', 0.5, transits == null ? null : clamp(transits / 0.1), transits == null ? 'Shipping data loads with the first PortWatch pull.' : `Ships through the world's chokepoints ${pct(transits)} vs the 28-day average (${Math.round(t)} a day).`, 'IMF PortWatch', ship?.chokeAsOf ?? null));
  }
  {
    const sp = S.SPX ?? [], v = sp.map(x => x.v), m = sma(v, 200), Lp = last(sp);
    const d = m && Lp ? Lp.v / m - 1 : null;
    E.push(mk('econ', 'stocks', 'Stocks vs 200-day trend', 0.8, d == null ? null : clamp(d / 0.08), d == null ? 'No S&P data yet.' : `S&P 500 ${pct(d)} vs its 200-day average.`, 'Yahoo ^GSPC', Lp?.t ?? null));
  }
  {
    const vx = S.VIX ?? [], Lv = last(vx);
    const r = Lv ? rank(vx.slice(-252).map(x => x.v), Lv.v) : null;
    E.push(mk('econ', 'vix', 'Stock-market fear (VIX)', 0.5, r == null ? null : clamp((0.5 - r) / 0.5), r == null ? 'No VIX data yet.' : `VIX ${num(Lv!.v, 1)}, ${ord(r * 100)} percentile of the past year.`, 'Yahoo ^VIX', Lv?.t ?? null));
  }
  const dxy3 = chg(S.DXY ?? [], 91);
  E.push(mk('econ', 'dollar', 'Dollar (3 months)', 0.4, dxy3 == null ? null : clamp(-dxy3 / 0.05), dxy3 == null ? 'No dollar data yet.' : `Dollar index ${pct(dxy3)} over 3 months. A rising dollar tightens money for the rest of the world.`, 'Yahoo DX-Y.NYB', last(S.DXY ?? [])?.t ?? null));
  const ec = score(E);
  const cNow = last(curve)?.v ?? 0, credD = dlt(S.CREDIT ?? [], 91) ?? 0;
  const phase = ec.score >= 6.5 && cNow >= 0 ? 'Expansion'
    : ec.score >= 5 && (cNow < 0 || credD > 0.3) ? 'Late cycle'
    : ec.score >= 5 ? 'Steady'
    : ec.score >= 3.5 ? 'Slowing' : 'Contraction risk';

  /* ================= GOLD ================= */
  const G: Factor[] = [];
  const gold = S.GOLD ?? [], gc = gold.map(x => x.v), gL = last(gold);
  const tips = S.TIPS10Y ?? [];
  // valuation: ln(gold) regressed on the 10Y real yield over the stored window (≤ 2 years)
  {
    const xs: number[] = [], ys: number[] = [];
    let j = 0;
    for (const g of gold) { while (j + 1 < tips.length && tips[j + 1].t <= g.t) j++; const tp = tips[j]; if (tp && tp.t <= g.t && g.t - tp.t < 6 * DAY) { xs.push(tp.v); ys.push(Math.log(g.v)); } }
    let s: number | null = null, r = 'Needs gold and real-yield history (fills in after the first ingest cycles).';
    if (xs.length > 120) {
      const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
      let sxy = 0, sxx = 0; for (let k = 0; k < n; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; }
      const b = sxx ? sxy / sxx : 0, a = my - b * mx;
      const res = ys.map((y, k) => y - (a + b * xs[k]));
      const sd = Math.sqrt(res.reduce((q, e) => q + e * e, 0) / n) || 1e-9;
      const z = res[n - 1] / sd, fair = Math.exp(a + b * xs[n - 1]);
      s = clamp(-z / 2);
      r = `At a ${num(xs[n - 1])}% real yield the 2-year relationship puts fair value near $${Math.round(fair).toLocaleString('en-US')}; gold is ${pct(Math.abs(Math.exp(ys[n - 1]) / fair - 1), 0).replace('+', '')} ${z > 0 ? 'above' : 'below'} it (${num(Math.abs(z), 1)} standard deviations).`;
    }
    G.push(mk('gold', 'value', 'Value vs real yields', 1.5, s, r, 'FRED DFII10 + GC=F', gL?.t ?? null));
  }
  {
    const m = sma(gc, 200), d = m && gL ? gL.v / m - 1 : null;
    G.push(mk('gold', 'stretch', 'Stretch vs 200-day average', 1.2, d == null ? null : clamp((0.08 - d) / 0.12), d == null ? 'Needs 200 days of gold history.' : `Gold is ${pct(d)} vs its 200-day average. Past +15–20% it has tended to pause or pull back; near or below the average is where long-term buyers have done best.`, 'GC=F daily', gL?.t ?? null));
  }
  {
    const tr = chg(gold, 365);
    G.push(mk('gold', 'trend', '12-month trend', 1.0, tr == null ? null : clamp(tr / 0.2), tr == null ? 'Needs a year of history.' : `Gold ${pct(tr)} over 12 months. Long-run trends in gold tend to persist for months, so a rising 12-month trend supports holding.`, 'GC=F daily', gL?.t ?? null));
  }
  {
    const d = dlt(tips, 91);
    G.push(mk('gold', 'realyield', 'Real-yield direction', 1.0, d == null ? null : clamp(-d / 0.5), d == null ? 'No real-yield data yet.' : `10Y real yield ${d > 0 ? 'up' : 'down'} ${num(Math.abs(d))} pts in 3 months (now ${num(last(tips)?.v)}%). Falling real yields lower the cost of holding a metal that pays nothing.`, 'FRED DFII10', last(tips)?.t ?? null));
  }
  G.push(mk('gold', 'dollar', 'Dollar direction', 0.7, dxy3 == null ? null : clamp(-dxy3 / 0.05), dxy3 == null ? 'No dollar data yet.' : `Dollar ${pct(dxy3)} in 3 months. Gold is priced in dollars, so a weaker dollar usually lifts it.`, 'Yahoo DX-Y.NYB', last(S.DXY ?? [])?.t ?? null));
  G.push(mk('gold', 'positioning', 'Fund positioning (CFTC)', 1.0, cot ? clamp((0.5 - cot.pct3y / 100) / 0.4) : null,
    cot ? `Managed money is net long ${cot.netPctOI}% of open interest, ${ord(cot.pct3y)} percentile of ${Math.round(cot.weeks / 52)} years${cot.chg4w != null ? ', ' + (cot.chg4w > 0 ? 'adding' : 'cutting') + ' ' + Math.abs(cot.chg4w).toLocaleString('en-US') + ' contracts in 4 weeks' : ''}. Crowded longs leave fewer buyers; washed-out positioning is fuel.` : 'CFTC report loads with the first weekly pull.', 'CFTC COT 088691', cot?.asOf ?? null));
  G.push(mk('gold', 'crowd', 'Crowd mood (your sources)', 0.6,
    crowd && crowd.n >= 8 ? (crowd.bullShare > 0.75 ? -0.7 : crowd.bullShare < 0.3 ? 0.7 : clamp((0.55 - crowd.bullShare) / 0.4) * 0.4) : null,
    crowd && crowd.n >= 8 ? `${Math.round(crowd.bullShare * 100)}% of directional gold stories in 14 days were bullish (${crowd.n} stories, ${crowd.videos} from YouTube). Read as a contrarian gauge: one-sided cheering is a warning, gloom is an opportunity.` : 'Needs at least 8 tagged gold stories from your sources.', 'Your feeds + GDELT', iso(now)));
  G.push(mk('gold', 'insiders', 'Miner insiders (SEC Form 4)', 0.6,
    ins ? (ins.buys >= 3 ? 0.8 : ins.buys >= 1 ? 0.4 : ins.sellUsd > 2e7 ? -0.2 : 0) : null,
    ins ? `${ins.buys} open-market buys ($${(ins.buyUsd / 1e6).toFixed(1)}M) and ${ins.sells} sales ($${(ins.sellUsd / 1e6).toFixed(1)}M) by insiders at NEM, CDE, HL, RGLD, FCX in 90 days. Executives buying their own stock with cash is rare and meaningful; selling is routine.` : 'Set SEC_USER_AGENT to switch on the Form 4 feed.', 'SEC EDGAR Form 4', ins ? iso(now) : null));
  G.push(mk('gold', 'backdrop', 'Economic backdrop', 0.8, clamp((5 - ec.score) / 5) * 0.8,
    `Economy scores ${ec.score}/10 (${phase.toLowerCase()}). Gold has historically done its best work in slowdowns and late-cycle stress.`, 'Economy score above', iso(now)));
  {
    const a = chg(S.GDX ?? [], 91), b = chg(gold, 91), r = a != null && b != null ? (1 + a) / (1 + b) - 1 : null;
    G.push(mk('gold', 'miners', 'Miners vs metal', 0.6, r == null ? null : clamp(r / 0.1), r == null ? 'No miner data yet.' : `Miners (GDX) ${pct(r)} vs gold over 3 months. Miners leading the metal has often confirmed a durable move; lagging warns it's thin.`, 'Yahoo GDX', last(S.GDX ?? [])?.t ?? null));
  }
  const gs = score(G);
  const stretchF = G.find(f => f.key === 'stretch');
  const stance = gs.score >= 6.8 ? (stretchF && stretchF.s != null && stretchF.s < -0.4 ? 'Accumulate on dips' : 'Accumulate') : gs.score >= 4.5 ? 'Hold' : 'Trim or wait';
  const stanceNote = stance.startsWith('Accumulate') ? 'Build a position in stages over weeks rather than all at once.' : stance === 'Hold' ? 'Keep what you have; add only on a meaningful pullback.' : 'The setup is poor: take some profit or wait for better value.';
  // what flips it: the biggest live drags and supports, and the threshold distance
  const live = G.filter(f => f.s != null).sort((a, b) => a.pts - b.pts);
  const flips: string[] = [];
  const W = G.filter(f => f.s != null).reduce((a, f) => a + f.w, 0) || 1;
  const toNext = stance === 'Hold' ? Math.min(6.8 - gs.score, gs.score - 4.5) : stance.startsWith('Accumulate') ? gs.score - 6.8 : 4.5 - gs.score;
  if (live[0] && live[0].pts < 0) flips.push(`Biggest drag: ${live[0].label.toLowerCase()}. If it turns neutral, the score rises about ${(5 * live[0].pts * -1 / W).toFixed(1)} points.`);
  const top = live[live.length - 1];
  if (top && top.pts > 0) flips.push(`Biggest support: ${top.label.toLowerCase()}. If it fades, the score falls about ${(5 * top.pts / W).toFixed(1)} points.`);
  flips.push(`The score is ${Math.abs(toNext).toFixed(1)} points from the next stance change.`);

  // odds: replay the 4 history-backed factors over stored history
  let odds: Outlook['gold']['odds'] = null;
  if (gold.length > 330) {
    const ry: (number | null)[] = [], dx: (number | null)[] = [];
    let jt = 0, jd = 0; const dxs = S.DXY ?? [];
    for (const g of gold) {
      while (jt + 1 < tips.length && tips[jt + 1].t <= g.t) jt++;
      while (jd + 1 < dxs.length && dxs[jd + 1].t <= g.t) jd++;
      ry.push(tips[jt] && tips[jt].t <= g.t ? tips[jt].v : null);
      dx.push(dxs[jd] && dxs[jd].t <= g.t ? dxs[jd].v : null);
    }
    const nowS = goldCore(gc, gc.length - 1, ry, dx);
    if (nowS != null) {
      const fwd: number[] = []; let from = 0, to = 0;
      for (let i = 252; i + 63 < gc.length; i++) {
        const s = goldCore(gc, i, ry, dx);
        if (s == null || Math.abs(s - nowS) > 0.75) continue;
        fwd.push(gc[i + 63] / gc[i] - 1); if (!from) from = gold[i].t; to = gold[i].t;
      }
      if (fwd.length >= 20) {
        const sorted = fwd.slice().sort((a, b) => a - b);
        odds = { n: fwd.length, up: fwd.filter(x => x > 0).length / fwd.length, median: sorted[Math.floor(sorted.length / 2)], from: iso(from), to: iso(to),
          note: `Days since ${iso(from)} whose trend, stretch, real-yield and dollar readings scored within 0.75 of today. Windows overlap, so treat this as a rough guide, not a probability.` };
      }
    }
  }

  /* ================= LONG-RANGE OUTLOOKS (3–6 months) ================= */
  const outlooks: Outlook['outlooks'] = [];
  const verdict = (sig: number[]) => { const net = sig.reduce((a, b) => a + b, 0), n = sig.filter(x => x !== 0).length; return { dir: (net > 0 ? 'up' : net < 0 ? 'down' : 'flat') as 'up' | 'down' | 'flat', conf: !n ? 'No clear signal' : Math.abs(net) === n && n >= 2 ? 'Likely' : Math.abs(net) >= 1 ? 'Leaning' : 'Mixed' }; };
  {
    const why: string[] = [], sig: number[] = [];
    const nq = S.NQH2O ?? [];
    if (nq.length > 200) {
      const m = new Date().getUTCMonth(), ch: number[] = [];
      for (let y = 1; y <= 5; y++) {
        const t0 = Date.UTC(new Date().getUTCFullYear() - y, m, 15), a = at(nq, t0), b = at(nq, t0 + 91 * DAY);
        if (a && b && a.v && b.t > a.t) ch.push(b.v / a.v - 1);
      }
      if (ch.length >= 2) { const avg = ch.reduce((x, y) => x + y) / ch.length; sig.push(avg > 0.03 ? 1 : avg < -0.03 ? -1 : 0); why.push(`Seasonal: over the past ${ch.length} years the California water index moved ${pct(avg, 0)} on average over the next 3 months from this time of year.`); }
      const y1 = chg(nq, 365); if (y1 != null) why.push(`Index ${pct(y1, 0)} vs a year ago, last $${Math.round(last(nq)!.v)}/acre-foot.`);
    }
    const c = drought?.conus;
    if (c && c.prevDrought != null) { const d = c.drought - c.prevDrought; sig.push(d > 1 ? 1 : d < -1 ? -1 : 0); why.push(`${num(c.drought, 1)}% of the lower 48 is in drought, ${d >= 0 ? 'up' : 'down'} ${num(Math.abs(d), 1)} pts on the week. Spreading drought pushes water prices up.`); }
    const v = verdict(sig);
    outlooks.push({ key: 'water', title: 'Water prices (California)', dir: v.dir, conf: v.conf, horizon: '3 months', call: v.dir === 'up' ? 'Leaning higher' : v.dir === 'down' ? 'Leaning lower' : 'Sideways', why: why.length ? why : ['Water history and drought map load with the first pulls.'] });
  }
  {
    const why: string[] = [], sig: number[] = [];
    if (transits != null) { sig.push(transits < -0.05 ? 1 : transits > 0.05 ? -1 : 0); why.push(`Chokepoint traffic ${pct(transits)} vs its 28-day pace. Fewer transits (rerouting, congestion) tighten capacity and lift rates.`); }
    const w = ship?.wci; if (w && w.chgPct != null) { sig.push(w.chgPct > 2 ? 1 : w.chgPct < -2 ? -1 : 0); why.push(`Drewry container index $${Math.round(w.composite).toLocaleString('en-US')} per 40 ft, ${w.chgPct > 0 ? '+' : ''}${w.chgPct}% on the week.`); }
    const b = chg(S.BDRY ?? [], 63); if (b != null) { sig.push(b > 0.08 ? 1 : b < -0.08 ? -1 : 0); why.push(`Dry-bulk freight ${pct(b)} over 3 months.`); }
    const v = verdict(sig);
    outlooks.push({ key: 'shipping', title: 'Freight costs', dir: v.dir, conf: v.conf, horizon: '3–6 months', call: v.dir === 'up' ? 'Leaning higher' : v.dir === 'down' ? 'Leaning lower' : 'Sideways', why: why.length ? why : ['Shipping data loads with the first PortWatch and Drewry pulls.'] });
  }
  {
    const why: string[] = [], sig: number[] = [];
    if (dxy3 != null) { sig.push(dxy3 > 0.02 ? 1 : dxy3 < -0.02 ? -1 : 0); why.push(`Dollar ${pct(dxy3)} over 3 months; trends in the dollar tend to run for quarters.`); }
    const d = dlt(tips, 91); if (d != null) { sig.push(d > 0.15 ? 1 : d < -0.15 ? -1 : 0); why.push(`US real yields ${d > 0 ? 'up' : 'down'} ${num(Math.abs(d))} pts in 3 months; higher real yields pull money into dollars.`); }
    const v = verdict(sig);
    outlooks.push({ key: 'dollar', title: 'US dollar', dir: v.dir, conf: v.conf, horizon: '3–6 months', call: v.dir === 'up' ? 'Leaning stronger' : v.dir === 'down' ? 'Leaning weaker' : 'Range-bound', why: why.length ? why : ['Needs dollar and real-yield history.'] });
  }
  {
    const why: string[] = [], sig: number[] = [];
    const be = dlt(S.BE10Y ?? [], 91); if (be != null) { sig.push(be > 0.1 ? 1 : be < -0.1 ? -1 : 0); why.push(`Bond-market inflation expectation (10Y breakeven) ${be > 0 ? 'up' : 'down'} ${num(Math.abs(be))} pts in 3 months, now ${num(last(S.BE10Y ?? [])?.v)}%.`); }
    const cpi = S.CPI_ALL ?? [];
    if (cpi.length > 16) { const n = cpi.length, y0 = cpi[n - 1].v / cpi[n - 13].v - 1, y3 = cpi[n - 4].v / cpi[n - 16].v - 1; sig.push(y0 - y3 > 0.002 ? 1 : y0 - y3 < -0.002 ? -1 : 0); why.push(`CPI ${pct(y0)} year on year, vs ${pct(y3)} three months earlier.`); }
    const o = chg(S.OIL ?? [], 91); if (o != null) { sig.push(o > 0.1 ? 1 : o < -0.1 ? -1 : 0); why.push(`Oil ${pct(o, 0)} over 3 months feeds into headline inflation with a lag.`); }
    const v = verdict(sig);
    outlooks.push({ key: 'inflation', title: 'US inflation', dir: v.dir, conf: v.conf, horizon: '3–6 months', call: v.dir === 'up' ? 'Leaning hotter' : v.dir === 'down' ? 'Leaning cooler' : 'Steady', why: why.length ? why : ['Needs CPI and breakeven history.'] });
  }

  /* ================= WHAT THE STREET IS MISSING ================= */
  const missing: Outlook['missing'] = [];
  if (cot && (cot.pct3y >= 85 || cot.pct3y <= 15)) missing.push({ title: cot.pct3y >= 85 ? 'Funds are crowded long gold' : 'Funds have abandoned gold', detail: `CFTC managed-money net long sits at the ${ord(cot.pct3y)} percentile of ${Math.round(cot.weeks / 52)} years. Extremes like this have tended to mean-revert over the following months.`, tone: cot.pct3y >= 85 ? 'neg' : 'pos' });
  if (ins && ins.buys >= 2) missing.push({ title: 'Miner executives are buying', detail: `${ins.buys} open-market purchases in 90 days (${ins.buyers.slice(0, 3).join('; ')}).`, tone: 'pos' });
  if (transits != null && transits <= -0.1) missing.push({ title: 'Global shipping is slowing', detail: `Chokepoint transits are ${pct(transits)} vs normal. Disruptions show up in prices and inflation weeks later.`, tone: 'neg' });
  if (cuAu != null && Math.abs(cuAu) >= 0.08) missing.push({ title: cuAu < 0 ? 'Copper is losing to gold' : 'Copper is beating gold', detail: `Copper/gold ratio ${pct(cuAu)} in 3 months: ${cuAu < 0 ? 'industrial demand is fading relative to safety demand' : 'growth demand is reviving'}.`, tone: cuAu < 0 ? 'neg' : 'pos' });
  {
    const c = last(curve); const inv12 = curve.filter(p => p.t >= now - 365 * DAY && p.v < 0).length > 20;
    if (c && c.v >= 0 && inv12) missing.push({ title: 'The yield curve just un-inverted', detail: 'Re-steepening after an inversion came before the 2001, 2008 and 2020 recessions. Most commentary treats it as good news.', tone: 'neg' });
  }
  if (credD > 0.3) missing.push({ title: 'Credit is quietly widening', detail: `Corporate spreads are ${num(credD)} pts wider in 3 months. Credit tends to crack before stocks do.`, tone: 'neg' });
  {
    const sv = S.SILVER ?? [];
    if (sv.length > 200 && gold.length > 200) {
      const r: number[] = []; let j = 0;
      for (const g of gold) { while (j + 1 < sv.length && sv[j + 1].t <= g.t) j++; if (sv[j] && Math.abs(sv[j].t - g.t) < 4 * DAY) r.push(g.v / sv[j].v); }
      if (r.length > 200) { const rk = rank(r, r[r.length - 1]); if (rk >= 0.9 || rk <= 0.1) missing.push({ title: rk >= 0.9 ? 'Silver is unusually cheap vs gold' : 'Silver is unusually rich vs gold', detail: `Gold/silver ratio ${num(r[r.length - 1], 1)}, ${ord(rk * 100)} percentile of the stored history.`, tone: 'neu' }); }
    }
  }
  if (crowd && crowd.n >= 8 && (crowd.bullShare > 0.75 || crowd.bullShare < 0.3)) missing.push({ title: crowd.bullShare > 0.75 ? 'Your feeds are one-sided bullish' : 'Your feeds have turned gloomy on gold', detail: `${Math.round(crowd.bullShare * 100)}% of directional stories bullish over 14 days. Sentiment at extremes is usually late.`, tone: crowd.bullShare > 0.75 ? 'neg' : 'pos' });
  if (drought?.conus?.prevDrought != null && Math.abs(drought.conus.drought - drought.conus.prevDrought) >= 3) missing.push({ title: 'Drought moved sharply this week', detail: `Lower-48 drought ${num(drought.conus.prevDrought, 1)}% → ${num(drought.conus.drought, 1)}%. Watch grain, cattle and water prices.`, tone: 'neu' });

  /* ================= NARRATIVE ================= */
  const g3 = G.filter(f => f.s != null).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)).slice(0, 3);
  let narrative = { text: `The economy reads ${ec.score}/10 (${phase.toLowerCase()}) and gold ${gs.score}/10, so the stance is ${stance.toLowerCase()} for a 3–12 month holder. ` + g3.map((f, i) => (i ? f.label.toLowerCase() : f.label) + (f.pts >= 0 ? ' helps' : ' hurts')).join(', ') + '.', engine: 'template' };
  if (env.AI && env.AI_ENABLED !== 'false') {
    try {
      const facts = [...E, ...G].filter(f => f.s != null).map(f => `- ${f.label}: ${f.reading} (effect ${f.pts >= 0 ? '+' : ''}${f.pts})`).join('\n');
      const out: any = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: 'You write for a long-term investor who holds for 3-12 months and ignores day trading. Use only the facts given. No numbers that are not in the facts. No hype. 3 to 4 plain sentences, under 110 words. Say what matters most and what would change the view.' },
          { role: 'user', content: `Economy score ${ec.score}/10 (${phase}). Gold score ${gs.score}/10, stance: ${stance}.\nFacts:\n${facts}` },
        ], max_tokens: 220,
      });
      const t = String(out?.response ?? '').replace(/\s+/g, ' ').trim();
      if (t.length >= 80 && t.length <= 900) narrative = { text: t, engine: 'Llama 3.1 8B (Workers AI)' };
    } catch (e) { console.error('OUTLOOK_AI_FAIL', String((e as Error).message).slice(0, 100)); }
  }

  const o: Outlook = {
    ts: now, day: iso(now),
    econ: { score: ec.score, phase, factors: E.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)), coverage: ec.coverage },
    gold: { score: gs.score, stance, stanceNote, horizon: '3–12 months', price: gL?.v ?? null, factors: G.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)), coverage: gs.coverage, flips, odds },
    outlooks, missing, narrative,
    ml: mlSnap && typeof mlSnap.p === 'number' ? { p: mlSnap.p, dir: mlSnap.direction ?? (mlSnap.p >= 0.5 ? 'UP' : 'DOWN') } : null,
    inputs: { cot: cot ? 'CFTC ' + cot.asOf : 'unavailable', insiders: ins ? ins.filings + ' Form 4 filings, 90 days' : 'off', crowd: crowd ? crowd.n + ' stories, 14 days' : 'thin', shipping: ship?.chokeAsOf ?? 'unavailable', drought: drought?.mapDate ?? 'unavailable' },
  };
  await env.DB.prepare(
    `INSERT INTO outlook_log (day, ts, econ, gold, stance, gold_px, json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(day) DO UPDATE SET ts = excluded.ts, econ = excluded.econ, gold = excluded.gold, stance = excluded.stance, gold_px = excluded.gold_px, json = excluded.json`
  ).bind(o.day, o.ts, ec.score, gs.score, stance, o.gold.price, JSON.stringify(o)).run();
  return o;
}

/* read side: latest outlook + score history + graded past calls */
export async function readOutlook(env: Env) {
  const [latest, hist] = await Promise.all([
    env.DB.prepare('SELECT json FROM outlook_log ORDER BY day DESC LIMIT 1').first<{ json: string }>(),
    env.DB.prepare('SELECT day, econ, gold, stance, gold_px FROM outlook_log ORDER BY day DESC LIMIT 180').all<{ day: string; econ: number; gold: number; stance: string; gold_px: number | null }>(),
  ]);
  const H = (hist.results ?? []).reverse();
  // grade calls at least 91 days old against the stored gold close 91 days later
  let graded: { stance: string; n: number; up: number; avg: number }[] = [];
  const old = H.filter(h => h.gold_px && Date.parse(h.day) <= Date.now() - 91 * DAY);
  if (old.length) {
    const g = (await readSeries(env, ['GOLD'], Date.parse(old[0].day)))['GOLD'] ?? [];
    const by: Record<string, number[]> = {};
    for (const h of old) { const a = at(g, Date.parse(h.day) + 91 * DAY); if (a && h.gold_px) (by[h.stance] ??= []).push(a.v / h.gold_px - 1); }
    graded = Object.entries(by).map(([stance, r]) => ({ stance, n: r.length, up: r.filter(x => x > 0).length / r.length, avg: r.reduce((a, b) => a + b, 0) / r.length }));
  }
  const firstGrade = H.length ? iso(Date.parse(H[0].day) + 91 * DAY) : null;
  return { outlook: latest ? JSON.parse(latest.json) : null, history: H, graded, firstGrade };
}
