/* ================================================================
   DATA EXPLORER — read-only column browser over a whitelist of D1 tables.
   identifiers come only from this whitelist + PRAGMA table_info; values are always bound.
   big tables sort only on their key (an ORDER BY on another column would scan the whole
   table and burn the Free plan's 5M rows-read/day); no COUNT(*) on big tables either.
   ================================================================ */
import type { Env } from '../types';
import { LABELS } from '../forecast/features';

interface T { label: string; desc: string; key: string; dir: 'ASC' | 'DESC'; big?: boolean; need?: string; hide?: string[] }
export const TABLES: Record<string, T> = {
  fx_daily: { label: 'Feature table (daily)', desc: 'One row per gold trading day, every model input as a column, point-in-time. Targets y1/y5/y21 fill in as the future arrives.', key: 'day', dir: 'DESC' },
  forecast_log: { label: 'Forecast ledger', desc: 'Every forecast made by Loop A: the 5 models, the blend, and the actual price once graded (actual_ts −1 = voided while market closed).', key: 'made', dir: 'DESC', big: true },
  forecast_stats: { label: 'Ledger daily stats', desc: 'Daily error (MAPE %) per model and horizon; the blend weights are relearned from this.', key: 'day', dir: 'DESC' },
  ticks: { label: 'Gold minute ticks', desc: 'Gold spot every market minute (gold-api.com), outlier-checked.', key: 'ts', dir: 'DESC', big: true },
  evo_log: { label: 'Evolution log', desc: 'Loop D daily summary per horizon: generations, best and median fitness, champion held-out skill, learned group gates.', key: 'day', dir: 'DESC', hide: ['gates', 'feat_use'] },
  outlook_log: { label: 'Outlook history', desc: 'Loop C: one row per day with both scores, the stance and the gold price that day.', key: 'day', dir: 'DESC', hide: ['json'] },
  predictions: { label: 'Loop B predictions', desc: '5-day direction model: probability of gold higher in 5 trading days.', key: 'ts', dir: 'DESC' },
  prediction_outcomes: { label: 'Loop B outcomes', desc: 'Graded 5-day predictions: realized return and whether the call was right.', key: 'ts', dir: 'DESC' },
  series_meta: { label: 'Warehouse series', desc: 'Every stored series with its source, point count and latest value.', key: 'id', dir: 'ASC' },
  series_points: { label: 'Warehouse points', desc: 'Daily observations for one series. Pick a series id.', key: 'ts', dir: 'DESC', big: true, need: 'id' },
  insider_tx: { label: 'SEC Form 4 transactions', desc: 'Insider transactions at US miners (P = open-market buy, S = sale).', key: 'filed', dir: 'DESC' },
  news_items: { label: 'News items', desc: 'Crawled stories from your YouTube channels and RSS feeds with the AI summary and sentiment.', key: 'published', dir: 'DESC', big: true, hide: ['summary_raw', 'ai_json', 'thumb'] },
  news_sources: { label: 'News sources', desc: 'Your channels and feeds.', key: 'name', dir: 'ASC', hide: ['added_by', 'last_error'] },
  yt_digest: { label: 'Podcast digests', desc: 'One row per episode: status (queued, map, reduce, done, skip, fail), caption or description mode, and the final AI digest. Transcripts are deleted after the digest.', key: 'published', dir: 'DESC', hide: ['chunks', 'notes', 'item_id'] },
  price_snapshots: { label: 'Gold 10-min snapshots', desc: 'Gold price stored by the warm cron every 10 minutes (live prints only).', key: 'ts', dir: 'DESC', big: true },
};
const colCache = new Map<string, { name: string; type: string; pk: number }[]>();
async function columns(env: Env, t: string) {
  if (colCache.has(t)) return colCache.get(t)!;
  const r = (await env.DB.prepare(`PRAGMA table_info(${t})`).all<{ name: string; type: string; pk: number }>()).results ?? [];
  const hide = new Set(TABLES[t].hide ?? []);
  const cols = r.filter(c => !hide.has(c.name)).map(c => ({ name: c.name, type: (c.type || '').toUpperCase(), pk: c.pk }));
  if (cols.length) colCache.set(t, cols);
  return cols;
}

export async function listTables(env: Env) {
  const out: any[] = [];
  for (const [name, t] of Object.entries(TABLES)) {
    try {
      const cols = await columns(env, name);
      if (!cols.length) continue;
      const n = t.big ? null : (await env.DB.prepare(`SELECT COUNT(*) n FROM ${name}`).first<{ n: number }>())?.n ?? 0;
      out.push({ name, label: t.label, desc: t.desc, key: t.key, dir: t.dir, big: !!t.big, need: t.need ?? null, rows: n,
        columns: cols.map(c => ({ name: c.name, type: c.type, label: LABELS[c.name] ?? null, sortable: !t.big || c.name === t.key })) });
    } catch { /* table not created yet */ }
  }
  const ids = (await env.DB.prepare('SELECT id, label FROM series_meta ORDER BY id').all<{ id: string; label: string }>().catch(() => ({ results: [] }))).results ?? [];
  return { tables: out, seriesIds: ids };
}

export interface RowQuery { t: string; cols?: string[]; order?: string; dir?: string; limit?: number; offset?: number; filters?: { col: string; op: string; v: string }[] }
export async function queryRows(env: Env, q: RowQuery, maxLimit = 500) {
  const t = TABLES[q.t]; if (!t) throw new Error('unknown table');
  const all = await columns(env, q.t), names = new Set(all.map(c => c.name));
  const cols = (q.cols?.length ? q.cols.filter(c => names.has(c)) : all.map(c => c.name));
  if (!cols.length) throw new Error('no columns');
  let order = q.order && names.has(q.order) ? q.order : t.key;
  if (t.big && order !== t.key) order = t.key;
  const dir = q.dir === 'ASC' || q.dir === 'DESC' ? q.dir : t.dir;
  const where: string[] = [], args: unknown[] = [];
  for (const f of q.filters ?? []) {
    if (!names.has(f.col)) continue;
    // big tables: filters only on the key (and the required column) so a filter can never become a full scan
    if (t.big && f.col !== t.key && f.col !== t.need) continue;
    const num = Number(f.v);
    if (f.op === 'eq') { where.push(`${f.col} = ?`); args.push(isFinite(num) && f.v.trim() !== '' && !/^[0-9]{4}-/.test(f.v) ? num : f.v); }
    else if (f.op === 'gt' && isFinite(num)) { where.push(`${f.col} > ?`); args.push(num); }
    else if (f.op === 'lt' && isFinite(num)) { where.push(`${f.col} < ?`); args.push(num); }
    else if (f.op === 'contains') { where.push(`lower(CAST(${f.col} AS TEXT)) LIKE ?`); args.push('%' + f.v.toLowerCase().replace(/[%_]/g, '') + '%'); }
    else if (f.op === 'notnull') where.push(`${f.col} IS NOT NULL`);
  }
  if (t.need && !(q.filters ?? []).some(f => f.col === t.need && f.op === 'eq')) throw new Error('pick a series first');
  // offset cap: OFFSET reads every skipped row, so deep paging on big tables is bounded (use a key filter instead)
  const limit = Math.max(1, Math.min(maxLimit, q.limit ?? 100)), offset = Math.max(0, Math.min(t.big ? 2000 : 20000, q.offset ?? 0));
  const sql = `SELECT ${cols.join(', ')} FROM ${q.t}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} ${dir} LIMIT ? OFFSET ?`;
  const r = await env.DB.prepare(sql).bind(...args, limit + 1, offset).all<any>();
  const rows = r.results ?? [];
  return { table: q.t, cols, order, dir, offset, limit, more: rows.length > limit, rows: rows.slice(0, limit) };
}

export function toCsv(cols: string[], rows: any[]): string {
  const cell = (v: unknown) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return cols.join(',') + '\n' + rows.map(r => cols.map(c => cell(r[c])).join(',')).join('\n') + '\n';
}
