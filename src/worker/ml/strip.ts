/* ================================================================
   ML STRIP — one compact payload rendered as a band on every page.
   inputs (all precomputed, no upstream calls):
     KV ml:snap (gold 5-day model) · D1 prediction_outcomes (live hit rate)
     D1 snapshots vol:* (GARCH, regimes, stress, σ alerts)
   ================================================================ */
import type { Env } from '../types';
import { readSnapshots, type VolRow } from '../vol/snapshot';

const FOCUS: Record<string, string[]> = {
  home: ['GOLD', 'VIX', 'UST10Y', 'DXY'],
  gold: ['GOLD', 'GVZ', 'SILVER', 'TIPS10Y'],
  fx: ['DXY', 'EURUSD', 'USDJPY', 'USDCNY'],
  stable: ['USDT', 'USDC', 'DAI', 'USDE'],
  energy: ['OIL', 'OVX', 'XLE'],
  agri: ['GOLD', 'OIL', 'DXY'],
  vol: ['VIX', 'MOVE', 'GVZ', 'OVX'],
  ai: ['GOLD', 'GVZ', 'DXY', 'TIPS10Y'],
  shipping: ['OIL', 'DXY', 'USDCNY'],
  water: ['GOLD', 'DXY'], land: ['GOLD', 'UST10Y'], search: ['GOLD', 'VIX'],
};
const memo = new Map<string, { ts: number; v: unknown }>();

export async function mlStrip(env: Env, page: string): Promise<unknown> {
  const key = FOCUS[page] ? page : 'home';
  const m = memo.get(key);
  if (m && Date.now() - m.ts < 60000) return m.v;

  const [snap, acc, vol] = await Promise.all([
    env.CACHE.get('ml:snap', 'json').catch(() => null) as Promise<any>,
    env.DB.prepare('SELECT COUNT(*) n, SUM(correct) c FROM prediction_outcomes').first<{ n: number; c: number | null }>().catch(() => null),
    readSnapshots(env).catch(() => ({} as Record<string, { ts: number; v: any }>)),
  ]);
  const rows: VolRow[] = [];
  for (const [k, s] of Object.entries(vol)) if (k !== 'x') rows.push(...((s.v?.rows ?? []) as VolRow[]));
  const byId = new Map(rows.map(r => [r.id, r]));
  const focusIds = FOCUS[key];
  const focus = focusIds.map(id => byId.get(id)).filter((r): r is VolRow => !!r).map(r => ({
    id: r.id, label: r.label, kind: r.kind, last: r.last, chg: r.chg, chgUnit: r.chgUnit,
    rv20: r.rv20 ?? null, volUnit: r.volUnit ?? null, garch20: r.garch?.sig20Ann ?? null,
    pct: r.pct, regime: r.regime, z: r.z, exp5d: r.exp5d ?? null, devBp: (r.extra?.devBp as number | undefined) ?? null,
    source: r.source, lastTs: r.lastTs, stale: r.stale,
  }));
  const x = vol.x?.v;
  const alerts = ((x?.alerts ?? []) as { id: string; label: string; z: number; chg: number | null; chgUnit: string; ts: number | null }[])
    .sort((a, b) => Number(focusIds.includes(b.id)) - Number(focusIds.includes(a.id)) || Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 3);
  const n = acc?.n ?? 0;
  const v = {
    ts: Date.now(), page: key,
    ml: snap?.direction ? {
      model: 'gold 5-day · LR + GBS + HMM + 10 agents', dir: snap.direction, p: snap.p, regime: snap.regime?.state ?? null,
      score: snap.final?.score ?? null, hit: n ? (acc!.c ?? 0) / n : null, graded: n, ts: snap.ts,
    } : null,
    stress: x?.stress ? { score: x.stress.score, regime: x.stress.regime } : null,
    focus, alerts,
    volBuiltAt: Math.max(0, ...Object.values(vol).map(s => s.ts)) || null,
  };
  memo.set(key, { ts: Date.now(), v });
  return v;
}
