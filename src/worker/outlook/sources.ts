/* ================================================================
   SLOW SIGNALS — the inputs most desks skip because they don't move intraday.
   COT       CFTC disaggregated futures-only, gold (088691), weekly, no key
   INSIDERS  SEC Form 4 open-market buys/sells at US-listed gold/silver/copper miners
             (foreign filers like Barrick or Agnico don't file Form 4, so they're absent)
   CROWD     your crawled sources (YouTube + RSS) and GDELT, 14-day sentiment mix on gold
   ================================================================ */
import type { Env } from '../types';
import { AppCache } from '../cache';
import { fetchJson, fetchText } from '../providers/provider';

/* ---------------- CFTC COT ---------------- */
export interface Cot { asOf: string; netPctOI: number; pct3y: number; netLong: number; oi: number; chg4w: number | null; weeks: number; hist?: [string, number, number][] }
export async function cotGold(env: Env): Promise<Cot | null> {
  try {
    const r = await new AppCache(env).wrap('cot:gold:v2', 12 * 3600, async () => {
      const url = 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json?cftc_contract_market_code=088691'
        + '&$select=report_date_as_yyyy_mm_dd,open_interest_all,m_money_positions_long_all,m_money_positions_short_all'
        + '&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=520';
      const rows = (await fetchJson(url, {}, 12000)) as any[];
      const pts = rows.map(x => ({ d: String(x.report_date_as_yyyy_mm_dd).slice(0, 10), oi: +x.open_interest_all, net: +x.m_money_positions_long_all - +x.m_money_positions_short_all }))
        .filter(p => p.oi > 0 && isFinite(p.net)).reverse();
      if (pts.length < 20) throw new Error('cot: thin history ' + pts.length);
      const share = pts.map(p => p.net / p.oi);
      const last = share[share.length - 1];
      const w3 = share.slice(-156);
      const pct = Math.round(w3.filter(s => s <= last).length / w3.length * 100);
      const p4 = pts.length > 4 ? pts[pts.length - 5].net : null;
      const L = pts[pts.length - 1];
      // hist: [report date, net % of OI, net contracts] for the feature table backfill
      return { asOf: L.d, netPctOI: +(last * 100).toFixed(1), pct3y: pct, netLong: L.net, oi: L.oi, chg4w: p4 == null ? null : L.net - p4, weeks: Math.min(156, pts.length),
        hist: pts.map(p => [p.d, +(p.net / p.oi * 100).toFixed(2), p.net] as [string, number, number]) } as Cot;
    });
    return r.v;
  } catch (e) { console.error('COT_FAIL', String((e as Error).message).slice(0, 120)); return null; }
}

/* ---------------- SEC Form 4 ---------------- */
const MINERS: [string, number][] = [['NEM', 1164727], ['CDE', 215466], ['HL', 719413], ['RGLD', 85535], ['FCX', 831259]];
const pad = (n: number) => String(n).padStart(10, '0');
const tag = (x: string, t: string) => { const m = new RegExp('<' + t + '>\\s*(?:<value>)?\\s*([^<]*?)\\s*(?:</value>)?\\s*</' + t + '>', 'i').exec(x); return m ? m[1].trim() : null; };

/** daily: pull new Form 4 filings for the miner list, parse each once, store the transactions */
export async function refreshInsiders(env: Env, maxDocs = 15): Promise<{ ok: boolean; parsed: number; note?: string }> {
  const ua = (env.SEC_USER_AGENT || '').trim();
  if (!/@/.test(ua)) return { ok: false, parsed: 0, note: 'set SEC_USER_AGENT in wrangler.jsonc vars to "AppName your@email" (SEC requires a contact)' };
  const H = { 'User-Agent': ua };
  const since = Date.now() - 120 * 864e5;
  const known = new Set(((await env.DB.prepare('SELECT DISTINCT acc FROM insider_tx WHERE filed >= ?').bind(since).all<{ acc: string }>()).results ?? []).map(r => r.acc));
  const todo: { tk: string; cik: number; acc: string; doc: string; filed: number }[] = [];
  for (const [tk, cik] of MINERS) {
    try {
      const j = await fetchJson(`https://data.sec.gov/submissions/CIK${pad(cik)}.json`, H, 10000);
      const f = j?.filings?.recent; if (!f) continue;
      for (let i = 0; i < f.form.length; i++) {
        if (f.form[i] !== '4') continue;
        const filed = Date.parse(f.filingDate[i]); if (!(filed >= since)) break;
        const acc = String(f.accessionNumber[i]);
        if (known.has(acc)) continue;
        todo.push({ tk, cik, acc, doc: String(f.primaryDocument[i]).replace(/^xsl[^/]*\//, ''), filed });
      }
    } catch (e) { console.error('SEC_SUBMISSIONS_FAIL', tk, String((e as Error).message).slice(0, 80)); }
  }
  todo.sort((a, b) => b.filed - a.filed);
  const rows: unknown[][] = [];
  let parsed = 0;
  for (const t of todo.slice(0, maxDocs)) {
    try {
      const xml = await fetchText(`https://www.sec.gov/Archives/edgar/data/${t.cik}/${t.acc.replace(/-/g, '')}/${t.doc}`, H, 10000);
      const who = tag(xml, 'rptOwnerName') ?? '';
      const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi) ?? [];
      let line = 0;
      for (const b of blocks) {
        const code = tag(b, 'transactionCode');
        const sh = parseFloat(tag(b, 'transactionShares') ?? ''), px = parseFloat(tag(b, 'transactionPricePerShare') ?? '');
        const ad = tag(b, 'transactionAcquiredDisposedCode');
        const dt = Date.parse(tag(b, 'transactionDate') ?? '');
        rows.push([t.acc, line++, t.tk, t.filed, isFinite(dt) ? dt : null, who.slice(0, 80), code, ad, isFinite(sh) ? sh : null, isFinite(px) ? px : null]);
      }
      // a filing with only derivative lines still gets a marker row so it isn't fetched again
      if (!blocks.length) rows.push([t.acc, 0, t.tk, t.filed, null, who.slice(0, 80), 'X', null, null, null]);
      parsed++;
    } catch (e) { console.error('SEC_FORM4_FAIL', t.tk, t.acc, String((e as Error).message).slice(0, 80)); }
  }
  if (rows.length) await env.DB.prepare(
    `INSERT OR IGNORE INTO insider_tx (acc, line, ticker, filed, tx_date, who, code, ad, shares, price)
     SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]'),
            json_extract(value,'$[5]'), json_extract(value,'$[6]'), json_extract(value,'$[7]'), json_extract(value,'$[8]'), json_extract(value,'$[9]')
     FROM json_each(?)`).bind(JSON.stringify(rows)).run();
  return { ok: true, parsed };
}

export interface Insiders { buys: number; buyUsd: number; sells: number; sellUsd: number; buyers: string[]; from: number; filings: number }
export async function insiderSummary(env: Env, days = 90): Promise<Insiders | null> {
  try {
    const from = Date.now() - days * 864e5;
    const rs = (await env.DB.prepare(`SELECT ticker, who, code, shares, price, acc FROM insider_tx WHERE filed >= ? AND code IN ('P','S')`).bind(from).all<any>()).results ?? [];
    const n = await env.DB.prepare('SELECT COUNT(DISTINCT acc) n FROM insider_tx WHERE filed >= ?').bind(from).first<{ n: number }>();
    if (!n?.n) return null;
    const out: Insiders = { buys: 0, buyUsd: 0, sells: 0, sellUsd: 0, buyers: [], from, filings: n.n };
    for (const r of rs) {
      const v = (r.shares ?? 0) * (r.price ?? 0);
      if (r.code === 'P') { out.buys++; out.buyUsd += v; const k = r.ticker + ': ' + r.who; if (!out.buyers.includes(k)) out.buyers.push(k); }
      else { out.sells++; out.sellUsd += v; }
    }
    return out;
  } catch { return null; }
}

/* ---------------- crowd mood (your sources + GDELT) ---------------- */
export interface Crowd { n: number; bull: number; bear: number; bullShare: number; videos: number }
export async function crowdGold(env: Env): Promise<Crowd | null> {
  try {
    const r = await env.DB.prepare(
      `SELECT SUM(CASE WHEN i.sentiment='bull' THEN 1 ELSE 0 END) bull, SUM(CASE WHEN i.sentiment='bear' THEN 1 ELSE 0 END) bear,
              SUM(CASE WHEN s.kind='youtube' THEN 1 ELSE 0 END) videos, COUNT(*) n
       FROM news_items i JOIN news_sources s ON s.id = i.source_id
       WHERE i.published > ? AND i.sentiment IN ('bull','bear','neutral') AND (i.topics LIKE '%gold%' OR i.ai_json LIKE '%"XAU"%')`
    ).bind(Date.now() - 14 * 864e5).first<{ bull: number; bear: number; videos: number; n: number }>();
    if (!r || !r.n) return null;
    const dir = (r.bull ?? 0) + (r.bear ?? 0);
    return { n: r.n, bull: r.bull ?? 0, bear: r.bear ?? 0, bullShare: dir ? (r.bull ?? 0) / dir : 0.5, videos: r.videos ?? 0 };
  } catch { return null; }
}
