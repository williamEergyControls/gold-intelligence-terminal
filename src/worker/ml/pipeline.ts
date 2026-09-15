/* ================================================================
   PIPELINE — runs ONLY in the cron, try/catch-wrapped so the site
   can never crash from ML. Requests read the KV snapshot: cheap.
   ================================================================ */
import type { Env } from '../types';
import { featuresAt, labelAt, trainLogistic, predictLogistic, trainGBS, predictGBS, regimeHMM, volAnn, FEATURE_NAMES, DailyInput } from './engine';
import { runAgents, consensus, bayesianRounds, evidenceLRs, finalScore } from './agents';
import { fetchJson } from '../providers/provider';

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
  if (!env.FRED_API_KEY) throw new Error('FRED_API_KEY not set');
  const j = await fetchJson(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${env.FRED_API_KEY}&file_type=json&sort_order=desc&limit=${n}`);
  return (j?.observations ?? []).filter((o: any) => o.value !== '.').map((o: any) => ({ t: Date.parse(o.date + 'T12:00:00Z'), v: parseFloat(o.value) })).reverse();
}

async function loadInputs(env: Env): Promise<DailyInput & { t: number[] }> {
  const [g, dx, vx, ol] = await Promise.all([
    yahooCloses('GC=F'), yahooCloses('DX-Y.NYB'), yahooCloses('^VIX'), yahooCloses('CL=F'),
  ]);
  let ry: { t: number; v: number }[] = [];
  try { ry = await fredTail(env, 'DFII10'); } catch { ry = []; }
  const t = g.t;
  const vix = t.map((tt, i) => { void i; const j = vx.t.findIndex(x => x >= tt); return vx.c[j >= 0 ? j : vx.c.length - 1] ?? 20; });
  const oil = t.map(tt => { const j = ol.t.findIndex(x => x >= tt); return ol.c[j >= 0 ? j : ol.c.length - 1] ?? ol.c[ol.c.length - 1]; });
  const dxy = t.map(tt => { const j = dx.t.findIndex(x => x >= tt); return dx.c[j >= 0 ? j : dx.c.length - 1] ?? dx.c[dx.c.length - 1]; });
  return { t, gold: g.c, dxy, vix, oil, ry };
}

export async function trainAndStore(env: Env): Promise<{ ok: boolean; metrics?: any; error?: string }> {
  try {
    const d = await loadInputs(env);
    const X: number[][] = [], y: number[] = [];
    for (let i = 60; i < d.gold.length;  i++) {
      const f = featuresAt(d, d.t, i); const l = labelAt(d, i);
      if (f && l != null) { X.push(f); y.push(l); }
    }
    if (X.length < 150) throw new Error(`only ${X.length} samples`);
    // chronological 70/30 walk-forward
    const cut = Math.floor(X.length * 0.7);
    const lr70 = trainLogistic(X.slice(0, cut), y.slice(0, cut));
    const gb70 = trainGBS(X.slice(0, cut), y.slice(0, cut));
    let c1 = 0, c2 = 0;
    for (let i = cut; i < X.length; i++) {
      if ((predictLogistic(lr70, X[i]) > 0.5 ? 1 : 0) === y[i]) c1++;
      if ((predictGBS(gb70, X[i]) > 0.5 ? 1 : 0) === y[i]) c2++;
    }
    const wfN = X.length - cut;
    const metrics = {
      samples: X.length, walkForwardN: wfN,
      lrAcc: +(c1 / wfN).toFixed(3), gbsAcc: +(c2 / wfN).toFixed(3),
      trainedAt: Date.now(), features: FEATURE_NAMES,
    };
    // full-train final models + evidence LRs for live use
    const lrFull = trainLogistic(X, y);
    const gbFull = trainGBS(X, y);
    const lrs = evidenceLRs(X, y);
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
    // regime observations for HMM (last 60 days)
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
    // news sentiment from the cached news blob
    let nb = 3, ne = 3;
    try {
      const news = (await env.CACHE.get('news', 'json')) as any;
      const gold = (news?.gold ?? []) as { sentiment: string }[];
      nb = gold.filter(n => n.sentiment === 'bull').length || 1;
      ne = gold.filter(n => n.sentiment === 'bear').length || 1;
    } catch { /* keep neutral */ }
    const agents = runAgents({ ...fmap, dd: (fmap.distSMA50 < 0 ? -fmap.distSMA50 * 2 : 0) }, nb, ne, regime, mlP);
    const p0 = consensus(agents);
    let bayes = { p: p0, rounds: [] as any[] };
    if (row) {
      try {
        const lrs = JSON.parse(row.weights).lrs as { evidence: string; lr: number }[];
        bayes = bayesianRounds(p0, lrs);
      } catch { /* consensus stands */ }
    }
    // live accuracy from graded outcomes
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
  } catch { /* never break the cron */ }
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
      const base = d.gold[idx >= 0 ? idx : d.gold.length - 1];
      const fut = d.gold[Math.min(d.gold.length - 1, (idx >= 0 ? idx : d.gold.length - 1) + HORIZON)];
      if (idx < 0 || fut == null) continue;
      const ret5 = (fut / base - 1) * 100;
      const pred = await env.DB.prepare('SELECT p_up FROM predictions WHERE ts=? AND horizon_days=?').bind(r.ts, HORIZON).first<{ p_up: number }>();
      if (!pred) continue;
      const correct = (pred.p_up > 0.5 ? 1 : 0) === (ret5 > 0 ? 1 : 0) ? 1 : 0;
      await env.DB.prepare('INSERT OR REPLACE INTO prediction_outcomes(ts,horizon_days,realized_ret,correct) VALUES(?,?,?,?)')
        .bind(r.ts, HORIZON, +ret5.toFixed(3), correct).run();
    }
  } catch { /* never break the cron */ }
}
