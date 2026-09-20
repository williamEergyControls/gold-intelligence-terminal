/* ================================================================
   PIPELINE — runs in the hourly cron (and via /api/ml/train?key=),
   always try/catch-wrapped so the site can never crash from ML.
   ================================================================ */
import type { Env } from '../types';
import type { DailyInput } from './engine';
import { featuresAt, labelAt, trainLogistic, predictLogistic, trainGBS, predictGBS, regimeHMM, volAnn, FEATURE_NAMES } from './engine';
import { runAgents, consensus, bayesianRounds, evidenceLRs, finalScore } from './agents';
import { fetchJson, secret } from '../providers/provider';

const HORIZON = 5;

async function yahooCloses(sym: string): Promise<{ t: number[]; c: number[] }> {
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2y`);
  const r = j?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0] ?? {};
  const t: number[] = [], c: number[] = [];
  for (let i = 0; i < ts.length; i++) { const v = q.close?.[i]; if (v != null) { t.push(ts[i] * 1000); c.push(v); } }
  if (c.length < 120) throw new Error(`thin series ${sym}`);
  return { t, c };
}
async function fredTail(env: Env, id: string, n = 300): Promise<{ t: number; v: number }[]> {
  const key = secret(env, 'FRED_API_KEY');
  if (!key) throw new Error('FRED_API_KEY not set');
  const j = await fetchJson(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=${n}`);
  return (j?.observations ?? []).filter((o: any) => o.value !== '.').map((o: any) => ({ t: Date.parse(o.date + 'T12:00:00Z'), v: parseFloat(o.value) })).reverse();
}

async function loadInputs(env: Env): Promise<DailyInput & { t: number[] }> {
  const g = await yahooCloses('GC=F');
  const dx = await yahooCloses('DX-Y.NYB');
  const vx = await yahooCloses('^VIX');
  const ol = await yahooCloses('CL=F');
  let ry: { t: number; v: number }[] = [];
  try { ry = await fredTail(env, 'DFII10'); } catch { ry = []; }
  const t = g.t;
  const vix = t.map(tt => { const j = vx.t.findIndex(x => x >= tt); return vx.c[j >= 0 ? j : vx.c.length - 1] ?? 20; });
  const oil = t.map(tt => { const j = ol.t.findIndex(x => x >= tt); return ol.c[j >= 0 ? j : ol.c.length - 1] ?? ol.c[ol.c.length - 1]; });
  const dxy = t.map(tt => { const j = dx.t.findIndex(x => x >= tt); return dx.c[j >= 0 ? j : dx.c.length - 1] ?? dx.c[dx.c.length - 1]; });
  return { t, gold: g.c, dxy, vix, oil, ry };
}

export async function trainAndStore(env: Env): Promise<{ ok: boolean; metrics?: any; error?: string }> {
  try {
    const d = await loadInputs(env);
    let X: number[][] = [], y: number[] = [];
    for (let i = 60; i < d.gold.length; i++) {
      const f = featuresAt(d, d.t, i); const l = labelAt(d, i);
      if (f && l != null) { X.push(f); y.push(l); }
    }
    if (X.length > 420) { X = X.slice(-420); y = y.slice(-420); }
    if (X.length < 150) throw new Error(`only ${X.length} samples`);
    // 70/30 walk-forward with a 5-bar EMBARGO: labels look 5 days ahead, so the
    // last 5 train rows would otherwise leak into the test window
    const cut = Math.floor(X.length * 0.7);
    const trainEnd = Math.max(0, cut - HORIZON);
    const lr70 = trainLogistic(X.slice(0, trainEnd), y.slice(0, trainEnd));
    const gb70 = trainGBS(X.slice(0, trainEnd), y.slice(0, trainEnd));
    let c1 = 0, c2 = 0;
    for (let i = cut; i < X.length; i++) {
      if ((predictLogistic(lr70, X[i]) > 0.5 ? 1 : 0) === y[i]) c1++;
      if ((predictGBS(gb70, X[i]) > 0.5 ? 1 : 0) === y[i]) c2++;
    }
    const wfN = X.length - cut;
    const metrics = { samples: X.length, walkForwardN: wfN, lrAcc: +(c1 / wfN).toFixed(3), gbsAcc: +(c2 / wfN).toFixed(3), trainedAt: Date.now(), features: FEATURE_NAMES };
    const lrFull = trainLogistic(X, y);
    const gbFull = trainGBS(X, y);
    const lrs = evidenceLRs(X, y);
    await env.DB.prepare('UPDATE ml_models SET active=0 WHERE active=1').run(); // keep only the newest active
    await env.DB.prepare('INSERT INTO ml_models(name,trained_at,weights,metrics,active) VALUES(?,?,?,?,1)')
      .bind('v1', Date.now(), JSON.stringify({ lrFull, gbFull, lrs }), JSON.stringify(metrics)).run();
    return { ok: true, metrics };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}

export async function predictAndStore(env: Env): Promise<void> {
  try {
    const row = await env.DB.prepare('SELECT weights,metrics,trained_at FROM ml_models WHERE active=1 ORDER BY id DESC LIMIT 1').first<{ weights: string; metrics: string; trained_at: number }>();
    const d = await loadInputs(env);
    const i = d.gold.length - 1;
    const f = featuresAt(d, d.t, i); if (!f) return;
    const fmap: Record<string, number> = {}; FEATURE_NAMES.forEach((n, k) => fmap[n] = f[k]);
    const obs: number[][] = [];
    const volMean = volAnn(d.gold, 60);
    for (let k = Math.max(60, i - 59); k <= i; k++) {
      const r20 = (d.gold[k] / d.gold[Math.max(0, k - 20)] - 1) * 100;
      const v = volAnn(d.gold.slice(0, k + 1)) / (volMean || 1) - 1;
      let peak = -Infinity; for (let q = Math.max(0, k - 60); q <= k; q++) peak = Math.max(peak, d.gold[q]);
      obs.push([r20, v, (peak - d.gold[k]) / peak * 100]);
    }
    const regime = regimeHMM(obs);
    let mlP: number | null = null;
    if (row) {
      try {
        const W = JSON.parse(row.weights);
        mlP = 0.5 * predictLogistic(W.lrFull, f) + 0.5 * predictGBS(W.gbFull, f);
      } catch { mlP = null; }
    }
    let nb = 3, ne = 3;
    try {
      const cachedN = (await env.CACHE.get('news', 'json')) as any;
      const allN = Array.isArray(cachedN) ? cachedN : (cachedN?.v ?? []); // unwrap envelope
      const gold = (Array.isArray(allN) ? allN : []).filter((n: any) => n?.topic === 'gold') as { sentiment: string }[];
      nb = gold.filter(n => n.sentiment === 'bull').length || 1;
      ne = gold.filter(n => n.sentiment === 'bear').length || 1;
    } catch { /* keep neutral */ }
    // REAL 60-day drawdown for the BEAR/TECHNICAL agents (not a distSMA50 proxy)
    let dd60 = 0;
    { let peak = -Infinity; for (let q = Math.max(0, i - 60); q <= i; q++) peak = Math.max(peak, d.gold[q]); dd60 = peak > 0 ? (peak - d.gold[i]) / peak * 100 : 0; }
    const agents = runAgents({ ...fmap, dd: dd60 }, nb, ne, regime, mlP);
    const p0 = consensus(agents);
    let bayes = { p: p0, rounds: [] as any[] };
    if (row) {
      try {
        const lrs = JSON.parse(row.weights).lrs as { evidence: string; lr: number }[];
        bayes = bayesianRounds(p0, lrs);
      } catch { /* consensus stands */ }
    }
    const acc = await env.DB.prepare('SELECT COUNT(*) n, SUM(correct) c FROM prediction_outcomes').first<{ n: number; c: number }>();
    const liveAcc = { rate: acc?.c && acc.n ? acc.c / acc.n : 0.5, n: acc?.n ?? 0 };
    const fs = finalScore(bayes.p, agents, liveAcc);
    const ts = Date.now();
    const snap = {
      ts, p: +bayes.p.toFixed(3), p0: +p0.toFixed(3), direction: bayes.p >= 0.5 ? 'BULLISH' : 'BEARISH',
      regime, agents, rounds: bayes.rounds, final: fs,
      model: row ? { trainedAt: row.trained_at, metrics: JSON.parse(row.metrics) } : null,
    };
    await env.DB.prepare('INSERT OR REPLACE INTO predictions(ts,horizon_days,p_up,direction,regime,agents) VALUES(?,?,?,?,?,?)')
      .bind(ts, HORIZON, snap.p, snap.direction, regime.state, JSON.stringify(agents.map(a => `${a.name}:${a.p.toFixed(2)}`))).run();
    await env.CACHE.put('ml:snap', JSON.stringify(snap), { expirationTtl: 86400 });
    await persistDailyBars(env, d);
  } catch (e) { console.error('ML_PREDICT_FAIL', String((e as Error).message).slice(0, 300)); }
}

/** Grade predictions whose 5-day horizon has elapsed — real performance measurement. */
export async function gradeOutcomes(env: Env): Promise<void> {
  try {
    const d = await loadInputs(env);
    const old = await env.DB.prepare(
      `SELECT p.ts FROM predictions p LEFT JOIN prediction_outcomes o ON p.ts=o.ts AND p.horizon_days=o.horizon_days
       WHERE o.ts IS NULL AND p.ts < ? LIMIT 20`).bind(Date.now() - (HORIZON + 2) * 864e5).all<{ ts: number }>();
    for (const r of old.results ?? []) {
      const idx = d.t.findIndex(t => t >= r.ts);
      if (idx < 0) continue;
      const base = d.gold[idx];
      const fut = d.gold[Math.min(d.gold.length - 1, idx + HORIZON)];
      if (fut == null) continue;
      const ret5 = (fut / base - 1) * 100;
      const pred = await env.DB.prepare('SELECT p_up FROM predictions WHERE ts=? AND horizon_days=?').bind(r.ts, HORIZON).first<{ p_up: number }>();
      if (!pred) continue;
      const correct = (pred.p_up > 0.5 ? 1 : 0) === (ret5 > 0 ? 1 : 0) ? 1 : 0;
      await env.DB.prepare('INSERT OR REPLACE INTO prediction_outcomes(ts,horizon_days,realized_ret,correct) VALUES(?,?,?,?)')
        .bind(r.ts, HORIZON, +ret5.toFixed(3), correct).run();
    }
  } catch (e) { console.error('ML_GRADE_FAIL', String((e as Error).message).slice(0, 300)); }
}

/** One close/day per symbol into D1 — training-history insurance (idempotent upserts). */
export async function persistDailyBars(env: Env, d: { t: number[]; gold: number[]; dxy: number[]; vix: number[]; oil: number[]; ry: { t: number; v: number }[] }): Promise<void> {
  try {
    if (!d.t.length) return;
    const day = new Date(d.t[d.t.length - 1]).toISOString().slice(0, 10);
    const rows: [string, string, number][] = [
      ['XAU:USD', day, d.gold[d.gold.length - 1]],
      ['DXY', day, d.dxy[d.dxy.length - 1]],
      ['VIX', day, d.vix[d.vix.length - 1]],
      ['CL1', day, d.oil[d.oil.length - 1]],
    ];
    if (d.ry.length) rows.push(['REAL10Y', day, d.ry[d.ry.length - 1].v]);
    for (const [symbol, date, close] of rows) {
      if (!isFinite(close)) continue;
      await env.DB.prepare('INSERT OR REPLACE INTO daily_bars(symbol,date,close) VALUES(?,?,?)').bind(symbol, date, close).run();
    }
  } catch { /* never breaks the cron */ }
}
