import type { Env, MacroRow } from '../types';
import { fetchJson, secret } from './provider';

export const FRED_MAP: Record<string, { id: string; label: string; kind: 'yoy' | 'level' | 'bp'; freq: string }> = {
  CPI:     { id: 'CPIAUCSL',   label: 'Headline CPI', kind: 'yoy',   freq: 'Monthly' },
  CORE:    { id: 'CPILFESL',   label: 'Core CPI',     kind: 'yoy',   freq: 'Monthly' },
  PCE:     { id: 'PCEPI',      label: 'PCE',          kind: 'yoy',   freq: 'Monthly' },
  COREPCE: { id: 'PCEPILFE',   label: 'Core PCE',     kind: 'yoy',   freq: 'Monthly' },
  PPI:     { id: 'PPIACO',     label: 'PPI Final',    kind: 'yoy',   freq: 'Monthly' },
  UNRATE:  { id: 'UNRATE',     label: 'Unemployment', kind: 'level', freq: 'Monthly' },
  US10Y:   { id: 'DGS10',      label: '10Y Treasury',    kind: 'bp', freq: 'Daily' },
  REAL10Y: { id: 'DFII10',     label: '10Y Real (TIPS)', kind: 'bp', freq: 'Daily' },
  BREAKEV: { id: 'T10YIE',     label: '10Y Breakeven',   kind: 'bp', freq: 'Daily' },
  SOFR:    { id: 'SOFR',       label: 'SOFR · Repo',     kind: 'bp', freq: 'Daily' },
  EFFR:    { id: 'EFFR',       label: 'Fed Funds (EFFR)', kind: 'bp', freq: 'Daily' },
  AUTOINS: { id: 'CUSR0000SETB', label: 'Auto Insurance CPI', kind: 'yoy', freq: 'Monthly' },
};

export async function fredRows(env: Env): Promise<MacroRow[]> {
  const key = secret(env, 'FRED_API_KEY');
  if (!key) throw new Error('FRED_API_KEY not configured');
  const out: MacroRow[] = [];
  for (const [keyName, cfg] of Object.entries(FRED_MAP)) {
    const j = await fetchJson(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${cfg.id}&api_key=${key}&file_type=json&sort_order=desc&limit=26`
    );
    const obs: { date: string; value: string }[] = (j?.observations ?? []).filter((o: any) => o.value !== '.');
    if (obs.length < 2) continue;
    const num = (o: { value: string }) => parseFloat(o.value);
    const spark = obs.slice(0, 12).map(num).reverse();
    const asOf = obs[0].date;
    let value: number, prior: number, unit: MacroRow['unit'];
    if (cfg.kind === 'yoy' && obs.length >= 13) {
      value = (num(obs[0]) / num(obs[12]) - 1) * 100; prior = (num(obs[1]) / num(obs[13]) - 1) * 100; unit = 'pct';
    } else if (cfg.kind === 'bp') {
      value = num(obs[0]); prior = num(obs[1]); unit = 'bp';
    } else {
      value = num(obs[0]); prior = num(obs[1]); unit = 'level';
    }
    out.push({ key: keyName, label: cfg.label, value, prior, unit, freq: cfg.freq, source: 'FRED ' + cfg.id, delay: cfg.kind === 'yoy' ? 'monthly' : 'daily', asOf, spark });
  }
  if (!out.length) throw new Error('fred: no rows');
  return out;
}

export async function fredSeriesTail(env: Env, id: string, n = 80): Promise<{ t: number; v: number }[]> {
  const key = secret(env, 'FRED_API_KEY');
  if (!key) throw new Error('FRED_API_KEY not configured');
  const j = await fetchJson(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=${n}`);
  return (j?.observations ?? []).filter((o: any) => o.value !== '.').map((o: any) => ({ t: Date.parse(o.date + 'T12:00:00Z'), v: parseFloat(o.value) })).reverse();
}
