interface Envelope<T> { v: T; ts: number; ttl: number }
const micro = new Map<string, Envelope<unknown>>(); // per-isolate shield for 30s poll bursts

export class AppCache {
  constructor(private kv: KVNamespace) {}

  async read<T>(k: string): Promise<{ v: T; ageMs: number; ttl: number } | null> {
    const m = micro.get(k) as Envelope<T> | undefined;
    // fresh isolate copy → no KV read. expired copy → KV may hold a newer one (cron writes it)
    if (m && Date.now() - m.ts < m.ttl * 1000) return { v: m.v, ageMs: Date.now() - m.ts, ttl: m.ttl };
    let raw: Envelope<T> | null = null;
    try { raw = (await this.kv.get(k, 'json')) as Envelope<T> | null; }
    catch (e) { console.error('KV_READ_FAIL', k, String((e as Error)?.message ?? e).slice(0, 120)); }
    const best = raw && (!m || raw.ts > m.ts) ? raw : m ?? null;
    if (!best) return null;
    micro.set(k, best);
    return { v: best.v, ageMs: Date.now() - best.ts, ttl: best.ttl };
  }

  /** micro-cache first, KV second. a KV put failure (free plan = 1,000 writes/day)
      is logged, never thrown — the value is still served from the isolate. */
  async write(k: string, v: unknown, ttlSec: number): Promise<boolean> {
    const e: Envelope<unknown> = { v, ts: Date.now(), ttl: ttlSec };
    micro.set(k, e);
    try {
      // KV ttl is 6x the logical ttl so wrap() can serve STALE data on upstream failure,
      // instead of fabricating anything. KV minimum ttl is 60s.
      await this.kv.put(k, JSON.stringify(e), { expirationTtl: Math.max(60, ttlSec * 6) });
      return true;
    } catch (err) {
      console.error('KV_WRITE_FAIL', k, String((err as Error)?.message ?? err).slice(0, 120));
      return false;
    }
  }

  async wrap<T>(k: string, ttlSec: number, fetcher: () => Promise<T>):
    Promise<{ v: T; ageMs: number; stale: boolean }> {
    const hit = await this.read<T>(k);
    if (hit && hit.ageMs < hit.ttl * 1000) return { v: hit.v, ageMs: hit.ageMs, stale: false };
    let v: T;
    try {
      v = await fetcher();
    } catch (err) {
      if (hit) return { v: hit.v, ageMs: hit.ageMs, stale: true }; // last valid value, labeled stale
      throw err;
    }
    await this.write(k, v, ttlSec); // never throws
    return { v, ageMs: 0, stale: false };
  }
}
