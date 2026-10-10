/* ================================================================
   CHART BUILDER (Pro) — any warehouse series, saved per user, shareable by link
   INIT     /api/charts/series: the catalog (series_meta, 1 query, isolate memo)
   POLL     /api/charts/data?ids=A,B&days=N → each series from a shared D1 cache row per
            (series, span bucket), refreshed every 6 h → a chart load reads ≤ 6 cache rows,
            not thousands of points (keeps the Free 5M rows/day read budget safe)
   SAVE     user_charts: name + spec (validated, ≤ 2 KB) + random share token; 50 per user
   ================================================================ */
import type { Env } from './types';
import { AppCache } from './cache';
import { readSeries } from './store/ingest';
import { SERIES } from './store/registry';

const BUCKETS = [370, 740, 1840, 3660];
export const TRANSFORMS = ['level', 'index', 'z', 'pct', 'corr'] as const;
export const RANGES: Record<string, number> = { '3m': 92, '6m': 183, '1y': 366, '2y': 731, '5y': 1827, '10y': 3653 };

export async function chartCatalog(env: Env) {
  const r = await env.DB.prepare('SELECT id, points, first_ts, last_ts, last_v FROM series_meta WHERE points > 10').all<{ id: string; points: number; first_ts: number; last_ts: number; last_v: number }>();
  const have = new Map((r.results ?? []).map(x => [x.id, x]));
  return {
    series: Object.values(SERIES).filter(s => have.has(s.id)).map(s => {
      const m = have.get(s.id)!;
      return { id: s.id, label: s.label, cls: s.cls, kind: s.kind, unit: s.unit, freq: s.freq, points: m.points, first: m.first_ts, last: m.last_ts, lastV: m.last_v };
    }).sort((a, b) => a.cls.localeCompare(b.cls) || a.label.localeCompare(b.label)),
    transforms: TRANSFORMS, ranges: Object.keys(RANGES),
  };
}

export async function chartData(env: Env, ids: string[], days: number) {
  const b = BUCKETS.find(x => x >= days) ?? BUCKETS[BUCKETS.length - 1];
  const c = new AppCache(env);
  const since = Date.now() - days * 864e5;
  const out: Record<string, [number, number][]> = {};
  await Promise.all(ids.map(async id => {
    const r = await c.wrap('chs:' + id + ':' + b, 21600, async () => {
      const pts = (await readSeries(env, [id], Date.now() - b * 864e5))[id] ?? [];
      return pts.map(p => [p.t, +p.v.toPrecision(7)] as [number, number]);
    });
    out[id] = r.v.filter(p => p[0] >= since);
  }));
  return { ids, days, data: out, meta: Object.fromEntries(ids.map(id => [id, { label: SERIES[id].label, unit: SERIES[id].unit, kind: SERIES[id].kind, freq: SERIES[id].freq }])) };
}

export interface ChartSpec { series: { id: string; color?: string }[]; transform: typeof TRANSFORMS[number]; range: string; win?: number }
export function validSpec(x: any): ChartSpec | null {
  if (!x || typeof x !== 'object' || !Array.isArray(x.series)) return null;
  const series = x.series.slice(0, 6).map((s: any) => ({ id: String(s?.id ?? '').toUpperCase(), color: /^#[0-9a-f]{6}$/i.test(String(s?.color)) ? String(s.color) : undefined }))
    .filter((s: any) => SERIES[s.id]);
  if (!series.length) return null;
  const transform = (TRANSFORMS as readonly string[]).includes(x.transform) ? x.transform : 'index';
  const range = RANGES[x.range] ? x.range : '1y';
  const win = Math.max(10, Math.min(250, Math.round(Number(x.win) || 60)));
  return { series, transform, range, win };
}

function token(): string { const b = new Uint8Array(9); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }

export async function listCharts(env: Env, uid: number) {
  const r = await env.DB.prepare('SELECT id, name, spec, share, updated FROM user_charts WHERE user_id=? ORDER BY updated DESC LIMIT 50').bind(uid).all<{ id: number; name: string; spec: string; share: string; updated: number }>();
  return { charts: (r.results ?? []).map(c => ({ ...c, spec: JSON.parse(c.spec) })) };
}
export async function saveChart(env: Env, uid: number, b: any): Promise<{ ok: boolean; id?: number; share?: string; error?: string }> {
  const spec = validSpec(b?.spec);
  if (!spec) return { ok: false, error: 'Pick at least one series' };
  const name = String(b?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || spec.series.map(s => s.id).join(' vs ');
  const js = JSON.stringify(spec);
  if (js.length > 2000) return { ok: false, error: 'Chart is too large' };
  const now = Date.now();
  if (b?.id) {
    const r = await env.DB.prepare('UPDATE user_charts SET name=?, spec=?, updated=? WHERE id=? AND user_id=?').bind(name, js, now, Number(b.id), uid).run();
    if (!(r.meta?.changes ?? 0)) return { ok: false, error: 'Chart not found' };
    const row = await env.DB.prepare('SELECT share FROM user_charts WHERE id=?').bind(Number(b.id)).first<{ share: string }>();
    return { ok: true, id: Number(b.id), share: row?.share };
  }
  const n = await env.DB.prepare('SELECT COUNT(*) n FROM user_charts WHERE user_id=?').bind(uid).first<{ n: number }>();
  if ((n?.n ?? 0) >= 50) return { ok: false, error: 'You have 50 saved charts. Delete one first.' };
  const share = token();
  const r = await env.DB.prepare('INSERT INTO user_charts (user_id, name, spec, share, created, updated) VALUES (?,?,?,?,?,?)').bind(uid, name, js, share, now, now).run();
  return { ok: true, id: Number(r.meta?.last_row_id ?? 0), share };
}
export async function deleteChart(env: Env, uid: number, id: number) {
  const r = await env.DB.prepare('DELETE FROM user_charts WHERE id=? AND user_id=?').bind(id, uid).run();
  return { ok: (r.meta?.changes ?? 0) > 0 };
}
export async function sharedChart(env: Env, share: string) {
  if (!/^[0-9a-f]{18}$/.test(share)) return null;
  // the owner's login name is never returned: it is half of their credentials
  const r = await env.DB.prepare('SELECT name, spec FROM user_charts WHERE share=?').bind(share).first<{ name: string; spec: string }>();
  return r ? { name: r.name, spec: JSON.parse(r.spec) } : null;
}
