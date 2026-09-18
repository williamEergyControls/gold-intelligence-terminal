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

/* ================= SECRET RESOLVER =================
   Works with ALL three ways a key can arrive:
   (a) classic secret         -> plain string on env
   (b) dashboard Secret bind  -> plain string on env
   (c) Secrets Store binding  -> object with .get()
   ensureSecrets() resolves (c) once per isolate and memoizes. */
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

// ---- failover chain: try providers in order, record health for the DATA panel ----
const healthMem = new Map<string, { lastSuccess: number | null; lastFailure: number | null; latencyMs: number | null }>();
export function healthSnapshot(configured: Record<string, Delay | null>): { name: string; configured: boolean; delay: Delay | null; lastSuccess: number | null; lastFailure: number | null; latencyMs: number | null; status: string }[] {
  return Object.entries(configured).map(([name, delay]) => {
    const h = healthMem.get(name
