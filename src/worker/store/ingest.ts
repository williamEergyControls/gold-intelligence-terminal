/* ================================================================
   INGEST — scheduled poller for the D1 time-series warehouse
   cycle (every 10 min cron, or admin "RUN INGEST"):
     INIT     load unit state (1 query)
     POLL     pick due units (never-fetched first, then most overdue),
              cap = INGEST_BUDGET upstream calls (Free: 50 subrequests/invocation)
     EVALUATE parse → [id, ts, v] rows, keyed by observation DATE (UTC ms)
     PUBLISH  3 D1 statements total, whatever the row count:
              points (json_each bulk upsert) + series_meta + ingest_units
   incremental after backfill: only the recent window is re-fetched,
   so revisions and today's moving daily bar are overwritten in place.
   ================================================================ */
import type { Env } from '../types';
import { UA, secret } from '../providers/provider';
import { UNITS, FX_QUOTED_INVERT, type UnitDef } from './registry';

type Row = [string, number, number];
export interface UnitResult { key: string; ok: boolean; rows: number; error: string | null; ms: number; backfill: boolean }
interface UnitState { key: string; fetched_at: number | null; ok_at: number | null; last_ts: number | null; error: string | null }

const DAY = 864e5;
const dayKey = (iso: string) => Date.parse(iso.slice(0, 10) + 'T00:00:00Z');
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function getJSON(url: string, headers: Record<string, string> = {}): Promise<any> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} @${new URL(url).hostname}`);
  return r.json();
}

/* exchange-local calendar date. meta.gmtoffset is TODAY's offset, so applying it to a
   2-year history shifts every bar across a DST change by a day — use the tz name. */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function localDay(sec: number, tz: string | undefined, fallbackOff: number): { date: string; hour: number; dow: number } {
  if (tz) {
    try {
      let f = fmtCache.get(tz);
      if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); fmtCache.set(tz, f); }
      const p: Record<string, string> = {};
      for (const x of f.formatToParts(new Date(sec * 1000))) p[x.type] = x.value;
      const date = `${p.year}-${p.month}-${p.day}`;
      return { date, hour: +p.hour % 24, dow: new Date(date + 'T00:00:00Z').getUTCDay() };
    } catch { /* fall through */ }
  }
  const d = new Date((sec + fallbackOff) * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), dow: d.getUTCDay() };
}
function nextWeekday(date: string): string {
  let t = Date.parse(date + 'T00:00:00Z') + DAY;
  while ([0, 6].includes(new Date(t).getUTCDay())) t += DAY;
  return isoDay(t);
}

/* ---------------- fetchers: unit → rows ---------------- */
async function fetchYahoo(u: UnitDef, lastTs: number | null): Promise<Row[]> {
  const gapDays = lastTs ? (Date.now() - lastTs) / DAY : Infinity;
  const range = gapDays === Infinity ? '2y' : gapDays > 25 ? '6mo' : gapDays > 4 ? '1mo' : '5d';
  let lastErr: unknown;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const j = await getJSON(`https://${host}/v8/finance/chart/${encodeURIComponent(u.arg)}?interval=1d&range=${range}&includePrePost=false`);
      const r = j?.chart?.result?.[0];
      if (!r) throw new Error('empty chart');
      const off = Number(r.meta?.gmtoffset ?? 0);
      const tz: string | undefined = r.meta?.exchangeTimezoneName;
      const isFut = r.meta?.instrumentType === 'FUTURE';
      const ts: number[] = r.timestamp ?? [];
      const cl: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
      const out: Row[] = [];
      for (let i = 0; i < ts.length; i++) {
        const v = cl[i];
        if (v == null || !isFinite(v)) continue;
        const ld = localDay(ts[i], tz, off);
        if (ld.dow === 0 || ld.dow === 6) continue; // no weekend rows: they would add fake 0-return days
        out.push([u.series[0].id, dayKey(ld.date), v]);
      }
      // live print → its SESSION date: futures trading after 18:00 exchange time belong to the
      // next session (Sunday-evening GC/CL prints are Monday's). weekend prints are dropped.
      const live = r.meta?.regularMarketPrice, lt = r.meta?.regularMarketTime;
      if (typeof live === 'number' && typeof lt === 'number') {
        const ld = localDay(lt, tz, off);
        const session = isFut && ld.hour >= 18 ? nextWeekday(ld.date) : ld.date;
        const sdow = new Date(session + 'T00:00:00Z').getUTCDay();
        if (sdow !== 0 && sdow !== 6) out.push([u.series[0].id, dayKey(session), live]);
      }
      if (!out.length) throw new Error('no closes');
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('yahoo failed');
}

async function fetchFred(env: Env, u: UnitDef, lastTs: number | null): Promise<Row[]> {
  const key = secret(env, 'FRED_API_KEY');
  if (!key) throw new Error('FRED_API_KEY not resolved');
  const start = lastTs ? isoDay(lastTs - (u.series[0].freq === 'monthly' ? 100 : 10) * DAY) : isoDay(Date.now() - u.backfillDays * DAY);
  const j = await getJSON(`https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(u.arg)}&api_key=${key}&file_type=json&observation_start=${start}`);
  const out: Row[] = [];
  for (const o of j?.observations ?? []) {
    const v = parseFloat(o.value);
    if (o.value === '.' || !isFinite(v)) continue;
    out.push([u.series[0].id, dayKey(o.date), v]);
  }
  if (!out.length && !lastTs) throw new Error('no observations');
  return out;
}

async function fetchFrankfurter(u: UnitDef, lastTs: number | null): Promise<Row[]> {
  const start = lastTs ? isoDay(lastTs - 10 * DAY) : isoDay(Date.now() - u.backfillDays * DAY);
  const j = await getJSON(`https://api.frankfurter.app/${start}..?from=USD&to=${u.arg}`);
  const out: Row[] = [];
  for (const [date, rates] of Object.entries(j?.rates ?? {}) as [string, Record<string, number>][]) {
    const t = dayKey(date);
    for (const [ccy, rate] of Object.entries(rates)) {
      if (!isFinite(rate) || rate <= 0) continue;
      const inv = FX_QUOTED_INVERT.includes(ccy);
      out.push([inv ? `${ccy}USD` : `USD${ccy}`, t, inv ? 1 / rate : rate]);
    }
  }
  if (!out.length) throw new Error('no fx rows');
  return out;
}

async function fetchCoinGecko(u: UnitDef, lastTs: number | null): Promise<Row[]> {
  const days = lastTs ? Math.min(30, Math.ceil((Date.now() - lastTs) / DAY) + 2) : 365;
  const j = await getJSON(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(u.arg)}/market_chart?vs_currency=usd&days=${days}&interval=daily`);
  const [px, mc] = [u.series[0].id, u.series[1].id];
  const out: Row[] = [];
  for (const [t, v] of (j?.prices ?? []) as [number, number][]) if (isFinite(v) && v > 0) out.push([px, dayKey(new Date(t).toISOString()), v]);
  for (const [t, v] of (j?.market_caps ?? []) as [number, number][]) if (isFinite(v) && v > 0) out.push([mc, dayKey(new Date(t).toISOString()), v]);
  if (!out.length) throw new Error('no prices');
  return out;
}

async function fetchUnit(env: Env, u: UnitDef, lastTs: number | null): Promise<Row[]> {
  switch (u.source) {
    case 'yahoo': return fetchYahoo(u, lastTs);
    case 'fred': return fetchFred(env, u, lastTs);
    case 'frankfurter': return fetchFrankfurter(u, lastTs);
    case 'coingecko': return fetchCoinGecko(u, lastTs);
  }
}

/* ---------------- D1 writes (3 statements per cycle) ---------------- */
const CHUNK = 4000; // rows per json_each statement (~120 KB) — far under D1's per-value limit

export function pointsUpsert(env: Env, rows: Row[]): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    out.push(env.DB.prepare(
      `INSERT INTO series_points(id, ts, v)
       SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]') FROM json_each(?1) WHERE 1
       ON CONFLICT(id, ts) DO UPDATE SET v = excluded.v`).bind(JSON.stringify(rows.slice(i, i + CHUNK))));
  }
  return out;
}

function metaUpsert(env: Env, ids: { id: string; label: string; cls: string; kind: string; unit: string; freq: string; source: string; src_id: string }[]): D1PreparedStatement {
  // aggregates read back from series_points so the meta row is always the truth
  return env.DB.prepare(
    `INSERT INTO series_meta(id, label, cls, kind, unit, freq, source, src_id, points, first_ts, last_ts, last_v, prev_v, updated_at)
     SELECT j.id, j.label, j.cls, j.kind, j.unit, j.freq, j.source, j.src_id,
       (SELECT COUNT(*) FROM series_points p WHERE p.id = j.id),
       (SELECT MIN(ts) FROM series_points p WHERE p.id = j.id),
       (SELECT MAX(ts) FROM series_points p WHERE p.id = j.id),
       (SELECT v FROM series_points p WHERE p.id = j.id ORDER BY ts DESC LIMIT 1),
       (SELECT v FROM series_points p WHERE p.id = j.id ORDER BY ts DESC LIMIT 1 OFFSET 1),
       ?2
     FROM (SELECT json_extract(value,'$.id') id, json_extract(value,'$.label') label, json_extract(value,'$.cls') cls,
                  json_extract(value,'$.kind') kind, json_extract(value,'$.unit') unit, json_extract(value,'$.freq') freq,
                  json_extract(value,'$.source') source, json_extract(value,'$.src_id') src_id
           FROM json_each(?1)) j WHERE 1
     ON CONFLICT(id) DO UPDATE SET label=excluded.label, cls=excluded.cls, kind=excluded.kind, unit=excluded.unit, freq=excluded.freq,
       source=excluded.source, src_id=excluded.src_id, points=excluded.points, first_ts=excluded.first_ts, last_ts=excluded.last_ts,
       last_v=excluded.last_v, prev_v=excluded.prev_v, updated_at=excluded.updated_at`).bind(JSON.stringify(ids), Date.now());
}

function unitsUpsert(env: Env, rs: UnitResult[], lastTs: Record<string, number | null>, cycleStart: number): D1PreparedStatement {
  const now = cycleStart; // stamp the cycle START, so a 30-min unit is due again 30 min later, not 40
  const payload = rs.map(r => ({ key: r.key, ok: r.ok ? 1 : 0, err: r.error, rows: r.rows, ms: r.ms, last: lastTs[r.key] ?? null }));
  return env.DB.prepare(
    `INSERT INTO ingest_units(key, fetched_at, ok_at, error, last_rows, last_ms, last_ts, fails)
     SELECT json_extract(value,'$.key'), ?2,
            CASE WHEN json_extract(value,'$.ok')=1 THEN ?2 END,
            json_extract(value,'$.err'), json_extract(value,'$.rows'), json_extract(value,'$.ms'), json_extract(value,'$.last'),
            CASE WHEN json_extract(value,'$.ok')=1 THEN 0 ELSE 1 END
     FROM json_each(?1) WHERE 1
     ON CONFLICT(key) DO UPDATE SET fetched_at=excluded.fetched_at,
       ok_at=COALESCE(excluded.ok_at, ingest_units.ok_at), error=excluded.error, last_rows=excluded.last_rows,
       last_ms=excluded.last_ms, last_ts=COALESCE(excluded.last_ts, ingest_units.last_ts),
       fails=CASE WHEN excluded.fails=0 THEN 0 ELSE ingest_units.fails + 1 END`).bind(JSON.stringify(payload), now);
}

/* ---------------- scheduler ---------------- */
export async function unitStates(env: Env): Promise<Record<string, UnitState & { fails: number }>> {
  const r = await env.DB.prepare('SELECT key, fetched_at, ok_at, last_ts, error, fails FROM ingest_units').all<UnitState & { fails: number }>();
  const o: Record<string, UnitState & { fails: number }> = {};
  for (const x of r.results ?? []) o[x.key] = x;
  return o;
}

export function dueUnits(states: Record<string, UnitState & { fails: number }>, now = Date.now()): { u: UnitDef; overdue: number; backfill: boolean }[] {
  return UNITS.map(u => {
    const s = states[u.key];
    if (!s || !s.ok_at) {
      // never succeeded: retry with backoff 10m · 20m · 40m … capped at 6h
      const wait = s ? Math.min(360, 10 * 2 ** Math.min(6, (s.fails ?? 1) - 1)) * 6e4 : 0;
      return { u, overdue: s?.fetched_at ? now - s.fetched_at - wait : 1e15, backfill: true };
    }
    const wait = (s.error ? Math.min(u.cadenceMin, 30) : u.cadenceMin) * 6e4;
    return { u, overdue: now - (s.fetched_at ?? 0) - wait, backfill: false };
  }).filter(x => x.overdue >= -120000).sort((a, b) => b.overdue - a.overdue); // 2-min grace for cron jitter
}

/** round-robin across sources so one blocked host (or a missing key) never eats the whole budget */
function pickFair<T extends { u: UnitDef }>(due: T[], budget: number): T[] {
  const bySrc = new Map<string, T[]>();
  for (const d of due) { const a = bySrc.get(d.u.source) ?? []; a.push(d); bySrc.set(d.u.source, a); }
  const out: T[] = [];
  while (out.length < budget && [...bySrc.values()].some(a => a.length)) {
    for (const a of bySrc.values()) { const x = a.shift(); if (x) out.push(x); if (out.length >= budget) break; }
  }
  return out;
}

export async function runIngest(env: Env, budget = 10, onlyKeys?: string[]): Promise<{ ran: UnitResult[]; due: number; rows: number }> {
  const cycleStart = Date.now();
  const states = await unitStates(env);
  let due = dueUnits(states);
  if (onlyKeys?.length) due = UNITS.filter(u => onlyKeys.includes(u.key)).map(u => ({ u, overdue: 0, backfill: !states[u.key]?.ok_at }));
  // units whose key is not resolved fail fast WITHOUT spending a subrequest or a budget slot
  const needsKey = (u: UnitDef) => (u.source === 'fred' && !secret(env, 'FRED_API_KEY'));
  const blocked = due.filter(d => needsKey(d.u)).slice(0, 20);
  const pick = pickFair(due.filter(d => !needsKey(d.u)), Math.max(1, budget));
  const rows: Row[] = [];
  const lastTs: Record<string, number | null> = {};
  const runOne = async ({ u, backfill }: { u: UnitDef; backfill: boolean }): Promise<UnitResult> => {
    const t0 = Date.now();
    try {
      const rs = await fetchUnit(env, u, backfill ? null : (states[u.key]?.last_ts ?? null));
      rows.push(...rs);
      lastTs[u.key] = rs.reduce((m, r) => Math.max(m, r[1]), 0) || null;
      return { key: u.key, ok: true, rows: rs.length, error: null, ms: Date.now() - t0, backfill };
    } catch (e) {
      return { key: u.key, ok: false, rows: 0, error: String((e as Error)?.message ?? e).slice(0, 200), ms: Date.now() - t0, backfill };
    }
  };
  // sequential per host (no 10-way burst into Yahoo → 429), hosts in parallel
  const groups = new Map<string, typeof pick>();
  for (const p of pick) { const a = groups.get(p.u.source) ?? []; a.push(p); groups.set(p.u.source, a); }
  const ran: UnitResult[] = [];
  await Promise.all([...groups.values()].map(async g => { for (const p of g) ran.push(await runOne(p)); }));
  for (const b of blocked) ran.push({ key: b.u.key, ok: false, rows: 0, error: 'FRED_API_KEY not resolved (no request sent)', ms: 0, backfill: b.backfill });
  if (!ran.length) return { ran, due: due.length, rows: 0 };
  const okKeys = new Set(ran.filter(r => r.ok).map(r => r.key));
  const metas = pick.filter(p => okKeys.has(p.u.key)).flatMap(p => p.u.series.map(s => ({
    id: s.id, label: s.label, cls: s.cls, kind: s.kind, unit: s.unit, freq: s.freq, source: p.u.source, src_id: p.u.source === 'frankfurter' ? s.id : p.u.arg,
  })));
  const stmts = [...pointsUpsert(env, rows)];
  if (metas.length) stmts.push(metaUpsert(env, metas));
  stmts.push(unitsUpsert(env, ran, lastTs, cycleStart));
  await env.DB.batch(stmts);
  return { ran, due: due.length, rows: rows.length };
}

/* ---------------- reads ---------------- */
export async function readSeries(env: Env, ids: string[], sinceMs: number): Promise<Record<string, { t: number; v: number }[]>> {
  const out: Record<string, { t: number; v: number }[]> = {};
  for (const id of ids) out[id] = [];
  if (!ids.length) return out;
  const r = await env.DB.prepare(
    `SELECT id, ts, v FROM series_points WHERE id IN (SELECT value FROM json_each(?1)) AND ts >= ?2 ORDER BY id, ts`
  ).bind(JSON.stringify(ids), sinceMs).all<{ id: string; ts: number; v: number }>();
  for (const x of r.results ?? []) (out[x.id] ??= []).push({ t: x.ts, v: x.v });
  return out;
}

export async function readMeta(env: Env): Promise<Record<string, { id: string; points: number; first_ts: number | null; last_ts: number | null; last_v: number | null; prev_v: number | null; updated_at: number }>> {
  const r = await env.DB.prepare('SELECT id, points, first_ts, last_ts, last_v, prev_v, updated_at FROM series_meta').all<any>();
  const o: Record<string, any> = {};
  for (const x of r.results ?? []) o[x.id] = x;
  return o;
}
