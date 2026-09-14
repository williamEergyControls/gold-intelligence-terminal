interface Envelope<T> { v: T; ts: number; ttl: number }
const micro = new Map<string, Envelope<unknown>>(); // per-isolate shield for 30s poll bursts

export class AppCache {
  constructor(private kv: KVNamespace) {}

  async read<T>(k: string): Promise<{ v: T; ageMs: number; ttl: number } | null> {
    const m = micro.get(k);
    if (m) return { v: m.v as T, ageMs: Date.now() - m.ts, ttl: m.ttl };
    const raw = (await this.kv.get(k, 'json')) as Envelope<T> | null;
    if (!raw) return null;
    micro.set(k, raw);
    return { v: raw.v, ageMs: Date.now() - raw.ts, ttl: raw.ttl };
  }

  async write(k: string, v: unknown, ttlSec: number) {
    const e: Envelope<unknown> = { v, ts: Date.now(), ttl: ttlSec };
    micro.set(k, e);
    // KV ttl is 6x the logical ttl so wrap() can serve STALE data on upstream failure,
    // instead of fabricating anything. KV minimum ttl is 60s.
    await this.kv.put(k, JSON.stringify(e), { expirationTtl: Math.max(60, ttlSec * 6) });
  }

  async wrap<T>(k: string, ttlSec: number, fetcher: () => Promise<T>):
    Promise<{ v: T; ageMs: number; stale: boolean }> {
    const hit = await this.read<T>(k);
    if (hit && hit.ageMs < hit.ttl * 1000) return { v: hit.v, ageMs: hit.ageMs, stale: false };
    try {
      const v = await fetcher();
      await this.write(k, v, ttlSec);
      return { v, ageMs: 0, stale: false };
    } catch (err) {
      if (hit) return { v: hit.v, ageMs: hit.ageMs, stale: true }; // last valid value, labeled stale
      throw err;
    }
  }
}
