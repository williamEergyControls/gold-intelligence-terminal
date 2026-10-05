/* ================================================================
   US DROUGHT MONITOR — state percent area by category (USDM data services, no key)
   POLL      one CSV request, all 52 state FIPS, last ~16 days (2 weekly maps)
   EVALUATE  per state: latest + prior map, categorical % (None, D0..D4),
             drought area = D1+D2+D3+D4, DSCI = Σ (k+1)·Dk (0..500)
   PUBLISH   KV 'drought:usdm' (refreshed from the news cron at :32 when > 12 h old)
   CONUS figure = land-area weighted from the state rows (labelled CALC).
   maps are valid Tuesdays, published Thursdays 8:30 ET.
   ================================================================ */
import type { Env } from '../types';

const FIPS = '01,02,04,05,06,08,09,10,11,12,13,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,44,45,46,47,48,49,50,51,53,54,55,56,72';
// census land area, sq mi — weights for the CONUS roll-up
const AREA: Record<string, number> = { AL: 50645, AZ: 113594, AR: 52035, CA: 155779, CO: 103642, CT: 4842, DE: 1949, DC: 61, FL: 53625, GA: 57513,
  ID: 82643, IL: 55519, IN: 35826, IA: 55857, KS: 81759, KY: 39486, LA: 43204, ME: 30843, MD: 9707, MA: 7800, MI: 56539, MN: 79627, MS: 46923,
  MO: 68742, MT: 145546, NE: 76824, NV: 109781, NH: 8953, NJ: 7354, NM: 121298, NY: 47126, NC: 48618, ND: 69001, OH: 40861, OK: 68595, OR: 95988,
  PA: 44743, RI: 1034, SC: 30061, SD: 75811, TN: 41235, TX: 261232, UT: 82170, VT: 9217, VA: 39490, WA: 66456, WV: 24038, WI: 54158, WY: 97093 };

export interface DroughtState { none: number; d0: number; d1: number; d2: number; d3: number; d4: number; drought: number; dsci: number; prevDrought: number | null; prevDsci: number | null }
export interface DroughtData { mapDate: string; validEnd: string | null; states: Record<string, DroughtState>; conus: { drought: number; dsci: number; prevDrought: number | null; d3d4: number } | null; fetchedAt: number; source: string }

const mdY = (t: number) => { const d = new Date(t); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; };

export function parseUsdmCsv(csv: string): DroughtData | null {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const head = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const ix = (n: string) => head.findIndex(h => h.toLowerCase() === n.toLowerCase());
  const iDate = ix('MapDate'), iSt = ix('StateAbbreviation'), iN = ix('None'), i0 = ix('D0'), i1 = ix('D1'), i2 = ix('D2'), i3 = ix('D3'), i4 = ix('D4'), iVe = ix('ValidEnd');
  if (iDate < 0 || iSt < 0 || i4 < 0) return null;
  const by = new Map<string, { date: string; row: number[]; ve: string }[]>();
  for (const ln of lines.slice(1)) {
    const c = ln.split(',').map(x => x.trim().replace(/^"|"$/g, ''));
    const st = c[iSt]; if (!st) continue;
    const row = [iN, i0, i1, i2, i3, i4].map(i => parseFloat(c[i]));
    if (row.some(v => !isFinite(v))) continue;
    const arr = by.get(st) ?? []; arr.push({ date: c[iDate], row, ve: iVe >= 0 ? c[iVe] : '' }); by.set(st, arr);
  }
  const states: Record<string, DroughtState> = {};
  let mapDate = '', validEnd: string | null = null;
  for (const [st, arr] of by) {
    arr.sort((a, b) => b.date.localeCompare(a.date));
    const [n, d0, d1, d2, d3, d4] = arr[0].row;
    const p = arr[1]?.row;
    const dr = (r: number[]) => +(r[2] + r[3] + r[4] + r[5]).toFixed(2);
    const ds = (r: number[]) => Math.round(r[1] * 1 + r[2] * 2 + r[3] * 3 + r[4] * 4 + r[5] * 5);
    states[st] = { none: n, d0, d1, d2, d3, d4, drought: dr(arr[0].row), dsci: ds(arr[0].row), prevDrought: p ? dr(p) : null, prevDsci: p ? ds(p) : null };
    if (arr[0].date > mapDate) { mapDate = arr[0].date; validEnd = arr[0].ve || null; }
  }
  if (!Object.keys(states).length) return null;
  let w = 0, dr = 0, ds = 0, pd = 0, pw = 0, d34 = 0;
  for (const [st, a] of Object.entries(AREA)) {
    const s = states[st]; if (!s) continue;
    w += a; dr += a * s.drought; ds += a * s.dsci; d34 += a * (s.d3 + s.d4);
    if (s.prevDrought != null) { pd += a * s.prevDrought; pw += a; }
  }
  const md = /^\d{8}$/.test(mapDate) ? `${mapDate.slice(0, 4)}-${mapDate.slice(4, 6)}-${mapDate.slice(6)}` : mapDate;
  return {
    mapDate: md, validEnd, states, fetchedAt: Date.now(),
    conus: w ? { drought: +(dr / w).toFixed(1), dsci: Math.round(ds / w), prevDrought: pw ? +(pd / pw).toFixed(1) : null, d3d4: +(d34 / w).toFixed(1) } : null,
    source: 'U.S. Drought Monitor (NDMC · USDA · NOAA) via usdmdataservices.unl.edu',
  };
}

export async function refreshDrought(env: Env, force = false): Promise<{ ok: boolean; mapDate?: string; error?: string }> {
  const cur = await env.CACHE.get('drought:usdm', 'json') as DroughtData | null;
  if (!force && cur && Date.now() - cur.fetchedAt < 12 * 36e5) return { ok: true, mapDate: cur.mapDate };
  try {
    const now = Date.now();
    const u = `https://usdmdataservices.unl.edu/api/StateStatistics/GetDroughtSeverityStatisticsByAreaPercent?aoi=${FIPS}&startdate=${mdY(now - 16 * 864e5)}&enddate=${mdY(now)}&statisticsType=2`;
    const r = await fetch(u, { headers: { accept: 'text/csv', 'user-agent': 'GoldIntelligenceTerminal/3.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = parseUsdmCsv(await r.text());
    if (!d) throw new Error('empty or unexpected CSV');
    await env.CACHE.put('drought:usdm', JSON.stringify(d), { expirationTtl: 14 * 86400 });
    return { ok: true, mapDate: d.mapDate };
  } catch (e) {
    return { ok: false, error: String((e as Error).message).slice(0, 120) };
  }
}

export async function readDrought(env: Env): Promise<DroughtData | null> {
  return await env.CACHE.get('drought:usdm', 'json').catch(() => null) as DroughtData | null;
}
