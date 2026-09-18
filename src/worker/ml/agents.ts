/* ================================================================
   10 DETERMINISTIC AGENTS + BAYESIAN ROUNDS + CONSENSUS.
   No Llama votes here — Llama only interprets the output.
   Every p(up) is a documented mapping of a REAL computed number.
   ================================================================ */
import { sigmoid } from './engine';
import type { RegimeResult } from './engine';

export interface AgentOut { name: string; p: number; note: string }

export function runAgents(f: Record<string, number>, newsBull: number, newsBear: number, regime: RegimeResult, mlP: number | null): AgentOut[] {
  const S = (x: number) => Math.max(0.02, Math.min(0.98, x));
  const distSMA50 = f.distSMA50 ?? 0, rsi14 = f.rsi14 ?? 0.5, macdN = f.macdN ?? 0;
  const ryChg5 = f.ryChg5 ?? 0, ryLvl = f.ryLvl ?? 1.5, dxyR20 = f.dxyR20 ?? 0;
  const vix = f.vix ?? 20, dd = f.dd ?? 0;
  return [
    { name: 'TREND',      p: S(sigmoid(2.5 * distSMA50 + 0.8)), note: `dist SMA50 ${distSMA50.toFixed(1)}%` },
    { name: 'MOMENTUM',   p: S(0.5 + rsi14 * 0.36 + Math.sign(macdN) * 0.06), note: `RSI ${(rsi14 * 100).toFixed(0)} MACD ${macdN >= 0 ? '+' : ''}${macdN.toFixed(2)}` },
    { name: 'MACRO',      p: S(sigmoid(-1.8 * ryChg5 - 0.5 * ryLvl + 2)), note: `RY ${ryLvl.toFixed(2)}% Δ5d ${ryChg5 >= 0 ? '+' : ''}${ryChg5.toFixed(2)}` },
    { name: 'DOLLAR',     p: S(sigmoid(-1.1 * dxyR20)), note: `DXY 20d ${dxyR20 >= 0 ? '+' : ''}${dxyR20.toFixed(1)}%` },
    { name: 'VOLATILITY', p: S(sigmoid(0.9 * (vix - 18) / 8)), note: `VIX ${vix.toFixed(1)} — risk-off bid if elevated` },
    { name: 'REGIME',     p: S(regime.probs[0] + 0.5 * regime.probs[1]), note: `HMM ${regime.state} ${(Math.max(...regime.probs) * 100).toFixed(0)}%` },
    { name: 'TECHNICAL',  p: S(sigmoid(-0.10 * dd + 0.3)), note: `drawdown ${dd.toFixed(1)}%` },
    { name: 'NEWS',       p: S(0.5 + 0.2 * Math.tanh((newsBull - newsBear) / Math.max(3, newsBull + newsBear))), note: `GDELT bull/bear ${newsBull}/${newsBear}` },
    { name: 'QUANT',      p: S(mlP ?? 0.5), note: mlP == null ? 'models unavailable' : 'LR+GBS ensemble' },
    { name: 'BEAR',       p: S(1 - Math.max(1 - distSMA50 / 5, dd / 20, ryChg5 / 0.25, 0.5)), note: 'adversarial worst-case reading' },
  ];
}

/* Weighted consensus — weights = designed reliability priors */
const W: Record<string, number> = { TREND: .1, MOMENTUM: .1, MACRO: .15, DOLLAR: .15, VOLATILITY: .05, REGIME: .15, TECHNICAL: .05, NEWS: .05, QUANT: .15, BEAR: .05 };
export function consensus(agents: AgentOut[]): number {
  const s = agents.reduce((acc, a) => acc + (W[a.name] ?? .05) * a.p, 0);
  const t = agents.reduce((acc, a) => acc + (W[a.name] ?? .05), 0);
  return s / (t || 1);
}

/* ---------- BAYESIAN ROUNDS ----------
   posterior odds = prior odds * LR. P may DECREASE. Max 10 rounds. */
export interface BayesRound { round: number; evidence: string; lr: number; pAfter: number }
export function bayesianRounds(p0: number, lrs: { evidence: string; lr: number }[]): { p: number; rounds: BayesRound[] } {
  let p = Math.max(0.02, Math.min(0.98, p0));
  const rounds: BayesRound[] = [];
  for (let k = 0; k < Math.min(10, lrs.length); k++) {
    const odds = (p / (1 - p)) * lrs[k].lr;
    p = Math.max(0.02, Math.min(0.98, odds / (1 + odds)));
    rounds.push({ round: k + 1, evidence: lrs[k].evidence, lr: +lrs[k].lr.toFixed(2), pAfter: +p.toFixed(3) });
  }
  return { p, rounds };
}

/** Historical likelihood ratios from the training matrix — data-driven, not invented. */
export function evidenceLRs(X: number[][], y: number[]): { evidence: string; lr: number }[] {
  const checks: { evidence: string; test: (f: number[]) => boolean }[] = [
    { evidence: 'r20 > 0 (uptrend)', test: f => f[1] > 0 },
    { evidence: 'RSI > 55', test: f => f[3] > 0.55 },
    { evidence: 'real yield 5d fall', test: f => f[9] < 0 },
    { evidence: 'DXY 20d fall', test: f => f[7] < 0 },
    { evidence: 'VIX > 20', test: f => f[10] > 20 },
    { evidence: 'above SMA50', test: f => f[6] > 0 },
    { evidence: 'oil 20d up', test: f => f[11] > 0 },
    { evidence: 'vol < 15% ann', test: f => f[5] < 0.15 },
    { evidence: 'RSI < 45 (weak)', test: f => f[3] < 0.45 },
    { evidence: 'real yield > 2%', test: f => f[8] > 2 },
  ];
  return checks.map(c => {
    let up = 0, dn = 0, upN = 0, dnN = 0;
    for (let i = 0; i < X.length; i++) {
      if (c.test(X[i])) { if (y[i] === 1) up++; else dn++; }
      if (y[i] === 1) upN++; else dnN++;
    }
    const pEup = (up + 1) / (upN + 2), pEdn = (dn + 1) / (dnN + 2);
    return { evidence: c.evidence, lr: pEup / pEdn };
  });
}

export function finalScore(p: number, agents: AgentOut[], liveAcc: { rate: number; n: number }) {
  const dir = p >= 0.5 ? 1 : -1;
  const agreeing = agents.filter(a => dir === 1 ? a.p > 0.5 : a.p < 0.5).length;
  const agreement = agreeing / agents.length;
  const acc = liveAcc.n >= 30 ? liveAcc.rate : 0.5; // honest cold start
  const score = 0.50 * p + 0.25 * agreement + 0.25 * acc;
  return { score, agreement, agreeing, accStatus: liveAcc.n >= 30 ? `${(liveAcc.rate * 100).toFixed(0)}% (${liveAcc.n} graded)` : `PENDING (${liveAcc.n}/30 graded)` };
}
