import type { AnalyticsResult, Candle, Quote, WhyGold } from '../types';
import { annVolPct, atr, corr, drawdowns, macdHist, norm, rsi, sma, zLast } from './indicators';

// ---- Normalized 0-100 scoring. Documented mapping — no magic, auditable. ----
export function score(candles: Candle[], q: Quote): AnalyticsResult {
  const closes = candles.map(c => c.c);
  const last = closes[closes.length - 1] ?? q.price;
  const s20 = sma(closes, 20).at(-1) ?? null;
  const s50 = sma(closes, 50).at(-1) ?? null;
  const s200 = sma(closes, 200).at(-1) ?? null;
  const r14 = rsi(closes, 14);
  const hist = macdHist(closes);
  const a14 = atr(candles, 14);
  const vol = annVolPct(closes, 20);
  const dd = drawdowns(closes);
  const hi52 = Math.max(...closes.slice(-252), last);
  const volZ = zLast(candles.map(c => c.v ?? 0));
  const ret20 = closes.length > 20 ? (last / closes[closes.length - 21] - 1) * 100 : 0;

  const trend = s50 ? norm((last / s50 - 1) * 100, -5, 5) : 50;
  const momentum = Math.round(0.7 * norm(r14, 25, 75) + 0.3 * (hist > 0 ? 65 : 35));
  const volume = volZ != null ? norm(volZ, -2, 2) : 50;
  const volatilityRisk = norm(vol, 10, 45);
  const drawdownRisk = norm(dd.currentPct, 0, 25);
  const relativeStrength = norm(ret20, -8, 8);
  const composite = Math.round(0.25 * trend + 0.20 * momentum + 0.10 * volume + 0.10 * (100 - volatilityRisk) + 0.10 * (100 - drawdownRisk) + 0.25 * relativeStrength);
  const label = composite >= 75 ? 'STRONG' : composite >= 60 ? 'BULLISH' : composite >= 45 ? 'NEUTRAL' : composite >= 30 ? 'BEARISH' : 'WEAK';

  return {
    symbol: q.symbol, ts: Date.now(), last, source: q.source, delay: q.delay,
    indicators: { sma20: s20, sma50: s50, sma200: s200, rsi14: +r14.toFixed(1), macdHist: +hist.toFixed(3), atr14: +a14.toFixed(2), annVolPct: +vol.toFixed(1), maxDrawdownPct: +dd.maxPct.toFixed(1), currentDrawdownPct: +dd.currentPct.toFixed(1), distTo52wHighPct: +((last / hi52 - 1) * 100).toFixed(1), volumeZ: volZ != null ? +volZ.toFixed(2) : null },
    scores: { trend, momentum, volume, volatilityRisk, drawdownRisk, relativeStrength, composite },
    label,
  };
}

// ---- "Why is gold moving": heuristic attribution, NOT causality (labeled as such in UI). ----
// contribution_k = signed move of driver x assumed sensitivity. Residual = idiosyncratic/news.
export function attribution(inp: {
  goldPct: number; dxyPct: number; realYieldChgBp: number;
  minersPct: number | null; silverPct: number | null; newsCount: number; newsAvg: number;
}): WhyGold {
  const cDxy = -inp.dxyPct * 1.0;              // dollar down → gold up, ~1:1
  const cRy = -inp.realYieldChgBp * 0.25;      // −8bp real yield → ≈ +2pp gold
  const cNews = Math.max(0, (inp.newsCount - inp.newsAvg) / Math.max(1, inp.newsAvg)) * 1.2;
  const cMiners = inp.minersPct != null ? inp.minersPct * 0.3 : 0; // confirming, not driving
  const cSilver = inp.silverPct != null ? inp.silverPct * 0.2 : 0;
  const contributions = [cDxy, cRy, cNews, cMiners, cSilver];
  const total = contributions.reduce((s, v) => s + v, 0);
  const scale = total !== 0 ? Math.abs(inp.goldPct) / Math.abs(total) : 0;
  const pct = (v: number) => Math.max(0, Math.round(Math.abs(v * scale) / Math.max(0.01, Math.abs(inp.goldPct)) * 100));
  const residual = inp.goldPct - total;
  const confidence = Math.max(30, Math.min(95, Math.round(45 + 55 * (1 - Math.min(1, Math.abs(residual) / Math.max(0.5, Math.abs(inp.goldPct)))))));

  const drivers = [
    { name: 'REAL YIELD 10Y', delta: `${inp.realYieldChgBp >= 0 ? '▲' : '▼'} ${sgn(inp.realYieldChgBp)}${inp.realYieldChgBp.toFixed(1)}bp`, dir: (cRy >= 0 ? 1 : -1) as 1 | -1, magnitude: pct(cRy) },
    { name: 'US DOLLAR (DXY)', delta: `${inp.dxyPct >= 0 ? '▲' : '▼'} ${sgn(inp.dxyPct)}${inp.dxyPct.toFixed(2)}%`, dir: (cDxy >= 0 ? 1 : -1) as 1 | -1, magnitude: pct(cDxy) },
    { name: 'MINERS (GDX)', delta: inp.minersPct != null ? `${inp.minersPct >= 0 ? '▲' : '▼'} ${sgn(inp.minersPct)}${inp.minersPct.toFixed(2)}%` : '—', dir: (cMiners >= 0 ? 1 : -1) as 1 | -1, magnitude: pct(cMiners) },
    { name: 'GEOPOL NEWS FLOW', delta: `VOL ${inp.newsCount}/${inp.newsAvg.toFixed(0)}`, dir: (cNews >= 0.3 ? 1 : 0) as 1 | 0, magnitude: pct(cNews) },
    { name: 'SILVER (XAG)', delta: inp.silverPct != null ? `${inp.silverPct >= 0 ? '▲' : '▼'} ${sgn(inp.silverPct)}${inp.silverPct.toFixed(2)}%` : '—', dir: (cSilver >= 0 ? 1 : -1) as 1 | -1, magnitude: pct(cSilver) },
  ].sort((a, b) => b.magnitude - a.magnitude);

  const evidence: string[] = [];
  if (cRy > 0.2) evidence.push(`TIPS 10Y ${sgn(inp.realYieldChgBp)}${inp.realYieldChgBp.toFixed(1)}bp — falling opportunity cost of bullion`);
  if (cDxy > 0.2) evidence.push(`DXY ${sgn(inp.dxyPct)}${inp.dxyPct.toFixed(2)}% — USD headwind removed`);
  if (inp.minersPct != null && Math.abs(inp.minersPct) > 0.5) evidence.push(`GDX ${sgn(inp.minersPct)}${inp.minersPct.toFixed(2)}% — equity beta ${inp.minersPct > 0 ? 'confirms' : 'challenges'}`);
  if (cNews > 0.3) evidence.push(`News volume ${inp.newsCount} vs ${inp.newsAvg.toFixed(0)} avg — event-driven bid`);
  const counter = [
    Math.abs(residual) > 0.4 ? `Residual ${sgn(residual)}${residual.toFixed(2)}pp unexplained by drivers — idiosyncratic flow possible` : 'Moves are largely explained by drivers',
    'Attribution is heuristic (assumed sensitivities), not proven causation',
  ];
  return {
    movePct: inp.goldPct, drivers, evidence, counter, confidence,
    method: 'HEURISTIC ATTRIBUTION · β-assumed · residual-to-confidence', ts: Date.now(),
  };
}
const sgn = (n: number) => (n > 0 ? '+' : '');
export { corr };
