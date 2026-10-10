/* ================================================================
   TREASURY DESK — curve, spreads, real yields, debt and what it costs
   INIT     warehouse: 11 Treasury tenors (FRED), TIPS 10Y, 10Y breakeven, MOVE, Fed target band
   POLL     Fiscal Data API (no key, ≤ 3 calls per 12 h): debt to the penny, average interest rates, TGA
   EVALUATE curve now vs ~1 month and ~1 year ago · 2s10s + 3m10y history · inversion streaks
            estimated yearly interest = interest-bearing debt × average rate (labelled an estimate)
   PUBLISH  /api/page/treasury (shared D1 cache, 15 min; fiscal block 12 h)
   ================================================================ */
import type { Env } from './types';
import { AppCache } from './cache';
import { readSeries } from './store/ingest';

export const TENORS: { id: string; label: string; yrs: number }[] = [
  { id: 'UST1M', label: '1M', yrs: 1 / 12 }, { id: 'UST3M', label: '3M', yrs: 0.25 }, { id: 'UST6M', label: '6M', yrs: 0.5 },
  { id: 'UST1Y', label: '1Y', yrs: 1 }, { id: 'UST2Y', label: '2Y', yrs: 2 }, { id: 'UST3Y', label: '3Y', yrs: 3 },
  { id: 'UST5Y', label: '5Y', yrs: 5 }, { id: 'UST7Y', label: '7Y', yrs: 7 }, { id: 'UST10Y', label: '10Y', yrs: 10 },
  { id: 'UST20Y', label: '20Y', yrs: 20 }, { id: 'UST30Y', label: '30Y', yrs: 30 },
];
const FD = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service';

type P = { t: number; v: number };
function atOrBefore(pts: P[], t: number): P | null { for (let i = pts.length - 1; i >= 0; i--) if (pts[i].t <= t) return pts[i]; return null; }
function diff(a: P[], b: P[]): P[] { const m = new Map(b.map(p => [p.t, p.v])); const o: P[] = []; for (const p of a) { const q = m.get(p.t); if (q != null) o.push({ t: p.t, v: +(p.v - q).toFixed(3) }); } return o; }

async function fdGet(path: string): Promise<any[]> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(FD + path, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('Fiscal Data HTTP ' + r.status);
    return ((await r.json()) as any)?.data ?? [];
  } finally { clearTimeout(t); }
}

export async function fiscalBlock(env: Env) {
  return (await new AppCache(env).wrap('fiscal:v1', 43200, async () => {
    const enc = encodeURIComponent;
    const [debt, rates, tga] = await Promise.allSettled([
      fdGet('/v2/accounting/od/debt_to_penny?fields=record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt&sort=-record_date&page[size]=520'),
      fdGet('/v2/accounting/od/avg_interest_rates?fields=record_date,security_desc,avg_interest_rate_amt&sort=-record_date&page[size]=200&filter=' +
        enc('security_desc:in:(Treasury Bills,Treasury Notes,Treasury Bonds,Total Marketable,Total Interest-bearing Debt)')),
      fdGet('/v1/accounting/dts/operating_cash_balance?fields=record_date,account_type,open_today_bal&sort=-record_date&page[size]=300&filter=' +
        enc('account_type:eq:Treasury General Account (TGA) Closing Balance')),
    ]);
    const day = (s: string) => Date.parse(s + 'T00:00:00Z');
    const D = debt.status === 'fulfilled' ? debt.value.map(r => ({ t: day(r.record_date), total: Number(r.tot_pub_debt_out_amt), pub: Number(r.debt_held_public_amt), intra: Number(r.intragov_hold_amt) })).filter(r => isFinite(r.total)).reverse() : [];
    const R: Record<string, P[]> = {};
    if (rates.status === 'fulfilled') for (const r of rates.value) { const k = String(r.security_desc); const v = Number(r.avg_interest_rate_amt); if (isFinite(v)) (R[k] ??= []).push({ t: day(r.record_date), v }); }
    for (const k of Object.keys(R)) R[k].reverse();
    const T = tga.status === 'fulfilled' ? tga.value.map(r => ({ t: day(r.record_date), v: Number(r.open_today_bal) / 1000 })).filter(r => isFinite(r.v)).reverse() : []; // $ bn
    if (!D.length && !Object.keys(R).length && !T.length) throw new Error('Fiscal Data unavailable: ' + [debt, rates, tga].map(x => x.status === 'rejected' ? String((x.reason as Error)?.message ?? x.reason) : 'ok').join(' · '));
    return {
      fetchedAt: Date.now(),
      debt: D.map(r => ({ t: r.t, total: +(r.total / 1e12).toFixed(4), pub: +(r.pub / 1e12).toFixed(4), intra: +(r.intra / 1e12).toFixed(4) })),   // $ trillions
      rates: R, tga: T,
      errors: [debt, rates, tga].filter(x => x.status === 'rejected').map(x => String(((x as PromiseRejectedResult).reason as Error)?.message ?? '').slice(0, 120)),
    };
  })).v;
}

export async function buildTreasury(env: Env) {
  const ids = [...TENORS.map(t => t.id), 'TIPS10Y', 'BE10Y', 'MOVE', 'FEDLO', 'FEDHI', 'CURVE'];
  const S = await readSeries(env, ids, Date.now() - 800 * 864e5);
  const last = Math.max(0, ...TENORS.map(t => S[t.id]?.at(-1)?.t ?? 0));
  const snap = (t: number) => TENORS.map(x => { const p = atOrBefore(S[x.id] ?? [], t); return p && last - p.t < 400 * 864e5 ? { label: x.label, yrs: x.yrs, v: p.v, t: p.t } : { label: x.label, yrs: x.yrs, v: null, t: null }; });
  const curve = { now: snap(last), m1: snap(last - 30 * 864e5), y1: snap(last - 365 * 864e5), asOf: last || null };
  const s2s10 = diff(S.UST10Y ?? [], S.UST2Y ?? []);
  const s3m10 = (S.CURVE ?? []).length ? (S.CURVE ?? []).map(p => ({ t: p.t, v: p.v })) : diff(S.UST10Y ?? [], S.UST3M ?? []);
  const streak = (pts: P[]) => { // days in a row on the current side of zero, and the last flip
    if (!pts.length) return null;
    const neg = pts[pts.length - 1].v < 0; let i = pts.length - 1;
    while (i > 0 && (pts[i - 1].v < 0) === neg) i--;
    return { inverted: neg, since: pts[i].t, days: Math.round((pts[pts.length - 1].t - pts[i].t) / 864e5), invertedDays2y: pts.filter(p => p.v < 0).length, n: pts.length };
  };
  const lastV = (id: string) => S[id]?.at(-1) ?? null;
  const chg = (id: string, days: number) => { const a = lastV(id); const b = a ? atOrBefore(S[id] ?? [], a.t - days * 864e5) : null; return a && b ? +(a.v - b.v).toFixed(3) : null; };
  let fiscal: Awaited<ReturnType<typeof fiscalBlock>> | null = null, fiscalErr: string | null = null;
  try { fiscal = await fiscalBlock(env); } catch (e) { fiscalErr = String((e as Error)?.message ?? e).slice(0, 160); }
  const D = fiscal?.debt ?? [];
  const dLast = D.at(-1) ?? null, dYr = dLast ? D.find(r => r.t >= dLast.t - 365 * 864e5) ?? null : null;
  const avgTot = fiscal?.rates?.['Total Interest-bearing Debt']?.at(-1) ?? null;
  return {
    builtAt: Date.now(), curve,
    kpi: {
      y10: lastV('UST10Y'), y2: lastV('UST2Y'), y3m: lastV('UST3M'), real10: lastV('TIPS10Y'), be10: lastV('BE10Y'), move: lastV('MOVE'),
      fedLo: lastV('FEDLO'), fedHi: lastV('FEDHI'),
      s2s10: s2s10.at(-1) ?? null, s3m10: s3m10.at(-1) ?? null,
      chg10_1m: chg('UST10Y', 30), chg2_1m: chg('UST2Y', 30), chgReal_1m: chg('TIPS10Y', 30),
    },
    spreads: { s2s10, s3m10, streak2s10: streak(s2s10), streak3m10: streak(s3m10) },
    real: { tips10: (S.TIPS10Y ?? []).map(p => ({ t: p.t, v: p.v })), be10: (S.BE10Y ?? []).map(p => ({ t: p.t, v: p.v })), y10: (S.UST10Y ?? []).map(p => ({ t: p.t, v: p.v })) },
    move: (S.MOVE ?? []).slice(-260),
    fiscal: fiscal ? {
      fetchedAt: fiscal.fetchedAt, debt: D, tga: fiscal.tga, rates: fiscal.rates,
      last: dLast, yearAgo: dYr,
      perDayBn: dLast && dYr && dLast.t > dYr.t ? +(((dLast.total - dYr.total) * 1000) / ((dLast.t - dYr.t) / 864e5)).toFixed(2) : null,
      avgRate: avgTot,
      // estimate, not the Treasury's own interest-expense figure: debt × average rate on interest-bearing debt
      interestEstTn: dLast && avgTot ? +(dLast.total * avgTot.v / 100).toFixed(3) : null,
      errors: fiscal.errors,
    } : null,
    fiscalErr,
    sources: { curve: 'FRED (US Treasury par yields, daily)', fiscal: 'U.S. Treasury Fiscal Data API (debt to the penny, average interest rates, Daily Treasury Statement)', move: 'ICE BofAML MOVE via Yahoo' },
  };
}
