/* ================================================================
   LOOP D — steady-state neuroevolution, one child network per minute.
   genome   mask (which inputs), 7 group gates (price, behavior, macro, signals,
            sentiment, regulatory, weather), MLP F→6 tanh→1, mutation step σ (self-adapting)
   target   forward log return over the horizon, in units of its own std (1d=1, 1w=5, 30d=21 trading days)
   INIT     daily (00 UTC): fx_daily → z-scored matrix 'evo:data' (nulls = 0 = "no information")
            first run seeds 24 random genomes per horizon
   POLL     every minute, one horizon in rotation: 2 parents by tournament(3) → crossover →
            mutate → score on today's fixed 200-row sample of the training window
   EVALUATE fitness = skill vs naive (1 − MSE/MSE₀, naive predicts 0) − 0.003 × inputs used
            child replaces the worst genome only if it scores higher
   GATE     daily, 8 genomes per maintenance slot: every genome scored on a validation window and a
            later test window (both after a label-length gap). champion = best on validation; it
            gets a vote in the ledger blend only if validation AND test skill are both ≥ 2%
   ================================================================ */
import type { Env } from '../types';
import { AppCache } from '../cache';
import { FEATS, FEAT_GROUP, GROUP_NAMES } from './features';

export const EVO_H = ['1d', '1w', '30d'] as const;
export type EH = typeof EVO_H[number];
const TGT: Record<EH, 'y1' | 'y5' | 'y21'> = { '1d': 'y1', '1w': 'y5', '30d': 'y21' };
const HID = 6, POP = 24, SAMPLE = 200, GATE_CHUNK = 8;
/* split from the newest labelled row backwards: [ train ] gap k [ validation V ] gap k [ test T ]
   gap k = label length (1/5/21 trading days) so no training label overlaps a scored window.
   the champion is PICKED on validation and must then PASS on test: selection never grades itself. */
const K: Record<EH, number> = { '1d': 1, '1w': 5, '30d': 21 };
const VT: Record<EH, [number, number]> = { '1d': [25, 25], '1w': [30, 30], '30d': [40, 40] };
const F = FEATS.length, G = GROUP_NAMES.length;

export interface Genome { id: number; mask: number[]; g: number[]; w1: number[]; b1: number[]; w2: number[]; b2: number; sg: number; fit: number; sk: number; vk?: number | null; hk: number | null; gen: number; born: number; par: number[] }
interface Pop { h: EH; gen: number; evals: number; accepted: number; nextId: number; day: string; dataBuilt?: number; rq?: number; gate?: { day: string; i: number }; genomes: Genome[] }
export interface Split { nTrain: number; val: [number, number]; test: [number, number] }
export interface EvoData { built: number; days: string[]; mean: number[]; std: number[]; X: number[]; Y: Record<EH, (number | null)[]>; sd: Record<EH, number>; nTrain: Record<EH, number>; split?: Record<EH, Split>; latest: number[]; latestDay: string; coverage: Record<string, number> }

/* ---------- tiny deterministic RNG (xorshift) so a day's sample is reproducible ---------- */
function rng(seed: number) { let x = (seed >>> 0) || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const R = Math.random;
const gauss = (r = R) => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clip = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

function randomGenome(id: number): Genome {
  return {
    id, mask: FEATS.map(() => (R() < 0.5 ? 1 : 0)), g: GROUP_NAMES.map(() => 1),
    w1: Array.from({ length: HID * F }, () => +(gauss() * 0.3).toFixed(4)), b1: Array.from({ length: HID }, () => 0),
    w2: Array.from({ length: HID }, () => +(gauss() * 0.3).toFixed(4)), b2: 0, sg: 0.1, fit: -1, sk: -1, hk: null, gen: 0, born: Date.now(), par: [],
  };
}
export function predict(gn: Genome, x: number[], off = 0): number {
  let out = gn.b2;
  for (let k = 0; k < HID; k++) {
    let z = gn.b1[k]; const base = k * F;
    for (let j = 0; j < F; j++) { if (gn.mask[j]) z += gn.w1[base + j] * gn.g[FEAT_GROUP[j]] * x[off + j]; }
    out += gn.w2[k] * Math.tanh(z);
  }
  return out;
}
function score(gn: Genome, D: EvoData, h: EH, rows: number[]): { skill: number; fit: number } {
  const Y = D.Y[h]; let se = 0, s0 = 0, n = 0;
  for (const i of rows) { const y = Y[i]; if (y == null) continue; const p = predict(gn, D.X, i * F); se += (p - y) ** 2; s0 += y * y; n++; }
  const skill = n && s0 ? 1 - se / s0 : -1;
  const active = gn.mask.reduce((a, b) => a + b, 0);
  return { skill, fit: skill - 0.003 * active };
}
function sampleRows(D: EvoData, h: EH): number[] {
  // fixed for the life of one data build, so every fitness in a population is on the same rows
  const nT = D.nTrain[h], r = rng(Math.floor(D.built / 1000) + h.length * 7919), out: number[] = [];
  if (nT <= SAMPLE) { for (let i = 0; i < nT; i++) out.push(i); return out; }
  const seen = new Set<number>(); while (out.length < SAMPLE) { const i = Math.floor(r() * nT); if (!seen.has(i)) { seen.add(i); out.push(i); } }
  return out;
}

/* ---------- daily: build the z-scored matrix from fx_daily ---------- */
export async function buildEvoData(env: Env): Promise<{ rows: number; train: Record<EH, number> } | null> {
  // last ~6 years is plenty and keeps the matrix ≈ 250 KB (parsed once per isolate)
  const rs = ((await env.DB.prepare(`SELECT day, ${FEATS.join(',')}, y1, y5, y21 FROM fx_daily ORDER BY day DESC LIMIT 1500`).all<any>()).results ?? []).reverse();
  if (rs.length < 120) return null;
  const mean: number[] = [], std: number[] = [], coverage: Record<string, number> = {};
  FEATS.forEach((f, j) => {
    const v = rs.map(r => r[f]).filter((x: any) => x != null && isFinite(x)) as number[];
    const m = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
    const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) : 1;
    mean[j] = +m.toFixed(5); std[j] = +(sd || 1).toFixed(5);
    coverage[f] = +(v.length / rs.length).toFixed(3);
  });
  const X: number[] = [];
  for (const r of rs) for (let j = 0; j < F; j++) { const x = r[FEATS[j]]; X.push(x == null || !isFinite(x) ? 0 : +clip((x - mean[j]) / std[j], -4, 4).toFixed(1)); }
  const Y = {} as EvoData['Y'], sd = {} as EvoData['sd'], nTrain = {} as EvoData['nTrain'], split = {} as Record<EH, Split>;
  for (const h of EVO_H) {
    const raw = rs.map(r => r[TGT[h]] as number | null);
    const known = raw.filter(x => x != null) as number[];
    const s = known.length > 10 ? Math.sqrt(known.reduce((a, b) => a + b * b, 0) / known.length) : 1;
    sd[h] = +s.toFixed(4);
    Y[h] = raw.map(x => (x == null ? null : +(x / s).toFixed(3)));
    const L = raw.reduce((a: number, x, i) => (x != null ? i : a), -1), k = K[h], [V, T] = VT[h];
    const test: [number, number] = [L - T + 1, L], val: [number, number] = [L - T - k - V + 1, L - T - k];
    nTrain[h] = Math.max(0, val[0] - k);
    split[h] = { nTrain: nTrain[h], val, test };
  }
  const last = rs[rs.length - 1];
  const latest = FEATS.map((f, j) => { const x = last[f]; return x == null || !isFinite(x) ? 0 : +clip((x - mean[j]) / std[j], -4, 4).toFixed(2); });
  const D: EvoData = { built: Date.now(), days: rs.map(r => r.day), mean, std, X, Y, sd, nTrain, split, latest, latestDay: last.day, coverage };
  await new AppCache(env).write('evo:data', D, 3 * 86400);
  return { rows: rs.length, train: nTrain };
}

/* ---------- every minute: one child for one horizon ---------- */
export async function evoStep(env: Env, minute: number): Promise<{ h: EH; accepted: boolean; fit?: number } | null> {
  const cache = new AppCache(env);
  const D = (await cache.read<EvoData>('evo:data'))?.v;
  if (!D || D.X.length !== D.days.length * F) return null;   // features table changed shape: wait for the nightly rebuild
  const h = EVO_H[Math.floor(minute / 60e3) % EVO_H.length];
  if (D.nTrain[h] < 60) return null;
  const key = 'evo:pop:' + h, today = new Date(minute).toISOString().slice(0, 10);
  let P = (await cache.read<Pop>(key))?.v;
  const rows = sampleRows(D, h);
  if (!P || !P.genomes?.length || P.genomes[0].mask.length !== F) {
    P = { h, gen: 0, evals: 0, accepted: 0, nextId: POP + 1, day: today, dataBuilt: D.built, rq: 0, genomes: Array.from({ length: POP }, (_, i) => randomGenome(i + 1)) };
  }
  // new data build → re-score the population in chunks of 6 (one chunk per step, no breeding meanwhile)
  // so a child is never compared with fitness measured on different rows
  if (P.dataBuilt !== D.built) { P.dataBuilt = D.built; P.rq = 0; }
  if ((P.rq ?? POP) < POP) {
    const end = Math.min(POP, (P.rq ?? 0) + 6);
    for (let i = P.rq ?? 0; i < end; i++) { const gn = P.genomes[i]; const sc = score(gn, D, h, rows); gn.sk = sc.skill; gn.fit = sc.fit; }
    P.rq = end; P.day = today;
    await cache.write(key, P, 30 * 86400);
    return { h, accepted: false };
  }
  const pick = () => { let b: Genome | null = null; for (let k = 0; k < 3; k++) { const c = P!.genomes[Math.floor(R() * P!.genomes.length)]; if (!b || c.fit > b.fit) b = c; } return b!; };
  const a = pick(), b = pick();
  const mix = (x: number[], y: number[]) => x.map((v, i) => (R() < 0.5 ? v : y[i]));
  const sg = clip(((a.sg + b.sg) / 2) * Math.exp(0.2 * gauss()), 0.01, 0.5);
  const mut = (v: number, p: number) => (R() < p ? +(v + gauss() * sg).toFixed(4) : v);
  const child: Genome = {
    id: P.nextId++, mask: mix(a.mask, b.mask), g: mix(a.g, b.g).map(v => (R() < 0.3 ? +clip(v + gauss() * 0.1, 0, 1.5).toFixed(3) : v)),
    w1: mix(a.w1, b.w1).map(v => mut(v, 0.15)), b1: mix(a.b1, b.b1).map(v => mut(v, 0.3)), w2: mix(a.w2, b.w2).map(v => mut(v, 0.3)),
    b2: R() < 0.3 ? +(((a.b2 + b.b2) / 2) + gauss() * sg * 0.3).toFixed(4) : a.b2,
    sg: +sg.toFixed(4), fit: -1, sk: -1, hk: null, gen: P.gen + 1, born: Date.now(), par: [a.id, b.id],
  };
  if (R() < 0.15) { const j = Math.floor(R() * F); child.mask[j] = child.mask[j] ? 0 : 1; }
  const s = score(child, D, h, rows); child.sk = s.skill; child.fit = s.fit;
  let wi = 0; P.genomes.forEach((gn, i) => { if (gn.fit < P!.genomes[wi].fit) wi = i; });
  P.evals++; P.gen++;
  const accepted = child.fit > P.genomes[wi].fit;
  if (accepted) { P.genomes[wi] = child; P.accepted++; }
  // write on acceptance, and every 10th step so the counters stay current (≤ ~500 D1 writes/day)
  if (accepted || P.evals % 10 === 0) await cache.write(key, P, 30 * 86400);
  return { h, accepted, fit: child.fit };
}

/* ---------- daily gate: 8 genomes per maintenance slot, then the verdict ---------- */
export interface Champ { h: EH; genome: Genome; hk: number; vk?: number; fit: number; at: number; promoted: boolean; nHold: number }
export async function evoGate(env: Env, h: EH): Promise<{ done: boolean; champ: Champ | null; progress: string }> {
  const cache = new AppCache(env);
  const D = (await cache.read<EvoData>('evo:data'))?.v;
  const P = (await cache.read<Pop>('evo:pop:' + h))?.v;
  if (!D || !D.split || !P || !P.genomes.length || P.genomes[0].mask.length !== F) return { done: true, champ: null, progress: 'no population yet' };
  const sp = D.split[h], today = new Date().toISOString().slice(0, 10);
  const range = (a: number, b: number) => { const o: number[] = []; for (let i = Math.max(0, a); i <= b; i++) if (D.Y[h][i] != null) o.push(i); return o; };
  const val = range(sp.val[0], sp.val[1]), test = range(sp.test[0], sp.test[1]);
  if (val.length < 15 || test.length < 15) return { done: true, champ: null, progress: 'not enough labelled days for validation + test' };
  if (!P.gate || P.gate.day !== today) P.gate = { day: today, i: 0 };
  const end = Math.min(P.genomes.length, P.gate.i + GATE_CHUNK);
  for (let i = P.gate.i; i < end; i++) { const gn = P.genomes[i]; gn.vk = +score(gn, D, h, val).skill.toFixed(4); gn.hk = +score(gn, D, h, test).skill.toFixed(4); }
  P.gate.i = end;
  await cache.write('evo:pop:' + h, P, 30 * 86400);
  if (end < P.genomes.length) return { done: false, champ: null, progress: end + ' of ' + P.genomes.length + ' scored' };
  // pick on validation, promote only if the pick also clears 2% on the untouched test window
  const best = P.genomes.filter(g => g.vk != null).sort((x, y) => (y.vk as number) - (x.vk as number))[0];
  const champs = (await cache.read<Record<string, Champ>>('evo:champ'))?.v ?? {};
  const ch: Champ | null = best ? { h, genome: best, vk: best.vk as number, hk: best.hk as number, fit: best.fit, at: Date.now(), promoted: (best.vk as number) >= 0.02 && (best.hk as number) >= 0.02, nHold: test.length } : null;
  if (ch) champs[h] = ch; else delete champs[h];
  await cache.write('evo:champ', champs, 30 * 86400);
  const fits = P.genomes.map(g => g.fit).sort((x, y) => x - y);
  const gates = GROUP_NAMES.map((_, k) => +(P!.genomes.reduce((a, g) => a + g.g[k] * (g.mask.some((m, j) => m && FEAT_GROUP[j] === k) ? 1 : 0), 0) / P!.genomes.length).toFixed(3));
  const use = FEATS.map((_, j) => +(P!.genomes.reduce((a, g) => a + g.mask[j], 0) / P!.genomes.length).toFixed(2));
  await env.DB.prepare(
    `INSERT INTO evo_log (day, h, gen, evals, accepted, best_fit, med_fit, champ_hk, promoted, gates, feat_use) VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(day, h) DO UPDATE SET gen=excluded.gen, evals=excluded.evals, accepted=excluded.accepted, best_fit=excluded.best_fit, med_fit=excluded.med_fit,
       champ_hk=excluded.champ_hk, promoted=excluded.promoted, gates=excluded.gates, feat_use=excluded.feat_use`
  ).bind(today, h, P.gen, P.evals, P.accepted, fits[fits.length - 1], fits[Math.floor(fits.length / 2)], ch?.hk ?? null, ch?.promoted ? 1 : 0, JSON.stringify(gates), JSON.stringify(use)).run();
  return { done: true, champ: ch, progress: 'complete' };
}

/** champion forecast for the ledger: expected log-return % over the horizon, or null */
export function champReturn(ch: Champ | undefined, D: EvoData | null, h: EH): number | null {
  if (!ch || !ch.promoted || !D || ch.genome.mask.length !== F) return null;
  return predict(ch.genome, D.latest, 0) * D.sd[h];
}

export async function evoSummary(env: Env) {
  const cache = new AppCache(env);
  const [D, champs, log] = await Promise.all([
    cache.read<EvoData>('evo:data'), cache.read<Record<string, Champ>>('evo:champ'),
    env.DB.prepare('SELECT day, h, gen, evals, accepted, best_fit, med_fit, champ_hk, promoted, gates, feat_use FROM evo_log ORDER BY day DESC LIMIT 270').all<any>().then(r => r.results ?? []).catch(() => []),
  ]);
  const pops: Record<string, any> = {};
  for (const h of EVO_H) {
    const P = (await cache.read<Pop>('evo:pop:' + h))?.v;
    pops[h] = P ? {
      gen: P.gen, evals: P.evals, accepted: P.accepted, size: P.genomes.length,
      genomes: P.genomes.slice().sort((a, b) => b.fit - a.fit).map(g => ({ id: g.id, fit: +g.fit.toFixed(4), sk: +g.sk.toFixed(4), vk: g.vk ?? null, hk: g.hk, inputs: g.mask.reduce((a, b) => a + b, 0), sg: g.sg, gen: g.gen, age: Date.now() - g.born, par: g.par, g: g.g, mask: g.mask })),
    } : null;
  }
  const ch = champs?.v ?? {};
  return {
    feats: FEATS, groups: GROUP_NAMES, featGroup: FEAT_GROUP,
    data: D?.v ? { built: D.v.built, rows: D.v.days.length, from: D.v.days[0], to: D.v.latestDay, train: D.v.nTrain, coverage: D.v.coverage, sd: D.v.sd } : null,
    pops, champs: Object.fromEntries(Object.entries(ch).map(([h, c]) => [h, { hk: c.hk, vk: c.vk ?? null, fit: c.fit, promoted: c.promoted, at: c.at, nHold: c.nHold, inputs: c.genome.mask.reduce((a, b) => a + b, 0), gates: c.genome.g, mask: c.genome.mask, id: c.genome.id }])),
    log: log.reverse().map((r: any) => ({ ...r, gates: JSON.parse(r.gates || '[]'), feat_use: JSON.parse(r.feat_use || '[]') })),
  };
}
