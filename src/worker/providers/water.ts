import type { Env } from '../types';
import { fetchJson } from './provider';
import { secret } from './provider';

/* WATER — honest pieces only:
   1. NQH2O (Nasdaq Veles California Water Index) via FRED series NASDAQNQH2O — $/acre-foot, weekly.
   2. USGS instantaneous values, ONE call for all sites: river stage (00065), flow (00060)
      and reservoir elevation (62614 — Lake Mead, Lake Powell). 24 h change from the same pull.
      sites carry lat/lon so the water page can plot them on the US map. */

export interface WaterLevel {
  site: string; name: string; lat: number | null; lon: number | null; kind: 'river' | 'reservoir';
  gageFt: number | null; flowCfs: number | null; elevFt: number | null; chg24: number | null; ts: number;
}
export interface WaterPanel { nqH2o: { value: number; prior: number; asOf: string } | null; levels: WaterLevel[] }

const SITES: { id: string; name: string; kind: 'river' | 'reservoir' }[] = [
  { id: '09379900', name: 'Lake Powell at Glen Canyon Dam', kind: 'reservoir' },
  { id: '09420500', name: 'Lake Mead at Hoover Dam', kind: 'reservoir' },
  { id: '09380000', name: 'Colorado River at Lees Ferry', kind: 'river' },
  { id: '07010000', name: 'Mississippi River at St. Louis', kind: 'river' },
  { id: '07032000', name: 'Mississippi River at Memphis', kind: 'river' },
  { id: '06934500', name: 'Missouri River at Hermann', kind: 'river' },
  { id: '03294500', name: 'Ohio River at Louisville', kind: 'river' },
  { id: '14105700', name: 'Columbia River at The Dalles', kind: 'river' },
  { id: '11447650', name: 'Sacramento River at Freeport', kind: 'river' },
  { id: '08313000', name: 'Rio Grande at Otowi Bridge', kind: 'river' },
];

async function usgsAll(): Promise<WaterLevel[]> {
  const j: any = await fetchJson(`https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${SITES.map(s => s.id).join(',')}&parameterCd=00065,00060,62614&period=P1D&siteStatus=active`, {}, 12000);
  const by = new Map<string, WaterLevel>();
  for (const ts of j?.value?.timeSeries ?? []) {
    const id = ts?.sourceInfo?.siteCode?.[0]?.value;
    const def = SITES.find(s => s.id === id);
    if (!def) continue;
    const code = ts?.variable?.variableCode?.[0]?.value;
    const vals = (ts?.values?.[0]?.value ?? []).map((v: any) => ({ v: parseFloat(v.value), t: Date.parse(v.dateTime) })).filter((p: any) => isFinite(p.v) && p.v > -999990);
    if (!vals.length) continue;
    const last = vals[vals.length - 1], first = vals[0];
    const geo = ts?.sourceInfo?.geoLocation?.geogLocation;
    const row = by.get(id) ?? { site: id, name: def.name, kind: def.kind, lat: geo?.latitude ?? null, lon: geo?.longitude ?? null, gageFt: null, flowCfs: null, elevFt: null, chg24: null, ts: last.t };
    if (code === '00065') { row.gageFt = last.v; if (def.kind === 'river') row.chg24 = +(last.v - first.v).toFixed(2); }
    if (code === '00060') row.flowCfs = last.v;
    if (code === '62614') { row.elevFt = last.v; row.chg24 = +(last.v - first.v).toFixed(2); }
    row.ts = Math.max(row.ts, last.t);
    by.set(id, row);
  }
  const out = SITES.map(s => by.get(s.id)).filter((x): x is WaterLevel => !!x);
  if (!out.length) throw new Error('usgs: no sites returned');
  return out;
}

export async function waterPanel(env: Env): Promise<WaterPanel> {
  let nqH2o: WaterPanel['nqH2o'] = null;
  try {
    const key = secret(env, 'FRED_API_KEY');
    if (key) {
      const j: any = await fetchJson(`https://api.stlouisfed.org/fred/series/observations?series_id=NASDAQNQH2O&api_key=${key}&file_type=json&sort_order=desc&limit=4`, {}, 9000);
      const obs = (j?.observations ?? []).filter((o: any) => o.value !== '.');
      if (obs.length >= 2) nqH2o = { value: parseFloat(obs[0].value), prior: parseFloat(obs[1].value), asOf: obs[0].date };
    }
  } catch { /* NQH2O optional — levels still render */ }
  let levels: WaterLevel[] = [];
  try { levels = await usgsAll(); } catch { levels = []; }
  return { nqH2o, levels };
}
