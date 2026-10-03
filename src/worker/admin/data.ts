/* ================================================================
   ADMIN · DATA SOURCES FOR THE ADMIN CONSOLE (read-mostly)
   every query is bounded (LIMIT / time window) so the console can
   never turn into a full-table scan on a growing DB.
   ================================================================ */
import type { Env } from '../types';

const D1_FREE_DB_LIMIT = 500 * 1024 * 1024;     // 500 MB per DB on Workers Free
const D1_PAID_DB_LIMIT = 10 * 1024 * 1024 * 1024; // 10 GB per DB on Workers Paid

const safeJSON = (s: string | null | undefined) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/* ---------------- ML ---------------- */
export async function adminML(env: Env) {
  const now = Date.now();
  const [snap, mlLast, models, preds, bars, snaps] = await Promise.all([
    env.CACHE.get('ml:snap', 'json').catch(() => null),
    env.CACHE.get('ml:last', 'json').catch(() => null) as Promise<{ t: number } | null>,
    env.DB.prepare('SELECT id, name, trained_at, active, metrics, LENGTH(weights) AS wbytes FROM ml_models ORDER BY id DESC LIMIT 20')
      .all<{ id: number; name: string; trained_at: number; active: number; metrics: string; wbytes: number }>(),
    env.DB.prepare(
      `SELECT p.ts, p.horizon_days, p.p_up, p.direction, p.regime, o.realized_ret, o.correct
       FROM predictions p LEFT JOIN prediction_outcomes o ON p.ts=o.ts AND p.horizon_days=o.horizon_days
       ORDER BY p.ts DESC LIMIT 400`)
      .all<{ ts: number; horizon_days: number; p_up: number; direction: string; regime: string | null; realized_ret: number | null; correct: number | null }>(),
    env.DB.prepare(`SELECT symbol, COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM daily_bars GROUP BY symbol ORDER BY symbol`)
      .all<{ symbol: string; n: number; first: string; last: string }>().catch(() => ({ results: [] as any[] })),
    env.DB.prepare(`SELECT ts, price, source FROM price_snapshots WHERE symbol='XAU:USD' AND ts > ? ORDER BY ts ASC`)
      .bind(now - 7 * 864e5).all<{ ts: number; price: number; source: string }>(),
  ]);

  const p = (preds.results ?? []).slice().reverse(); // oldest → newest for charts
  const graded = p.filter(r => r.correct != null);
  const hits = graded.filter(r => r.correct === 1).length;

  // rolling accuracy (window 20) over graded rows
  const rolling: { ts: number; acc: number }[] = [];
  for (let i = 0; i < graded.length; i++) {
    const w = graded.slice(Math.max(0, i - 19), i + 1);
    if (w.length >= 5) rolling.push({ ts: graded[i].ts, acc: w.filter(r => r.correct === 1).length / w.length });
  }
  // calibration: bucket predicted p_up vs realized up-rate
  const B = [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 1.01]] as const;
  const calibration = B.map(([lo, hi]) => {
    const rows = graded.filter(r => r.p_up >= lo && r.p_up < hi);
    const upRate = rows.length ? rows.filter(r => (r.realized_ret ?? 0) > 0).length / rows.length : null;
    const meanP = rows.length ? rows.reduce((s, r) => s + r.p_up, 0) / rows.length : null;
    return { bucket: `${lo.toFixed(1)}–${Math.min(hi, 1).toFixed(1)}`, n: rows.length, meanP, upRate };
  });
  const byRegime: Record<string, { n: number; hits: number }> = {};
  for (const r of graded) { const k = r.regime ?? '—'; (byRegime[k] ??= { n: 0, hits: 0 }); byRegime[k].n++; if (r.correct === 1) byRegime[k].hits++; }
  const byDir: Record<string, { n: number; hits: number }> = {};
  for (const r of graded) { const k = r.direction; (byDir[k] ??= { n: 0, hits: 0 }); byDir[k].n++; if (r.correct === 1) byDir[k].hits++; }
  // naive baseline: "always UP" hit rate on the same graded set — the model has to beat this
  const baseUp = graded.length ? graded.filter(r => (r.realized_ret ?? 0) > 0).length / graded.length : null;

  return {
    ts: now,
    snap,
    cron: { lastRun: mlLast?.t ?? null, cadence: 'hourly cron · predict at most every 6h · retrain when model > 7d old' },
    models: (models.results ?? []).map(m => ({ id: m.id, name: m.name, trainedAt: m.trained_at, active: !!m.active, weightsBytes: m.wbytes, metrics: safeJSON(m.metrics) })),
    predictions: p,
    stats: {
      predictions: p.length, graded: graded.length, hits,
      accuracy: graded.length ? hits / graded.length : null,
      baselineAlwaysUp: baseUp,
      pending: p.length - graded.length,
      byRegime, byDirection: byDir,
    },
    rolling, calibration,
    bars: bars.results ?? [],
    goldSnapshots: (snaps.results ?? []).filter((_, i, a) => a.length <= 600 || i % Math.ceil(a.length / 600) === 0),
  };
}

/* ---------------- DATABASE ---------------- */
export async function adminDB(env: Env) {
  const tables = await env.DB.prepare(
    `SELECT name, type FROM sqlite_master WHERE type IN ('table','index') AND substr(name,1,7) != 'sqlite_' AND substr(name,1,4) != '_cf_' ORDER BY type DESC, name`
  ).all<{ name: string; type: string }>();
  const tnames = (tables.results ?? []).filter(t => t.type === 'table').map(t => t.name).filter(n => /^[A-Za-z0-9_]+$/.test(n));
  const idx = (tables.results ?? []).filter(t => t.type === 'index').map(t => t.name);

  // row counts in one batch
  const counts = tnames.length ? await env.DB.batch(tnames.map(t => env.DB.prepare(`SELECT COUNT(*) AS n FROM "${t}"`))) : [];
  // approximate payload bytes per table: SUM(LENGTH(col)) over every column.
  // best-effort — if PRAGMA is refused the column shows "—" instead of failing the panel
  let bytes: D1Result[] = [];
  try {
    const infos = tnames.length ? await env.DB.batch(tnames.map(t => env.DB.prepare(`PRAGMA table_info("${t}")`))) : [];
    const byteStmts = tnames.map((t, i) => {
      const cols = ((infos[i]?.results ?? []) as { name: string }[]).map(c => c.name).filter(c => /^[A-Za-z0-9_]+$/.test(c));
      const expr = cols.length ? cols.map(c => `COALESCE(LENGTH("${c}"),0)`).join('+') : '0';
      return env.DB.prepare(`SELECT COALESCE(SUM(${expr}),0) AS b FROM "${t}"`);
    });
    bytes = byteStmts.length ? await env.DB.batch(byteStmts) : [];
  } catch (e) { console.error('ADMIN_DB_BYTES_FAIL', String((e as Error)?.message ?? e).slice(0, 120)); }

  // whole-DB size: D1 returns it on every result's meta.size_after
  const probe = await env.DB.prepare('SELECT 1 AS ok').run();
  const sizeBytes = Number((probe.meta as any)?.size_after ?? NaN);

  const now = Date.now();
  const growth = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM price_snapshots WHERE ts > ?').bind(now - 864e5),
    env.DB.prepare('SELECT COUNT(*) AS n FROM api_probes WHERE ts > ?').bind(now - 864e5),
    env.DB.prepare('SELECT COUNT(*) AS n FROM predictions WHERE ts > ?').bind(now - 864e5),
    env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE created_at > ?').bind(now - 864e5),
    env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('SELECT MIN(ts) AS t FROM price_snapshots'),
  ]);
  const g = (i: number) => Number(((growth[i]?.results ?? [])[0] as any)?.n ?? 0);

  return {
    ts: now,
    name: 'gold-terminal',
    sizeBytes: isFinite(sizeBytes) ? sizeBytes : null,
    limits: { freeBytes: D1_FREE_DB_LIMIT, paidBytes: D1_PAID_DB_LIMIT },
    tables: tnames.map((t, i) => ({
      name: t,
      rows: Number(((counts[i]?.results ?? [])[0] as any)?.n ?? 0),
      approxBytes: bytes[i] ? Number(((bytes[i].results ?? [])[0] as any)?.b ?? 0) : null,
    })).sort((a, b) => (b.approxBytes ?? -1) - (a.approxBytes ?? -1) || b.rows - a.rows),
    indexes: idx,
    growth24h: { price_snapshots: g(0), api_probes: g(1), predictions: g(2), sessions: g(3) },
    expiredSessions: g(4),
    oldestSnapshot: ((growth[5]?.results ?? [])[0] as any)?.t ?? null,
    retention: { price_snapshots: '90 days', api_probes: '14 days', sessions: 'deleted when expired', series_points: 'kept (≈90 rows/day across all series — decades fit in the Free 500 MB)' },
  };
}

/** daily retention job (cron) + admin button. returns rows deleted per table. */
export async function pruneDB(env: Env): Promise<Record<string, number>> {
  const now = Date.now();
  const r = await env.DB.batch([
    env.DB.prepare('DELETE FROM price_snapshots WHERE ts < ?').bind(now - 90 * 864e5),
    env.DB.prepare('DELETE FROM api_probes WHERE ts < ?').bind(now - 14 * 864e5),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
  ]);
  return {
    price_snapshots: r[0]?.meta?.changes ?? 0,
    api_probes: r[1]?.meta?.changes ?? 0,
    sessions: r[2]?.meta?.changes ?? 0,
  };
}

/* ---------------- KV ---------------- */
const KV_KEYS = ['boot:15M', 'boot:1D', 'series:daily', 'macro:v2', 'news', 'miners', 'fx', 'page:energy', 'page:agri', 'eia:rows', 'ml:snap', 'ml:last', 'goldio:daily', 'news:sentiment', 'cron:daily'];
export async function adminKV(env: Env) {
  const rows = await Promise.all(KV_KEYS.map(async (k) => {
    try {
      const raw = await env.CACHE.get(k, 'json') as any;
      if (raw == null) return { key: k, present: false, ageMs: null, ttl: null };
      const ts = typeof raw?.ts === 'number' ? raw.ts : typeof raw?.t === 'number' ? raw.t : null;
      return { key: k, present: true, ageMs: ts ? Date.now() - ts : null, ttl: typeof raw?.ttl === 'number' ? raw.ttl : null };
    } catch (e) { return { key: k, present: false, ageMs: null, ttl: null, error: String((e as Error)?.message ?? e).slice(0, 80) }; }
  }));
  return { ts: Date.now(), keys: rows, note: 'KV Free = 1,000 writes/day · 100,000 reads/day. Write failures are logged (KV_WRITE_FAIL) and served from isolate memory.' };
}

/* ---------------- USERS ---------------- */
export async function adminUsers(env: Env) {
  const now = Date.now();
  const r = await env.DB.prepare(
    `SELECT u.id, u.name, COALESCE(u.role,'operator') AS role, u.created_at, u.login_attempts, u.locked_until,
            (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id=u.id) AS last_login,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at > ?) AS active_sessions
     FROM users u ORDER BY u.id ASC LIMIT 500`
  ).bind(now).all<{ id: number; name: string; role: string; created_at: number; login_attempts: number; locked_until: number | null; last_login: number | null; active_sessions: number }>();
  return { ts: now, users: r.results ?? [] };
}

export async function setUserRole(env: Env, actorId: number, id: number, role: string): Promise<{ ok: boolean; error?: string }> {
  if (role !== 'admin' && role !== 'operator') return { ok: false, error: 'ROLE MUST BE admin OR operator' };
  if (!Number.isInteger(id)) return { ok: false, error: 'BAD USER ID' };
  if (role === 'operator') {
    const admins = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='admin'`).first<{ n: number }>();
    const target = await env.DB.prepare('SELECT role FROM users WHERE id=?').bind(id).first<{ role: string }>();
    if (target?.role === 'admin' && (admins?.n ?? 0) <= 1) return { ok: false, error: 'CANNOT DEMOTE THE LAST ADMIN' };
    if (id === actorId && (admins?.n ?? 0) <= 1) return { ok: false, error: 'CANNOT DEMOTE YOURSELF AS LAST ADMIN' };
  }
  const r = await env.DB.prepare('UPDATE users SET role=? WHERE id=?').bind(role, id).run();
  return (r.meta?.changes ?? 0) > 0 ? { ok: true } : { ok: false, error: 'USER NOT FOUND' };
}

export async function unlockUser(env: Env, id: number): Promise<{ ok: boolean }> {
  const r = await env.DB.prepare('UPDATE users SET login_attempts=0, locked_until=NULL WHERE id=?').bind(id).run();
  return { ok: (r.meta?.changes ?? 0) > 0 };
}

export async function revokeSessions(env: Env, id: number): Promise<{ ok: boolean; revoked: number }> {
  const r = await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
  return { ok: true, revoked: r.meta?.changes ?? 0 };
}
