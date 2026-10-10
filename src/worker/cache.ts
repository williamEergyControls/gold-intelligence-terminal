import type { Env } from './types';

/* ================================================================
   APP CACHE — hot data lives in D1 (table cache_kv), not KV.
   why: KV Free = 1,000 writes/day; this cache rewrites ~600/day from the
   crons alone and more per visitor. D1 Free = 100,000 row writes/day.
   INIT     per-isolate micro map (shields 20-60 s poll bursts, zero I/O)
   POLL     micro fresh → return | D1 row (1 row read) | D1 down → legacy KV read
   EVALUATE fresh → serve | expired → fetch upstream → on failure serve last good, labeled stale
   PUBLISH  D1 upsert (1 row written). rows are never expired, so "last good" survives outages.
   ================================================================ */
interface Envelope<T> { v: T; ts: number; ttl: number }
const micro = new Map<string, Envelope<unknown>>();
let tableReady = false;
const MAX_ROW = 1_900_000; // D1 row/value cap is 2 MB
const MICRO_MS = 15000;

async function ensureTable(db: D1Database): Promise<void> {
  if (tableReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS cache_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER NOT NULL, ttl INTEGER NOT NULL)').run();
  tableReady = true;
}

export class AppCache {
  constructor(private env: Env) {}

  async read<T>(k: string): Promise<{ v: T; ageMs: number; ttl: number } | null> {
    const m = micro.get(k) as (Envelope<T> & { seen?: number }) | undefined;
    // the isolate copy is trusted for 15 s at most: crons and requests run in different isolates,
    // so durable state (ledger, evolution, weights) must be re-checked against D1 after that
    if (m && Date.now() - (m.seen ?? m.ts) < MICRO_MS && Date.now() - m.ts < m.ttl * 1000) return { v: m.v, ageMs: Date.now() - m.ts, ttl: m.ttl };
    let raw: Envelope<T> | null = null;
    try {
      await ensureTable(this.env.DB);
      if (m) {
        // cheap check first: same timestamp in D1 → keep the parsed copy (no transfer, no JSON.parse)
        const h = await this.env.DB.prepare('SELECT ts, ttl FROM cache_kv WHERE k = ?').bind(k).first<{ ts: number; ttl: number }>();
        if (h && h.ts === m.ts) { m.seen = Date.now(); return { v: m.v, ageMs: Date.now() - m.ts, ttl: m.ttl }; }
        // our copy is newer and its D1 write failed (daily cap, outage, too big): keep it rather than roll back
        if ((m as any).dirty && (!h || h.ts < m.ts)) { m.seen = Date.now(); return { v: m.v, ageMs: Date.now() - m.ts, ttl: m.ttl }; }
        if (!h) { micro.delete(k); return null; }
      }
      const r = await this.env.DB.prepare('SELECT v, ts, ttl FROM cache_kv WHERE k = ?').bind(k).first<{ v: string; ts: number; ttl: number }>();
      if (r) raw = { v: JSON.parse(r.v) as T, ts: r.ts, ttl: r.ttl };
    } catch (e) {
      // D1 down or over its daily limit: the pre-v3.1 KV copy is still a valid last-good value
      console.error('CACHE_D1_READ_FAIL', k, String((e as Error)?.message ?? e).slice(0, 120));
      try { raw = (await this.env.CACHE.get(k, 'json')) as Envelope<T> | null; } catch { raw = null; }
      if (!raw && m) return { v: m.v, ageMs: Date.now() - m.ts, ttl: m.ttl };
    }
    if (!raw) return null;
    micro.set(k, { ...raw, seen: Date.now() } as Envelope<unknown>);
    return { v: raw.v, ageMs: Date.now() - raw.ts, ttl: raw.ttl };
  }

  /** never throws: a failed write still leaves the value in this isolate */
  async write(k: string, v: unknown, ttlSec: number): Promise<boolean> {
    const e: Envelope<unknown> = { v, ts: Date.now(), ttl: ttlSec };
    micro.set(k, { ...e, seen: Date.now() } as Envelope<unknown>);
    try {
      const s = JSON.stringify(v);
      if (s.length > MAX_ROW) { (micro.get(k) as any).dirty = true; console.error('CACHE_TOO_BIG', k, s.length); return false; }
      await ensureTable(this.env.DB);
      await this.env.DB.prepare(
        `INSERT INTO cache_kv (k, v, ts, ttl) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts, ttl = excluded.ttl`
      ).bind(k, s, e.ts, ttlSec).run();
      return true;
    } catch (err) {
      (micro.get(k) as any).dirty = true;
      console.error('CACHE_D1_WRITE_FAIL', k, String((err as Error)?.message ?? err).slice(0, 120));
      return false;
    }
  }

  /** fresh copy → serve. expired → fetch. fetch fails → last good value, stale: true. nothing at all → throw. */
  async wrap<T>(k: string, ttlSec: number, fetcher: () => Promise<T>):
    Promise<{ v: T; ageMs: number; stale: boolean }> {
    const hit = await this.read<T>(k);
    if (hit && hit.ageMs < hit.ttl * 1000) return { v: hit.v, ageMs: hit.ageMs, stale: false };
    let v: T;
    try {
      v = await fetcher();
    } catch (err) {
      if (hit) return { v: hit.v, ageMs: hit.ageMs, stale: true };
      throw err;
    }
    await this.write(k, v, ttlSec);
    return { v, ageMs: 0, stale: false };
  }
}

/** envelope read for code that used to call env.CACHE.get(key) on AppCache keys */
export async function cacheGet<T = any>(env: Env, k: string): Promise<{ v: T; ts: number } | null> {
  const r = await new AppCache(env).read<T>(k);
  return r ? { v: r.v, ts: Date.now() - r.ageMs } : null;
}

/** daily: per-symbol keys (watchlists, ad-hoc charts) that nobody asked for in a week */
export async function pruneCache(env: Env): Promise<number> {
  try {
    await ensureTable(env.DB);
    const r = await env.DB.prepare(`DELETE FROM cache_kv WHERE ts < ? AND (k LIKE 'watch:%' OR k LIKE 'candles2:%')`).bind(Date.now() - 7 * 864e5).run();
    return r.meta?.changes ?? 0;
  } catch { return 0; }
}
