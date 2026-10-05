/* ================================================================
   ECONOMIC CALENDAR — real dates, every event says where it came from.
   sources:
     FRED release calendar (11 releases, future dates included)   → confirmed
     FOMC 2026-27 + ECB 2026-27 + WASDE 2026 published schedules  → confirmed
     weekly rules (EIA, drought monitor, CFTC, USDA)               → est. (holiday shift)
   cycle: refreshFred() from the news cron at :32 when the copy is > 20 h old
          (11 FRED calls in their own invocation). readers do one KV read.
   times are stored as UTC ms; the browser formats them in the viewer's zone.
   ================================================================ */
import type { Env } from './types';
import { secret } from './providers/provider';
import { readSeries } from './store/ingest';
import { monthlyYoY } from './analytics/vol';

export interface CalEvent {
  id: string; date: string; ts: number; title: string; detail: string; kind: string;
  imp: 'h' | 'm' | 'l'; scope: string[]; src: string; est: boolean; last?: string;
}
type Rel = { rid: number; title: string; kind: string; imp: 'h' | 'm' | 'l'; hh: number; mm: number; scope: string[]; detail: string };
const RELEASES: Rel[] = [
  { rid: 10, title: 'CPI inflation', kind: 'cpi', imp: 'h', hh: 8, mm: 30, scope: ['macro', 'gold', 'fx'], detail: 'BLS consumer prices, headline and core' },
  { rid: 50, title: 'Jobs report (payrolls)', kind: 'jobs', imp: 'h', hh: 8, mm: 30, scope: ['macro', 'gold', 'fx'], detail: 'BLS employment situation' },
  { rid: 54, title: 'PCE inflation', kind: 'pce', imp: 'h', hh: 8, mm: 30, scope: ['macro', 'gold', 'fx'], detail: 'BEA personal income and outlays' },
  { rid: 53, title: 'GDP', kind: 'gdp', imp: 'm', hh: 8, mm: 30, scope: ['macro', 'gold', 'fx'], detail: 'BEA gross domestic product' },
  { rid: 46, title: 'PPI', kind: 'ppi', imp: 'm', hh: 8, mm: 30, scope: ['macro', 'gold'], detail: 'BLS producer prices' },
  { rid: 9, title: 'Retail sales', kind: 'retail', imp: 'm', hh: 8, mm: 30, scope: ['macro', 'fx'], detail: 'Census advance retail and food services' },
  { rid: 192, title: 'JOLTS job openings', kind: 'jolts', imp: 'm', hh: 10, mm: 0, scope: ['macro'], detail: 'BLS job openings and labor turnover' },
  { rid: 180, title: 'Jobless claims', kind: 'claims', imp: 'l', hh: 8, mm: 30, scope: ['macro'], detail: 'DOL weekly initial claims' },
  { rid: 91, title: 'UMich consumer sentiment', kind: 'umich', imp: 'l', hh: 10, mm: 0, scope: ['macro'], detail: 'Surveys of Consumers incl. inflation expectations' },
  { rid: 13, title: 'Industrial production', kind: 'ip', imp: 'l', hh: 9, mm: 15, scope: ['macro', 'energy'], detail: 'Fed G.17' },
  { rid: 27, title: 'Housing starts', kind: 'housing', imp: 'l', hh: 8, mm: 30, scope: ['macro', 'land'], detail: 'Census new residential construction' },
];
// federalreserve.gov/monetarypolicy/fomccalendars.htm (decision day = 2nd day, 14:00 ET); * = projections (SEP)
const FOMC = ['2026-01-28', '2026-03-18*', '2026-04-29', '2026-06-17*', '2026-07-29', '2026-09-16*', '2026-10-28', '2026-12-09*',
  '2027-01-27', '2027-03-17*', '2027-04-28', '2027-06-09*', '2027-07-28', '2027-09-15*', '2027-10-27', '2027-12-08*'];
// ecb.europa.eu monetary policy decision days (14:15 CET/CEST)
const ECB = ['2026-02-05', '2026-03-19', '2026-04-30', '2026-06-11', '2026-07-23', '2026-09-10', '2026-10-29', '2026-12-17',
  '2027-02-04', '2027-03-18', '2027-04-29', '2027-06-10', '2027-07-22', '2027-09-09', '2027-10-28', '2027-12-16'];
// usda.gov/oce/commodity/wasde (12:00 ET)
const WASDE = ['2026-10-09', '2026-11-10', '2026-12-10'];   // 2027 dates not published yet (checked 2026-10-02)

/* ---------- time zone math (no Intl tz dependency for the rules) ---------- */
const ymd = (d: Date) => d.toISOString().slice(0, 10);
function nthDow(y: number, m: number, dow: number, n: number): number { // day-of-month of nth weekday (n<0 = last)
  if (n > 0) { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + ((dow - first + 7) % 7) + (n - 1) * 7; }
  const last = new Date(Date.UTC(y, m + 1, 0)); return last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7);
}
function usDst(y: number, m: number, d: number): boolean {
  const start = Date.UTC(y, 2, nthDow(y, 2, 0, 2)), end = Date.UTC(y, 10, nthDow(y, 10, 0, 1)), t = Date.UTC(y, m, d);
  return t >= start && t < end;
}
function euDst(y: number, m: number, d: number): boolean {
  const start = Date.UTC(y, 2, nthDow(y, 2, 0, -1)), end = Date.UTC(y, 9, nthDow(y, 9, 0, -1)), t = Date.UTC(y, m, d);
  return t >= start && t < end;
}
function etUtc(date: string, hh: number, mm: number): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh + (usDst(y, m - 1, d) ? 4 : 5), mm);
}
function cetUtc(date: string, hh: number, mm: number): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh - (euDst(y, m - 1, d) ? 2 : 1), mm);
}
function usHolidays(y: number): Set<string> {
  const f = (m: number, d: number) => ymd(new Date(Date.UTC(y, m, d)));
  const obs = (m: number, d: number) => { const w = new Date(Date.UTC(y, m, d)).getUTCDay(); return f(m, w === 6 ? d - 1 : w === 0 ? d + 1 : d); };
  return new Set([obs(0, 1), f(0, nthDow(y, 0, 1, 3)), f(1, nthDow(y, 1, 1, 3)), f(4, nthDow(y, 4, 1, -1)), obs(5, 19), obs(6, 4),
    f(8, nthDow(y, 8, 1, 1)), f(9, nthDow(y, 9, 1, 2)), obs(10, 11), f(10, nthDow(y, 10, 4, 4)), obs(11, 25)]);
}

/* weekly rule: weekday dow at hh:mm ET.
   mid-week releases: a holiday earlier in that week (or on the day) shifts it one day later.
   friday releases: a friday holiday pulls it to thursday; 'cot' moves to the next monday
   when any weekday of that week is a holiday (CFTC practice). */
function weekly(from: number, to: number, dow: number, hh: number, mm: number, months?: number[], mode: 'std' | 'cot' = 'std'): string[] {
  const out: string[] = [];
  for (let t = from; t <= to; t += 864e5) {
    const d = new Date(t);
    if (d.getUTCDay() !== dow) continue;
    if (months && !months.includes(d.getUTCMonth())) continue;
    const hol = usHolidays(d.getUTCFullYear());
    let shift = 0;
    if (dow === 5) {
      const weekHol = [4, 3, 2, 1, 0].some(k => hol.has(ymd(new Date(t - k * 864e5))));
      if (mode === 'cot' && weekHol) shift = 3;
      else if (hol.has(ymd(d))) shift = -1;
    } else {
      for (let k = 1; k <= dow; k++) { const back = ymd(new Date(t - (dow - k) * 864e5)); if (hol.has(back)) shift = 1; }
    }
    out.push(ymd(new Date(t + shift * 864e5)));
  }
  return out;
}

/* ---------- FRED refresh (cron) ---------- */
export async function refreshFred(env: Env, force = false): Promise<{ ok: number; errors: string[] }> {
  const cur = await env.CACHE.get('cal:fred', 'json') as { ts: number } | null;
  if (!force && cur && Date.now() - cur.ts < 20 * 36e5) return { ok: 0, errors: [] };
  const key = secret(env, 'FRED_API_KEY');
  if (!key) return { ok: 0, errors: ['FRED_API_KEY not bound'] };
  const start = ymd(new Date(Date.now() - 45 * 864e5));
  const dates: Record<number, string[]> = {};
  const errors: string[] = [];
  for (const r of RELEASES) {   // sequential: FRED allows 120/min, no need to burst
    try {
      const u = `https://api.stlouisfed.org/fred/release/dates?release_id=${r.rid}&realtime_start=${start}&realtime_end=9999-12-31&include_release_dates_with_no_data=true&sort_order=asc&limit=60&file_type=json&api_key=${key}`;
      const res = await fetch(u, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j: any = await res.json();
      dates[r.rid] = ((j?.release_dates ?? []) as { date: string }[]).map(x => x.date).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    } catch (e) { errors.push(r.rid + ': ' + String((e as Error).message).slice(0, 80)); }
  }
  const ok = Object.keys(dates).length;
  if (ok) await env.CACHE.put('cal:fred', JSON.stringify({ ts: Date.now(), dates, errors }), { expirationTtl: 5 * 86400 });
  return { ok, errors };
}

/* ---------- build ---------- */
let memo: { ts: number; v: { events: CalEvent[]; fredAsOf: number | null; notes: string[] } } | null = null;
export async function calendar(env: Env): Promise<{ events: CalEvent[]; fredAsOf: number | null; notes: string[] }> {
  if (memo && Date.now() - memo.ts < 10 * 60000) return memo.v;
  const now = Date.now();
  const from = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 1);
  const to = now + 100 * 864e5;
  const inRange = (d: string) => { const t = Date.parse(d + 'T12:00:00Z'); return t >= from && t <= to; };
  const ev: CalEvent[] = [];
  const notes: string[] = [];

  const fred = await env.CACHE.get('cal:fred', 'json').catch(() => null) as { ts: number; dates: Record<number, string[]> } | null;
  // last prints from the warehouse (no upstream calls)
  let lastCpi = '', lastFed = '';
  try {
    const s = await readSeries(env, ['CPI_ALL', 'FEDLO', 'FEDHI'], now - 500 * 864e5);
    const y = monthlyYoY(s.CPI_ALL ?? []).at(-1);
    if (y) lastCpi = `last ${y.v.toFixed(1)}% y/y (${new Date(y.t).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })})`;
    const lo = s.FEDLO?.at(-1)?.v, hi = s.FEDHI?.at(-1)?.v;
    if (lo != null && hi != null) lastFed = `target ${lo.toFixed(2)}–${hi.toFixed(2)}%`;
  } catch { /* optional */ }

  for (const r of RELEASES) {
    const ds = fred?.dates?.[r.rid];
    if (!ds) continue;
    for (const d of ds) if (inRange(d)) ev.push({
      id: 'fred' + r.rid + d, date: d, ts: etUtc(d, r.hh, r.mm), title: r.title, detail: r.detail, kind: r.kind, imp: r.imp,
      scope: r.scope, src: 'FRED release calendar', est: false, last: r.kind === 'cpi' ? lastCpi || undefined : undefined,
    });
  }
  if (!fred) {
    notes.push('FRED release dates not loaded yet — jobs and claims shown from weekly rules');
    for (const d of weekly(from, to, 5, 8, 30)) if (Number(d.slice(8)) <= 7) ev.push({ id: 'jobs' + d, date: d, ts: etUtc(d, 8, 30), title: 'Jobs report (payrolls)', detail: 'BLS employment situation (first Friday rule)', kind: 'jobs', imp: 'h', scope: ['macro', 'gold', 'fx'], src: 'rule: first Friday', est: true });
    for (const d of weekly(from, to, 4, 8, 30)) ev.push({ id: 'claims' + d, date: d, ts: etUtc(d, 8, 30), title: 'Jobless claims', detail: 'DOL weekly initial claims', kind: 'claims', imp: 'l', scope: ['macro'], src: 'rule: Thursdays', est: true });
  }
  for (const raw of FOMC) {
    const d = raw.replace('*', ''); if (!inRange(d)) continue;
    const sep = raw.endsWith('*');
    ev.push({ id: 'fomc' + d, date: d, ts: etUtc(d, 14, 0), title: sep ? 'FOMC decision + projections' : 'FOMC decision', detail: 'Rate decision 2:00 pm ET, press conference 2:30 pm' + (sep ? ', dot plot' : ''), kind: 'fomc', imp: 'h', scope: ['macro', 'gold', 'fx'], src: 'federalreserve.gov schedule', est: false, last: lastFed || undefined });
  }
  for (const d of ECB) if (inRange(d)) ev.push({ id: 'ecb' + d, date: d, ts: cetUtc(d, 14, 15), title: 'ECB rate decision', detail: 'Monetary policy statement, press conference 45 min later', kind: 'ecb', imp: 'm', scope: ['macro', 'fx', 'gold'], src: 'ecb.europa.eu schedule', est: false });
  for (const d of WASDE) if (inRange(d)) ev.push({ id: 'wasde' + d, date: d, ts: etUtc(d, 12, 0), title: 'USDA WASDE', detail: 'World agricultural supply and demand estimates', kind: 'wasde', imp: 'h', scope: ['agri', 'land'], src: 'usda.gov schedule', est: false });
  for (const d of weekly(from, to, 3, 10, 30)) ev.push({ id: 'eiap' + d, date: d, ts: etUtc(d, 10, 30), title: 'EIA crude inventories', detail: 'Weekly petroleum status report', kind: 'eia', imp: 'h', scope: ['energy'], src: 'EIA weekly schedule', est: true });
  for (const d of weekly(from, to, 4, 10, 30)) ev.push({ id: 'eiag' + d, date: d, ts: etUtc(d, 10, 30), title: 'EIA natural gas storage', detail: 'Weekly working gas in storage', kind: 'eia', imp: 'm', scope: ['energy'], src: 'EIA weekly schedule', est: true });
  for (const d of weekly(from, to, 5, 13, 0)) ev.push({ id: 'rigs' + d, date: d, ts: etUtc(d, 13, 0), title: 'Baker Hughes rig count', detail: 'US oil and gas rigs', kind: 'rigs', imp: 'l', scope: ['energy'], src: 'Baker Hughes weekly', est: true });
  for (const d of weekly(from, to, 5, 15, 30, undefined, 'cot')) ev.push({ id: 'cot' + d, date: d, ts: etUtc(d, 15, 30), title: 'CFTC positioning (COT)', detail: 'Futures positioning as of Tuesday', kind: 'cot', imp: 'l', scope: ['gold', 'energy', 'agri'], src: 'CFTC weekly', est: true });
  for (const d of weekly(from, to, 4, 8, 30)) ev.push({ id: 'usdm' + d, date: d, ts: etUtc(d, 8, 30), title: 'US Drought Monitor', detail: 'Weekly drought map (data as of Tuesday)', kind: 'drought', imp: 'l', scope: ['water', 'agri'], src: 'droughtmonitor.unl.edu', est: true });
  for (const d of weekly(from, to, 4, 8, 30)) ev.push({ id: 'exs' + d, date: d, ts: etUtc(d, 8, 30), title: 'USDA export sales', detail: 'Weekly export sales', kind: 'usda', imp: 'l', scope: ['agri'], src: 'USDA FAS weekly', est: true });
  for (const d of weekly(from, to, 1, 16, 0, [3, 4, 5, 6, 7, 8, 9, 10])) ev.push({ id: 'cp' + d, date: d, ts: etUtc(d, 16, 0), title: 'USDA crop progress', detail: 'Planting, condition and harvest pace', kind: 'usda', imp: 'm', scope: ['agri'], src: 'USDA NASS weekly (Apr–Nov)', est: true });

  ev.sort((a, b) => a.ts - b.ts);
  const v = { events: ev, fredAsOf: fred?.ts ?? null, notes };
  memo = { ts: Date.now(), v };
  return v;
}
