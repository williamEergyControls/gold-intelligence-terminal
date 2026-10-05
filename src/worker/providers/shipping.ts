/* ================================================================
   SHIPPING — world map data. every number carries its source + as-of.
   POLL (page build, cached 15 min; sub-caches below)
     IMF PortWatch  daily chokepoint transits, 28 straits × 35 days   (KV 6 h)
     IMF PortWatch  top-25 ports by vessel traffic + daily port calls  (lookup 30 d, data 6 h)
     Open-Meteo     sea state at the 8 main chokepoints (1 call)       (page ttl)
     Yahoo          freight & shipping proxies (BDRY, BWET, ZIM ...)   (page ttl)
     Drewry WCI     composite + lanes scraped from the weekly note     (KV 12 h, dated fallback)
   EVALUATE 7-day avg vs prior 28-day avg per chokepoint/port → % change
   PUBLISH  /api/page/shipping
   ================================================================ */
import type { Env } from '../types';
import { fetchJson } from './provider';
import { yahooBatchQuotes } from './yahoo';

const PW = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services';
const DAY = 864e5;
// PortWatch chokepoint lookup layer (lat, lon), verified 2026-10-02
export const CHOKE: Record<string, { name: string; lat: number; lon: number; major?: boolean }> = {
  chokepoint1: { name: 'Suez Canal', lat: 30.59, lon: 32.44, major: true }, chokepoint2: { name: 'Panama Canal', lat: 9.12, lon: -79.77, major: true },
  chokepoint3: { name: 'Bosporus', lat: 41.17, lon: 29.09 }, chokepoint4: { name: 'Bab el-Mandeb', lat: 12.79, lon: 43.35, major: true },
  chokepoint5: { name: 'Strait of Malacca', lat: 1.52, lon: 102.67, major: true }, chokepoint6: { name: 'Strait of Hormuz', lat: 26.30, lon: 56.86, major: true },
  chokepoint7: { name: 'Cape of Good Hope', lat: -34.93, lon: 20.88, major: true }, chokepoint8: { name: 'Gibraltar', lat: 35.94, lon: -5.75, major: true },
  chokepoint9: { name: 'Dover Strait', lat: 51.03, lon: 1.51, major: true }, chokepoint10: { name: 'Øresund', lat: 55.51, lon: 12.85 },
  chokepoint11: { name: 'Taiwan Strait', lat: 24.72, lon: 119.83 }, chokepoint12: { name: 'Korea Strait', lat: 34.13, lon: 129.21 },
  chokepoint13: { name: 'Tsugaru Strait', lat: 41.33, lon: 140.35 }, chokepoint14: { name: 'Luzon Strait', lat: 20.49, lon: 121.35 },
  chokepoint15: { name: 'Lombok Strait', lat: -8.42, lon: 115.80 }, chokepoint16: { name: 'Ombai Strait', lat: -8.40, lon: 125.09 },
  chokepoint17: { name: 'Bohai Strait', lat: 38.37, lon: 120.90 }, chokepoint18: { name: 'Torres Strait', lat: -9.86, lon: 142.25 },
  chokepoint19: { name: 'Sunda Strait', lat: -5.97, lon: 105.78 }, chokepoint20: { name: 'Makassar Strait', lat: 0.35, lon: 119.26 },
  chokepoint21: { name: 'Magellan Strait', lat: -52.64, lon: -69.59 }, chokepoint22: { name: 'Yucatan Channel', lat: 21.82, lon: -85.65 },
  chokepoint23: { name: 'Windward Passage', lat: 19.99, lon: -73.70 }, chokepoint24: { name: 'Mona Passage', lat: 18.45, lon: -67.71 },
  chokepoint25: { name: 'Balabac Strait', lat: 7.41, lon: 117.11 }, chokepoint26: { name: 'Bering Strait', lat: 65.97, lon: -165.55 },
  chokepoint27: { name: 'Mindoro Strait', lat: 12.47, lon: 120.40 }, chokepoint28: { name: 'Kerch Strait', lat: 45.27, lon: 36.54 },
};
const PROXIES: { sym: string; name: string; kind: string }[] = [
  { sym: 'BDRY', name: 'Dry bulk freight ETF', kind: 'Dry bulk' },
  { sym: 'BWET', name: 'Tanker freight ETF', kind: 'Tankers' },
  { sym: 'ZIM', name: 'ZIM Integrated Shipping', kind: 'Containers' },
  { sym: 'MATX', name: 'Matson', kind: 'Containers' },
  { sym: 'SBLK', name: 'Star Bulk Carriers', kind: 'Dry bulk' },
  { sym: 'FRO', name: 'Frontline', kind: 'Tankers' },
  { sym: 'BZ=F', name: 'Brent crude (bunker cost driver)', kind: 'Fuel' },
];
// Drewry WCI, note of 1 Oct 2026 — used until a newer note is scraped
const WCI_REF = {
  composite: 4434, chgPct: -1, asOf: '2026-10-01', source: 'Drewry World Container Index (weekly note, 1 Oct 2026)',
  lanes: [
    { key: 'SHA-NYC', from: 'Shanghai', to: 'New York', usd: 10428, chgPct: 1 },
    { key: 'SHA-LAX', from: 'Shanghai', to: 'Los Angeles', usd: 7835, chgPct: 0 },
    { key: 'SHA-GOA', from: 'Shanghai', to: 'Genoa', usd: 3702, chgPct: -3 },
    { key: 'SHA-RTM', from: 'Shanghai', to: 'Rotterdam', usd: 3399, chgPct: -2 },
  ],
};
const INDICES_REF = [
  { label: 'Baltic Dry Index', value: 3148, unit: 'index', asOf: '2026-10-02', source: 'Baltic Exchange via Trading Economics (reference)' },
  { label: 'Freightos FBX global', value: 3499, unit: '$/FEU', asOf: '2026-09-14', source: 'Freightos via Container News (reference)' },
];

export interface ChokeOut { id: string; name: string; lat: number; lon: number; major: boolean; date: string | null; total: number | null; container: number | null; tanker: number | null; dryBulk: number | null; avg7: number | null; prev28: number | null; chgPct: number | null; series: number[]; wave?: number | null; swell?: number | null; current?: number | null }
export interface PortOut { id: string; name: string; country: string; lat: number; lon: number; calls7: number | null; prev28: number | null; chgPct: number | null; import7: number | null; export7: number | null; date: string | null }
export interface ShippingPanel {
  builtAt: number;
  proxies: { sym: string; name: string; kind: string; price: number; changePct: number | null }[];
  chokepoints: ChokeOut[]; chokeAsOf: string | null; chokeSource: string;
  ports: PortOut[]; portsAsOf: string | null;
  marineAsOf: number | null;
  wci: { composite: number; chgPct: number | null; asOf: string; live: boolean; lanes: { key: string; from: string; to: string; usd: number; chgPct: number | null; asOf: string }[]; source: string };
  indices: typeof INDICES_REF;
  errors: string[];
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
async function kvWrap<T>(env: Env, key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const cur = await env.CACHE.get(key, 'json').catch(() => null) as { ts: number; v: T } | null;
  if (cur && Date.now() - cur.ts < ttlSec * 1000) return cur.v;
  try {
    const v = await fn();
    await env.CACHE.put(key, JSON.stringify({ ts: Date.now(), v }), { expirationTtl: Math.max(ttlSec * 4, 3600) }).catch(() => { });
    return v;
  } catch (e) {
    if (cur) return cur.v;     // stale beats nothing; the as-of date travels with it
    throw e;
  }
}
function avgWin(series: { d: string; n: number }[], fromEnd: number, len: number): number | null {
  const s = series.slice(Math.max(0, series.length - fromEnd - len), series.length - fromEnd);
  return s.length ? s.reduce((a, b) => a + b.n, 0) / s.length : null;
}

async function portwatchChoke(): Promise<{ rows: any[]; asOf: string | null }> {
  const since = iso(Date.now() - 36 * DAY);
  const q = new URLSearchParams({
    where: `date >= DATE '${since}'`, outFields: 'date,portid,portname,n_total,n_container,n_tanker,n_dry_bulk',
    orderByFields: 'date ASC', resultRecordCount: '1000', returnGeometry: 'false', f: 'json',
  });
  const j = await fetchJson(`${PW}/Daily_Chokepoints_Data/FeatureServer/0/query?${q}`, {}, 12000);
  const rows = (j?.features ?? []).map((f: any) => f.attributes).filter((a: any) => a && a.portid && a.date);
  if (!rows.length) throw new Error('portwatch chokepoints: no rows');
  return { rows, asOf: rows.reduce((m: string, r: any) => (String(r.date) > m ? String(r.date) : m), '') || null };
}
async function portwatchTopPorts(): Promise<{ id: string; name: string; country: string; lat: number; lon: number }[]> {
  const q = new URLSearchParams({ where: '1=1', outFields: 'portid,portname,country,lat,lon,vessel_count_total', orderByFields: 'vessel_count_total DESC', resultRecordCount: '25', returnGeometry: 'false', f: 'json' });
  const j = await fetchJson(`${PW}/PortWatch_ports_database/FeatureServer/0/query?${q}`, {}, 12000);
  const out = (j?.features ?? []).map((f: any) => f.attributes).filter((a: any) => a?.portid && isFinite(a.lat) && isFinite(a.lon))
    .map((a: any) => ({ id: String(a.portid), name: String(a.portname), country: String(a.country ?? ''), lat: +a.lat, lon: +a.lon }));
  if (!out.length) throw new Error('portwatch ports lookup: empty');
  return out;
}
async function portwatchPortDaily(ids: string[]): Promise<any[]> {
  const since = iso(Date.now() - 36 * DAY);
  const q = new URLSearchParams({
    where: `portid IN (${ids.map(i => `'${i.replace(/'/g, '')}'`).join(',')}) AND date >= DATE '${since}'`,
    outFields: 'date,portid,portcalls,import,export', orderByFields: 'date ASC', resultRecordCount: '1000', returnGeometry: 'false', f: 'json',
  });
  const j = await fetchJson(`${PW}/Daily_Ports_Data/FeatureServer/0/query?${q}`, {}, 12000);
  return (j?.features ?? []).map((f: any) => f.attributes).filter((a: any) => a?.portid && a.date);
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function parseDrewry(html: string): { composite: number; chgPct: number | null; asOf: string; lanes: { key: string; usd: number; chgPct: number | null }[] } | null {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const comp = /World Container Index[^.]{0,80}?\b(increased|decreased|rose|fell|remained|was)\b[^.]{0,40}?(?:(\d+(?:\.\d+)?)%\s*)?to \$([\d,]+) per 40ft/i.exec(text);
  const dt = /assessment for \w+day,? (\d{1,2}) (\w+) (\d{4})/i.exec(text);
  if (!comp || !dt) return null;
  const m = MONTHS[dt[2].slice(0, 3).toLowerCase()];
  if (m == null) return null;
  const asOf = iso(Date.UTC(+dt[3], m, +dt[1]));
  const sign = /decreased|fell/i.test(comp[1]) ? -1 : 1;
  const lanes: { key: string; usd: number; chgPct: number | null }[] = [];
  const LK: Record<string, string> = { 'new york': 'SHA-NYC', 'los angeles': 'SHA-LAX', genoa: 'SHA-GOA', rotterdam: 'SHA-RTM' };
  const re = /Shanghai to (New York|Los Angeles|Genoa|Rotterdam)[^$]{0,90}?(?:(increased|decreased|rose|fell|dropped|climbed)[^$]{0,20}?(\d+(?:\.\d+)?)%)?[^$]{0,30}?\$([\d,]+)/gi;
  let x: RegExpExecArray | null;
  while ((x = re.exec(text))) {
    const key = LK[x[1].toLowerCase()];
    if (!key || lanes.some(l => l.key === key)) continue;
    const s = x[2] ? (/decreased|fell|dropped/i.test(x[2]) ? -1 : 1) : 1;
    lanes.push({ key, usd: parseInt(x[4].replace(/,/g, ''), 10), chgPct: x[3] ? s * parseFloat(x[3]) : null });
  }
  return { composite: parseInt(comp[3].replace(/,/g, ''), 10), chgPct: comp[2] ? sign * parseFloat(comp[2]) : (/remained|was/i.test(comp[1]) ? 0 : null), asOf, lanes };
}
async function drewry(): Promise<ReturnType<typeof parseDrewry>> {
  const r = await fetch('https://www.drewry.co.uk/supply-chain-advisors/supply-chain-expertise/world-container-index-assessed-by-drewry', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; GoldIntelligenceTerminal/3.0)' } });
  if (!r.ok) throw new Error('drewry HTTP ' + r.status);
  const p = parseDrewry((await r.text()).slice(0, 800000));
  if (!p) throw new Error('drewry: pattern not found');
  return p;
}

export async function buildShippingPanel(env: Env): Promise<ShippingPanel> {
  const errors: string[] = [];
  const [cp, top, prox, wci] = await Promise.allSettled([
    kvWrap(env, 'ship:choke', 6 * 3600, portwatchChoke),
    kvWrap(env, 'ship:ports:lookup', 30 * 86400, portwatchTopPorts),
    yahooBatchQuotes(PROXIES.map(p => p.sym)),
    kvWrap(env, 'ship:wci', 12 * 3600, drewry),
  ]);

  /* ---- chokepoints ---- */
  const chokepoints: ChokeOut[] = [];
  let chokeAsOf: string | null = null;
  if (cp.status === 'fulfilled') {
    chokeAsOf = cp.value.asOf;
    const by = new Map<string, any[]>();
    for (const r of cp.value.rows) { const a = by.get(r.portid) ?? []; a.push(r); by.set(r.portid, a); }
    for (const [id, meta] of Object.entries(CHOKE)) {
      const rows = (by.get(id) ?? []).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const ser = rows.map(r => ({ d: String(r.date), n: Number(r.n_total) || 0 }));
      const last = rows.at(-1);
      const avg7 = avgWin(ser, 0, 7), prev28 = avgWin(ser, 7, 28);
      chokepoints.push({
        id, name: meta.name, lat: meta.lat, lon: meta.lon, major: !!meta.major, date: last ? String(last.date) : null,
        total: last ? Number(last.n_total) : null, container: last ? Number(last.n_container) : null, tanker: last ? Number(last.n_tanker) : null, dryBulk: last ? Number(last.n_dry_bulk) : null,
        avg7: avg7 != null ? +avg7.toFixed(1) : null, prev28: prev28 != null ? +prev28.toFixed(1) : null,
        chgPct: avg7 != null && prev28 ? +((avg7 / prev28 - 1) * 100).toFixed(1) : null,
        series: ser.slice(-35).map(s => s.n),
      });
    }
  } else errors.push('portwatch chokepoints: ' + String((cp.reason as Error)?.message ?? cp.reason).slice(0, 100));

  /* ---- ports ---- */
  let ports: PortOut[] = [];
  let portsAsOf: string | null = null;
  if (top.status === 'fulfilled') {
    try {
      const daily = await kvWrap(env, 'ship:ports:daily', 6 * 3600, () => portwatchPortDaily(top.value.map(p => p.id)));
      const by = new Map<string, any[]>();
      for (const r of daily) { const a = by.get(r.portid) ?? []; a.push(r); by.set(r.portid, a); }
      ports = top.value.map(p => {
        const rows = (by.get(p.id) ?? []).sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const ser = rows.map(r => ({ d: String(r.date), n: Number(r.portcalls) || 0 }));
        const c7 = avgWin(ser, 0, 7), p28 = avgWin(ser, 7, 28);
        const sum7 = (k: string) => rows.slice(-7).reduce((s, r) => s + (Number(r[k]) || 0), 0);
        const d = rows.at(-1)?.date ? String(rows.at(-1).date) : null;
        if (d && (!portsAsOf || d > portsAsOf)) portsAsOf = d;
        return { ...p, calls7: c7 != null ? +(c7 * 7).toFixed(0) : null, prev28: p28 != null ? +(p28 * 7).toFixed(0) : null, chgPct: c7 != null && p28 ? +((c7 / p28 - 1) * 100).toFixed(1) : null, import7: rows.length ? Math.round(sum7('import')) : null, export7: rows.length ? Math.round(sum7('export')) : null, date: d };
      });
    } catch (e) { errors.push('portwatch ports: ' + String((e as Error).message).slice(0, 100)); ports = top.value.map(p => ({ ...p, calls7: null, prev28: null, chgPct: null, import7: null, export7: null, date: null })); }
  } else errors.push('portwatch ports lookup: ' + String((top.reason as Error)?.message ?? top.reason).slice(0, 100));

  /* ---- sea state at the main chokepoints (one call, many points) ---- */
  let marineAsOf: number | null = null;
  const majors = chokepoints.filter(c => c.major);
  const pts = majors.length ? majors : Object.entries(CHOKE).filter(([, v]) => v.major).map(([id, v]) => ({ id, ...v } as any));
  try {
    const j = await fetchJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${pts.map(p => p.lat).join(',')}&longitude=${pts.map(p => p.lon).join(',')}&current=wave_height,swell_wave_height,ocean_current_velocity&cell_selection=sea`, {}, 9000);
    const arr = Array.isArray(j) ? j : [j];
    arr.forEach((r: any, i: number) => {
      const c = chokepoints.find(x => x.id === pts[i]?.id);
      if (!c || !r?.current) return;
      c.wave = r.current.wave_height ?? null; c.swell = r.current.swell_wave_height ?? null;
      c.current = r.current.ocean_current_velocity != null ? +(r.current.ocean_current_velocity / 1.852).toFixed(1) : null;   // km/h → kn
    });
    marineAsOf = Date.now();
  } catch (e) { errors.push('open-meteo marine: ' + String((e as Error).message).slice(0, 80)); }

  /* ---- freight proxies ---- */
  const proxies: ShippingPanel['proxies'] = [];
  if (prox.status === 'fulfilled') {
    for (const p of PROXIES) {
      const q = prox.value.find(x => x.symbol === p.sym);
      if (q) proxies.push({ sym: p.sym, name: p.name, kind: p.kind, price: q.price, changePct: q.changePct != null ? +q.changePct.toFixed(2) : null });
    }
  } else errors.push('yahoo proxies: ' + String((prox.reason as Error)?.message ?? prox.reason).slice(0, 80));

  /* ---- container rates ---- */
  let w: ShippingPanel['wci'] = { ...WCI_REF, live: false, lanes: WCI_REF.lanes.map(l => ({ ...l, asOf: WCI_REF.asOf })) };
  if (wci.status === 'fulfilled' && wci.value && wci.value.asOf >= WCI_REF.asOf) {
    const v = wci.value;
    w = {
      composite: v.composite, chgPct: v.chgPct, asOf: v.asOf, live: true, source: 'Drewry World Container Index (scraped weekly note)',
      lanes: WCI_REF.lanes.map(l => { const s = v.lanes.find(x => x.key === l.key); return s ? { ...l, usd: s.usd, chgPct: s.chgPct, asOf: v.asOf } : { ...l, asOf: WCI_REF.asOf }; }),
    };
  } else if (wci.status === 'rejected') errors.push('drewry: ' + String((wci.reason as Error)?.message ?? wci.reason).slice(0, 80));

  return {
    builtAt: Date.now(), proxies, chokepoints, chokeAsOf, chokeSource: 'IMF PortWatch (AIS-based daily transit counts)',
    ports, portsAsOf, marineAsOf, wci: w, indices: INDICES_REF, errors,
  };
}
