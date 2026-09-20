import type { Env } from '../types';
import { fetchJson } from './provider';
import { secret } from './provider';

/* WATER — two honest pieces:
   1. NQH2O (Nasdaq Veles California Water Index) via FRED — real $/AF price.
      VERIFY series ID at fred.stlouisfed.org (search "NQH2O").
   2. USGS river gauges — live gage height, labeled INDICATOR (not lake %).
      Find better site IDs at waterdata.usgs.gov → swap into SITES below. */

export interface WaterLevel { site: string; name: string; gageFt: number; ts: number }
export interface WaterPanel { nqH2o: { value: number; prior: number; asOf: string } | null; levels: WaterLevel[] }

const SITES: { id: string; name: string }[] = [
  { id: '09380000', name: 'CO River below Powell (Lees Ferry)' },
  { id: '09419500', name: 'CO River below Mead (Hoover)' },
];

async function usgsGage(id: string, name: string): Promise<WaterLevel> {
  const j: any = await fetchJson(`https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${id}&parameterCd=00065`, {}, 8000);
  const ts = j?.value?.timeSeries?.[0];
  const vals = ts?.values?.[0]?.value ?? [];
  const last = vals[vals.length - 1];
  const v = parseFloat(last?.value);
  if (!isFinite(v)) throw new Error('usgs: no gage ' + id);
  return { site: id, name, gageFt: v, ts: Date.parse(last.dateTime) || Date.now() };
}

export async function waterPanel(env: Env): Promise<WaterPanel> {
  let nqH2o: WaterPanel['nqH2o'] = null;
  try {
    const key = secret(env, 'FRED_API_KEY');
    if (key) {
      const j: any = await fetchJson(`https://api.stlouisfed.org/fred/series/observations?series_id=NQH2O&api_key=${key}&file_type=json&sort_order=desc&limit=4`, {}, 9000);
      const obs = (j?.observations ?? []).filter((o: any) => o.value !== '.');
      if (obs.length >= 2) {
        nqH2o = { value: parseFloat(obs[0].value), prior: parseFloat(obs[1].value), asOf: obs[0].date };
      }
    }
  } catch { /* NQH2O optional — levels still render */ }
  const settled = await Promise.allSettled(SITES.map(s => usgsGage(s.id, s.name)));
  const levels = settled.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<WaterLevel>).value);
  return { nqH2o, levels };
}
