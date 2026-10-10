/* ================================================================
   MAINTENANCE SLOT — minute :x7 of every 10 (no warm, no ingest, no evolution that minute).
   Runs at most ONE job per slot so each invocation stays inside the Free CPU budget.
   order of precedence:
     1 weather archive missing or > 7 days old     rebuildWeather (2 archive calls)
     2 feature table thin (< 200 rows)            buildFeatures('backfill')
     3 new UTC day, features not refreshed         topUpWeather → buildFeatures('daily')
     4 evo matrix older than features              buildEvoData
     5 ledger roll-up not done for yesterday       dailyRollup (+ blend relearn)
     6 evolution gate not done today (per horizon) evoGate, 8 genomes per slot
     7 SEC Form 4 insider pull not done today      refreshInsiders
   ================================================================ */
import type { Env } from '../types';
import { AppCache } from '../cache';
import { rebuildWeather, topUpWeather, type WxHist } from './weather';
import { buildFeatures } from './features';
import { buildEvoData, evoGate, EVO_H, type EvoData } from './evo';
import { dailyRollup } from './ledger';
import { refreshInsiders } from '../outlook/sources';
const countFx = (env: Env) => env.DB.prepare('SELECT COUNT(*) n FROM fx_daily').first<{ n: number }>().then(r => r?.n ?? 0).catch(() => 0);

interface M { fxN?: number; insDay?: string; wxTry?: number; bfTry?: number; featDay?: string; rollDay?: string; gate?: Record<string, string>; last?: { job: string; at: number; out: string }[] }
const today = () => new Date().toISOString().slice(0, 10);

export async function maintenance(env: Env, force?: string): Promise<{ job: string; out: string }> {
  const cache = new AppCache(env);
  const st: M = (await cache.read<M>('maint:state'))?.v ?? {};
  st.gate ??= {}; st.last ??= [];
  const done = async (job: string, out: unknown) => {
    const o = typeof out === 'string' ? out : JSON.stringify(out).slice(0, 300);
    st.last = [{ job, at: Date.now(), out: o }, ...(st.last ?? [])].slice(0, 20);
    await cache.write('maint:state', st, 30 * 86400);
    return { job, out: o };
  };
  try {
    const d = today();
    const wx = (await cache.read<WxHist>('wx:hist'))?.v;
    // weather never blocks the chain: after a failed try it waits 6 h and the other jobs run (weather columns stay empty)
    if (force === 'weather' || ((!wx || Date.now() - wx.built > 7 * 864e5) && Date.now() - (st.wxTry ?? 0) > 6 * 36e5)) {
      st.wxTry = Date.now();
      try { return done('weather', await rebuildWeather(env, true)); } catch (e) { return done('weather-failed', String((e as Error)?.message ?? e).slice(0, 160)); }
    }
    // bounded count (reads ≤ 200 rows), not a full COUNT(*) every 10 minutes
    const n = st.fxN ?? (await env.DB.prepare('SELECT COUNT(*) n FROM (SELECT 1 FROM fx_daily LIMIT 200)').first<{ n: number }>().catch(() => null))?.n ?? 0;
    if (force === 'backfill' || (n < 200 && Date.now() - (st.bfTry ?? 0) > 6 * 36e5)) { st.bfTry = Date.now(); const r = await buildFeatures(env, 'backfill'); st.featDay = d; st.fxN = await countFx(env); return done('features-backfill', r); }
    if (n < 120) return { job: 'waiting', out: 'feature table needs warehouse history (backfill retries every 6 h)' };
    if (force === 'features' || st.featDay !== d) {
      try { await topUpWeather(env); } catch { /* yesterday's weather stands */ }
      const r = await buildFeatures(env, 'daily'); st.featDay = d; st.fxN = await countFx(env); return done('features-daily', r);
    }
    const ed = (await cache.read<EvoData>('evo:data'))?.v;
    if (force === 'evodata' || !ed || new Date(ed.built).toISOString().slice(0, 10) !== d) return done('evo-data', await buildEvoData(env));
    if (force === 'rollup' || st.rollDay !== d) { const r = await dailyRollup(env); st.rollDay = d; return done('ledger-rollup', { rows: r.rows }); }
    for (const h of EVO_H) {
      if (force === 'gate:' + h || st.gate[h] !== d) {
        // 8 genomes per slot; the horizon is marked done only when the verdict is in
        const g = await evoGate(env, h); if (g.done) st.gate[h] = d;
        const c = g.champ;
        return done('evo-gate ' + h, c ? { validation: c.vk, test: c.hk, promoted: c.promoted, nTest: c.nHold, inputs: c.genome.mask.reduce((a, b) => a + b, 0) } : g.progress);
      }
    }
    // SEC Form 4 once a day (up to ~20 subrequests): its own slot, never stacked on the hourly probes
    if (force === 'insiders' || st.insDay !== d) { st.insDay = d; return done('sec-form4', await refreshInsiders(env)); }
    return { job: 'idle', out: 'all daily jobs done' };
  } catch (e) {
    return done('error', String((e as Error)?.message ?? e).slice(0, 200));
  }
}

export async function maintState(env: Env) { return (await new AppCache(env).read<M>('maint:state'))?.v ?? {}; }
