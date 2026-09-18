import type { Env, Delay } from '../types';

export const UA = 'GoldIntelligenceTerminal/1.0 (personal research terminal; contact: you@example.com)';

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

/* ================= SECRET RESOLVER =================
   Handles every way a key can arrive on env:
   (a) classic secret        -> plain string
   (b) dashboard Secret bind -> plain string
   (c) Secrets Store binding -> object with .get()   */
const secretMemo = new Map<string, string>();
export function secret(env: unknown, name: string): string | undefined {
  const v = (env as Record<string, unknown>)[name];
  if (typeof v === 'string') return v || undefined;
  return secretMemo.get(name);
}
export async function ensureSecrets(env: unknown): Promise<void> {
  for (const n of ['METALS_API_KEY', 'FRED_API_KEY', 'BLS_API_KEY', 'SEC_USER_AGENT']) {
    if (secretMemo.has(n)) continue;
    const v = (env as Record<string, unknown>)[n];
    if (typeof v === 'string') { if (v) secretMemo.set(n, v); }
    else if (v && typeof (v as { get?: unknown }).get === 'function') {
      try { const s = await (v as { get(): Promise<string> }).get(); if (s) secretMemo.set(n, s); } catch { /* unresolved */ }
    }
  }
}

// ---- failover chain + health tracking ----
const healthMem = new Map<string, { lastSuccess: number | null; lastFailure: number | null; latencyMs: number | null }>();
export function healthSnapshot(configured: Record<string, Delay | null>): { name: string; configured: boolean; delay: Delay | null; lastSuccess: number | null; lastFailure: number | null; latencyMs: number | null; status: string }[] {
  return Object.entries(configured).map(([name, delay]) => {
    const h = healthMem.get(name);
    const configuredB = delay !== null;
    const status = !configuredB ? 'not-configured'
      : h?.lastSuccess ? (h.lastFailure && h.lastFailure > h.lastSuccess ? 'degraded' : 'online')
      : h?.lastFailure ? 'offline' : 'idle';
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
