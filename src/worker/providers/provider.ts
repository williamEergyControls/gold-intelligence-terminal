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
   (c) Secrets Store binding -> object with .get()   <- this repo (wrangler.jsonc)
   ensureSecrets() MUST run at the top of fetch() and scheduled(), otherwise
   every Secrets Store key reads as "not configured". */
export const SECRET_NAMES = ['METALS_API_KEY', 'FRED_API_KEY', 'EIA_API_KEY', 'GOLDAPI_KEY', 'BLS_API_KEY', 'SEC_USER_AGENT'] as const;
export type SecretName = typeof SECRET_NAMES[number];
export interface SecretState { name: string; binding: 'secrets-store' | 'plain' | 'none'; resolved: boolean; error: string | null }

const secretMemo = new Map<string, string>();
const secretErr = new Map<string, string>();
export function secret(env: unknown, name: string): string | undefined {
  const v = (env as Record<string, unknown>)[name];
  if (typeof v === 'string') return v || undefined;
  return secretMemo.get(name);
}
export async function ensureSecrets(env: unknown): Promise<void> {
  await Promise.all(SECRET_NAMES.map(async (n) => {
    if (secretMemo.has(n)) return;
    const v = (env as Record<string, unknown>)[n];
    if (typeof v === 'string') { if (v) secretMemo.set(n, v); return; }
    if (v && typeof (v as { get?: unknown }).get === 'function') {
      try {
        const s = await (v as { get(): Promise<string> }).get();
        if (s) { secretMemo.set(n, s); secretErr.delete(n); } else secretErr.set(n, 'empty value');
      } catch (e) { secretErr.set(n, String((e as Error)?.message ?? e).slice(0, 140)); }
    }
  }));
}
/** Admin view — never returns the secret value. */
export function secretStates(env: unknown): SecretState[] {
  return SECRET_NAMES.map((n) => {
    const v = (env as Record<string, unknown>)[n];
    const binding: SecretState['binding'] = typeof v === 'string' ? 'plain' : (v && typeof (v as { get?: unknown }).get === 'function') ? 'secrets-store' : 'none';
    return { name: n, binding, resolved: !!secret(env, n), error: secretErr.get(n) ?? null };
  });
}

// ---- failover chain + health tracking ----
interface HealthMem { lastSuccess: number | null; lastFailure: number | null; latencyMs: number | null; lastError: string | null }
const healthMem = new Map<string, HealthMem>();
export type HealthStatus = 'online' | 'degraded' | 'offline' | 'idle' | 'not-configured';
function statusOf(configured: boolean, h: HealthMem | undefined): HealthStatus {
  if (!configured) return 'not-configured';
  if (h?.lastSuccess) return h.lastFailure && h.lastFailure > h.lastSuccess ? 'degraded' : 'online';
  return h?.lastFailure ? 'offline' : 'idle';
}
export function healthSnapshot(configured: Record<string, Delay | null>): { name: string; configured: boolean; delay: Delay | null; lastSuccess: number | null; lastFailure: number | null; latencyMs: number | null; status: HealthStatus }[] {
  return Object.entries(configured).map(([name, delay]) => {
    const h = healthMem.get(name);
    const configuredB = delay !== null;
    return { name, configured: configuredB, delay, lastSuccess: h?.lastSuccess ?? null, lastFailure: h?.lastFailure ?? null, latencyMs: h?.latencyMs ?? null, status: statusOf(configuredB, h) };
  });
}
export function persistHealthRows(): { provider: string; last_success: number | null; last_failure: number | null; latency_ms: number | null; status: string }[] {
  return [...healthMem.entries()].map(([provider, h]) => ({ provider, last_success: h.lastSuccess, last_failure: h.lastFailure, latency_ms: h.latencyMs, status: statusOf(true, h) }));
}
export function healthErrors(): Record<string, string | null> {
  const o: Record<string, string | null> = {};
  for (const [k, h] of healthMem) o[k] = h.lastError;
  return o;
}

export async function firstOk<T>(
  attempts: { name: string; fn: () => Promise<T> }[]
): Promise<{ value: T; provider: string; latencyMs: number; errors: string[] }> {
  const errors: string[] = [];
  for (const a of attempts) {
    const t0 = Date.now();
    try {
      const value = await a.fn();
      const h = healthMem.get(a.name) ?? { lastSuccess: null, lastFailure: null, latencyMs: null, lastError: null };
      h.lastSuccess = Date.now(); h.latencyMs = h.latencyMs ? Math.round(h.latencyMs * 0.7 + (h.lastSuccess - t0) * 0.3) : h.lastSuccess - t0;
      healthMem.set(a.name, h);
      return { value, provider: a.name, latencyMs: h.latencyMs, errors };
    } catch (e) {
      const h = healthMem.get(a.name) ?? { lastSuccess: null, lastFailure: null, latencyMs: null, lastError: null };
      h.lastFailure = Date.now();
      h.lastError = String(e && (e as Error).message || e).slice(0, 160);
      healthMem.set(a.name, h);
      errors.push(`${a.name}: ${h.lastError.slice(0, 120)}`);
    }
  }
  throw new Error(`ALL_SOURCES_FAILED | ${errors.join(' | ')}`);
}
