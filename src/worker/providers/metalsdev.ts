import type { Env, Delay } from '../types';

export const UA = 'GoldIntelligenceTerminal/1.0 (personal research terminal; contact: you@example.com)';
// For SEC calls use env.SEC_USER_AGENT instead — SEC asks for a real identity.

export async function fetchJson(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<any> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status} @${new URL(url).hostname}`);
  return r.json();
}
export async function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status} @${new URL(url).hostname}`);
  return r.text();
}

export async function metalsdevQuote(env: Env, symbol: 'XAU:USD' | 'XAG:USD'): Promise<Quote> {
  if (!env.METALS_API_KEY) throw new Error('METALS_API_KEY not configured');
  const j = await fetchJson(`https://api.metals.dev/v1/latest?api_key=${env.METALS_API_KEY}&currency=USD&unit=toz`);
  const key = symbol === 'XAU:USD' ? 'gold' : 'silver';
  const price = j?.metals?.[key];
  if (typeof price !== 'number') throw new Error('metals.dev: no ' + key);
  return { symbol, price, currency: 'USD', unit: 'troy oz', source: 'metals.dev', delay: 'near-live', ts: Date.now() };
}



// ---- failover chain: try providers in order, record health for the DATA panel ----
const healthMem = new Map<string, { lastSuccess: number | null; lastFailure: number | null; latencyMs: number | null }>();
export function healthSnapshot(configured: Record<string, Delay | null>): { name: string; configured: boolean; delay: Delay | null; lastSuccess: number | null; lastFailure: number | null; latencyMs: number | null; status: string }[] {
  return Object.entries(configured).map(([name, delay]) => {
    const h = healthMem.get(name);
    const configuredB = delay !== null;
    const status = !configuredB ? 'not-configured'
      : h?.lastSuccess ? (h.lastFailure && h.lastFailure > h.lastSuccess ? 'degraded' : 'online')
      : h?.lastFailure ? 'offline' : 'not-configured';
    return { name, configured: configuredB, delay, lastSuccess: h?.lastSuccess ?? null, lastFailure: h?.lastFailure ?? null, latencyMs: h?.latencyMs ?? null, status };
  });
}
export function persistHealthRows(): { provider: string; last_success: number | null; last_failure: number | null; latency_ms: number | null; status: string }[] {
  return [...healthMem.entries()].map(([provider, h]) => ({ provider, last_success: h.lastSuccess, last_failure: h.lastFailure, latency_ms: h.latencyMs, status: 'logged' }));
}

export async function firstOk<T>(
  attempts: { name: string; fn: () => Promise<T> }[]
): Promise<{ value: T; provider: string; latencyMs: number; errors: string[] }> {
  const errors: string[] = [];
  for (const a of attempts) {
    const t0 = Date.now();
    try {
      const value = await a.fn();
      const h = healthMem.get(a.name) ?? { lastSuccess: null, lastFailure: null, latencyMs: null };
      h.lastSuccess = Date.now(); h.latencyMs = h.latencyMs ? Math.round(h.latencyMs * 0.7 + (h.lastSuccess - t0) * 0.3) : h.lastSuccess - t0;
      healthMem.set(a.name, h);
      return { value, provider: a.name, latencyMs: h.latencyMs, errors };
    } catch (e) {
      const h = healthMem.get(a.name) ?? { lastSuccess: null, lastFailure: null, latencyMs: null };
      h.lastFailure = Date.now();
      healthMem.set(a.name, h);
      errors.push(`${a.name}: ${String(e && (e as Error).message || e).slice(0, 120)}`);
    }
  }
  throw new Error(`ALL_SOURCES_FAILED | ${errors.join(' | ')}`);
}
