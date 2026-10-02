import type { Env } from '../types';
import { fetchJson, secret } from './provider';

/* EIA — energy stocks + retail fuel prices.
   EIA retired API v1 (/series/). v2 keeps a backward-compatible route that
   accepts the old v1 series IDs:  https://api.eia.gov/v2/seriesid/{V1_ID}?api_key=
   rows live in response.data[] as { period, value, ... } (value may be a string).
   Per-series allSettled: a failing series is DROPPED, never fabricated. */

export interface EiaRow { label: string; value: number; unit: string; asOf: string; change: number | null; seriesId: string }

export const EIA_SERIES: { label: string; id: string; unit: string }[] = [
  { label: 'Crude Oil Stocks (US, weekly)', id: 'PET.WCRSTUS1.W', unit: 'k bbl' },
  { label: 'Regular Gasoline Retail (US)', id: 'PET.EMM_EPMR_PTE_NUS_DPG.W', unit: '$/gal' },
  { label: 'No.2 Diesel Retail (US)', id: 'PET.EMD_EPD2D_PTE_NUS_DPG.W', unit: '$/gal' },
];

export async function eiaSeriesTail(env: Env, id: string, n = 2): Promise<{ period: string; value: number }[]> {
  const key = secret(env, 'EIA_API_KEY');
  if (!key) throw new Error('EIA_API_KEY not configured');
  const j: any = await fetchJson(`https://api.eia.gov/v2/seriesid/${encodeURIComponent(id)}?api_key=${key}`, {}, 9000);
  const rows: { period: string; value: number }[] = (j?.response?.data ?? [])
    .map((r: any) => ({ period: String(r?.period ?? ''), value: Number(r?.value) }))
    .filter((r: { period: string; value: number }) => r.period && isFinite(r.value))
    .sort((a: { period: string }, b: { period: string }) => (a.period < b.period ? 1 : -1)); // newest first
  if (!rows.length) throw new Error('eia: no data ' + id);
  return rows.slice(0, n);
}

export async function eiaRows(env: Env): Promise<EiaRow[]> {
  const settled = await Promise.allSettled(EIA_SERIES.map(async (s) => {
    const [r0, r1] = await eiaSeriesTail(env, s.id, 2);
    return { label: s.label, value: r0.value, unit: s.unit, asOf: r0.period, change: r1 ? r0.value - r1.value : null, seriesId: s.id } as EiaRow;
  }));
  const out = settled.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<EiaRow>).value);
  if (!out.length) {
    const why = settled.map(r => r.status === 'rejected' ? String((r.reason as Error)?.message ?? r.reason).slice(0, 80) : '').filter(Boolean).join(' | ');
    throw new Error('eia: all series failed — ' + why);
  }
  return out;
}
