import type { Env } from '../types';
import { fetchJson, secret } from './provider';

/* EIA — energy stocks + retail fuel prices. Key already sits UNUSED in your
   Secrets Store (EIA_API_KEY). Uses the classic v1 /series/ endpoint.
   VERIFY: if a series 404s (EIA occasionally retires v1 IDs), find the
   current ID at eia.gov → "Series & Data" and edit the map below.
   Per-series allSettled: a failing series is DROPPED, never fabricated. */

export interface EiaRow { label: string; value: number; unit: string; asOf: string; change: number | null }

const SERIES: { label: string; id: string; unit: string }[] = [
  { label: 'Crude Oil Stocks (US, weekly)', id: 'PET.WCRSTUS1.W', unit: 'k bbl' },            // VERIFY id
  { label: 'Regular Gasoline Retail (US)', id: 'PET.EMM_EPMR_PTE_NUS_DPG.W', unit: '$/gal' },  // VERIFY id
  { label: 'No.2 Diesel Retail (US)', id: 'PET.EER_EPD2DXL0_PF4_RGC_DPG.W', unit: '$/gal' },   // VERIFY id
];

export async function eiaRows(env: Env): Promise<EiaRow[]> {
  const key = secret(env, 'EIA_API_KEY');
  if (!key) throw new Error('EIA_API_KEY not configured');
  const settled = await Promise.allSettled(SERIES.map(async (s) => {
    const j: any = await fetchJson(`https://api.eia.gov/series/?api_key=${key}&series_id=${s.id}`, {}, 9000);
    const data: [string, number][] = j?.series?.[0]?.data ?? [];
    if (!data.length) throw new Error('eia: no data ' + s.id);
    const [date0, v0] = data[0];
    const v1 = data[1]?.[1];
    return { label: s.label, value: v0, unit: s.unit, asOf: date0, change: (isFinite(v1) ? v0 - v1 : null) } as EiaRow;
  }));
  const out = settled.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<EiaRow>).value);
  if (!out.length) throw new Error('eia: all series failed');
  return out;
}
