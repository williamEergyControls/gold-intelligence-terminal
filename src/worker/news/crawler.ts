/* ================================================================
   NEWS CRAWLER — your sources (RSS/Atom + YouTube channels) → D1 → AI digest
   cycle (cron "2,12,22,32,42,52 * * * *", own invocation = own 50-subrequest cap):
     POLL      ≤ CRAWL_MAX due sources, oldest first (rss 15 min, youtube 30 min)
     EVALUATE  parse feed → keep ≤15 items/feed from the last 7 days → tag topics
     PUBLISH   one bulk INSERT OR IGNORE (json_each) + one batch of source states
     DIGEST    every other run: ≤ AI_BATCH unsummarized items → 1 Workers AI call
               → summary + sentiment + optional trade idea per item (JSON, validated)
   readers (/api/news/feed, /api/news/ideas) are single D1 reads.
   ================================================================ */
import type { Env } from '../types';
import { AppCache } from '../cache';

export interface SourceRow {
  id: number; kind: 'rss' | 'youtube'; url: string; name: string; topics: string; enabled: number; favorite: number;
  last_fetch: number | null; last_ok: number | null; last_error: string | null; items: number; fails: number; created_at: number | null;
}
export interface FeedItem {
  id: string; url: string; title: string; source: string; kind: 'rss' | 'youtube' | 'gdelt'; favorite: boolean;
  published: number; summary: string | null; aiSummary: boolean; sentiment: 'bull' | 'bear' | 'neutral' | null;
  assets: string[]; idea: Idea | null; thumb: string | null; topics: string[];
}
export interface Idea { asset: string; bias: 'long' | 'short' | 'watch'; horizon: string; why: string; risk: string }

const CRAWL_MAX = 8;
const AI_BATCH = 4;
const KEEP_DAYS = 14;
const UA = 'Mozilla/5.0 (compatible; GoldIntelligenceTerminal/3.0; personal research reader)';
export const TOPICS = ['markets', 'gold', 'energy', 'agri', 'fx', 'macro', 'shipping', 'crypto', 'water', 'land'] as const;
export const ASSETS = ['XAU', 'XAG', 'DXY', 'EURUSD', 'USDJPY', 'GBPUSD', 'USDCNY', 'WTI', 'BRENT', 'NATGAS', 'CORN', 'WHEAT', 'SOY',
  'COPPER', 'SPX', 'NDX', 'UST10Y', 'BTC', 'ETH', 'USDT', 'USDC', 'BDRY'];

/* verified 2026-10-02 (feeds fetched, recent items present). youtube ids cross-checked on channel pages. */
const YT = (id: string) => 'https://www.youtube.com/feeds/videos.xml?channel_id=' + id;
export const DEFAULT_SOURCES: { kind: 'rss' | 'youtube'; url: string; name: string; topics: string }[] = [
  { kind: 'rss', url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', name: 'WSJ Markets', topics: 'markets,macro' },
  { kind: 'rss', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', name: 'MarketWatch', topics: 'markets' },
  { kind: 'rss', url: 'https://www.nasdaq.com/feed/rssoutbound?category=Markets', name: 'Nasdaq Markets', topics: 'markets' },
  { kind: 'rss', url: 'https://www.mining.com/commodity/gold/feed/', name: 'Mining.com Gold', topics: 'gold' },
  { kind: 'rss', url: 'https://oilprice.com/rss/main', name: 'OilPrice.com', topics: 'energy' },
  { kind: 'rss', url: 'https://www.rigzone.com/news/rss/rigzone_latest.aspx', name: 'Rigzone', topics: 'energy' },
  { kind: 'rss', url: 'https://www.farmprogress.com/rss.xml', name: 'Farm Progress', topics: 'agri' },
  { kind: 'rss', url: 'https://www.brownfieldagnews.com/feed/', name: 'Brownfield Ag News', topics: 'agri' },
  { kind: 'rss', url: 'https://farmdocdaily.illinois.edu/feed', name: 'farmdoc daily', topics: 'agri,land' },
  { kind: 'rss', url: 'https://www.fxstreet.com/rss/news', name: 'FXStreet', topics: 'fx,macro' },
  { kind: 'rss', url: 'https://investinglive.com/feed/news', name: 'investingLive', topics: 'fx,macro' },
  { kind: 'rss', url: 'https://www.federalreserve.gov/feeds/press_all.xml', name: 'Federal Reserve', topics: 'macro' },
  { kind: 'rss', url: 'https://gcaptain.com/feed/', name: 'gCaptain', topics: 'shipping' },
  { kind: 'rss', url: 'https://splash247.com/feed/', name: 'Splash247', topics: 'shipping' },
  { kind: 'rss', url: 'https://www.hellenicshippingnews.com/feed/', name: 'Hellenic Shipping News', topics: 'shipping' },
  { kind: 'rss', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk', topics: 'crypto' },
  { kind: 'rss', url: 'https://www.theblock.co/rss.xml', name: 'The Block', topics: 'crypto' },
  { kind: 'rss', url: 'https://www.circleofblue.org/feed/', name: 'Circle of Blue', topics: 'water' },
  { kind: 'youtube', url: YT('UC9ijza42jVR3T6b8bColgvg'), name: 'Kitco NEWS', topics: 'gold' },
  { kind: 'youtube', url: YT('UCrp_UI8XtuYfpiqluWLD7Lw'), name: 'CNBC Television', topics: 'markets,macro' },
  { kind: 'youtube', url: YT('UCIALMKvObZNtJ6AmdCLP7Lg'), name: 'Bloomberg Television', topics: 'markets,macro' },
  { kind: 'youtube', url: YT('UCEAZeUIeJs0IjQiqTCdVSIg'), name: 'Yahoo Finance', topics: 'markets' },
  { kind: 'youtube', url: YT('UChqUTb7kYRX8-EiaN3XFrSQ'), name: 'Reuters', topics: 'markets,macro' },
];

/* ---------- keyword topic tagger (cheap, deterministic) ---------- */
const KW: [string, RegExp][] = [
  ['gold', /\bgold\b|bullion|precious metal|\bsilver\b|\bxau\b|gold miners?/i],
  ['energy', /\boil\b|crude|opec|brent|\bwti\b|natural gas|\blng\b|gasoline|diesel|refiner|\benergy\b/i],
  ['agri', /\bcorn\b|wheat|soybean|\bsoy\b|grain|cattle|\bhogs?\b|\bcrops?\b|harvest|usda|fertili[sz]er/i],
  ['fx', /\bdollar\b|\bforex\b|\bfx\b|currenc|\beuro\b|\byen\b|yuan|sterling|\bdxy\b|eur\/usd|usd\/jpy/i],
  ['macro', /\bfed\b|federal reserve|fomc|powell|inflation|\bcpi\b|\bpce\b|payrolls?|jobs report|\becb\b|rate cut|rate hike|treasur|\byields?\b|recession|\bgdp\b/i],
  ['shipping', /shipping|freight|container|tanker|\bports?\b|vessel|suez|panama canal|red sea|maritime|bulk carrier|seaborne/i],
  ['crypto', /stablecoin|tether|\busdt\b|\busdc\b|crypto|bitcoin|ethereum|\bdefi\b/i],
  ['water', /\bwater\b|drought|\briver\b|reservoir|aquifer|irrigation|snowpack/i],
  ['land', /farmland|land values?|cash rents?|\bacres?\b|ranchland/i],
  ['markets', /\bstocks?\b|s&p|nasdaq|\bdow\b|equit|wall street|earnings/i],
];
function tagTopics(text: string, base: string): string[] {
  const set = new Set(base.split(',').map(s => s.trim()).filter(Boolean));
  for (const [t, re] of KW) if (re.test(text)) set.add(t);
  return [...set].filter(t => (TOPICS as readonly string[]).includes(t));
}

/* ---------- XML helpers (regex parser: feeds are small, no DOM in workers) ---------- */
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ENT[e.toLowerCase()] ?? m;
  });
}
function cdata(s: string): string { return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); }
export function textOf(s: string | undefined | null, max = 600): string {
  if (!s) return '';
  let t = cdata(s);
  t = decode(t);                         // entity-escaped html → html
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  t = decode(t).replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return t;
}
function tag(block: string, name: string): string | null {
  const re = new RegExp('<' + name.replace(':', '\\:') + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name.replace(':', '\\:') + '>', 'i');
  const m = re.exec(block);
  return m ? m[1] : null;
}
function attr(block: string, name: string, at: string, filter?: RegExp): string | null {
  const re = new RegExp('<' + name.replace(':', '\\:') + '\\b([^>]*)/?>', 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    if (filter && !filter.test(m[1])) continue;
    const a = new RegExp('\\b' + at + '\\s*=\\s*["\']([^"\']+)["\']', 'i').exec(m[1]);
    if (a) return decode(a[1]);
  }
  return null;
}
export interface Parsed { title: string; url: string; published: number; desc: string; thumb: string | null }
export function parseFeed(xml: string, kind: 'rss' | 'youtube'): { title: string | null; items: Parsed[] } {
  const atom = /<feed[\s>]/i.test(xml.slice(0, 2000));
  const blocks = (xml.match(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? []).slice(0, 15);
  const head = xml.slice(0, Math.max(0, xml.search(atom ? /<entry[\s>]/i : /<item[\s>]/i)));
  const feedTitle = textOf(tag(head, 'title'), 120) || null;
  const items: Parsed[] = [];
  for (const b of blocks) {
    const title = textOf(tag(b, 'title'), 300);
    let url = atom ? (attr(b, 'link', 'href', /rel=["']alternate["']/i) ?? attr(b, 'link', 'href')) : textOf(tag(b, 'link'), 500);
    if (!url) url = textOf(tag(b, 'guid'), 500);
    const dt = tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'dc:date');
    const published = dt ? Date.parse(textOf(dt, 80)) : NaN;
    const descRaw = tag(b, 'media:description') ?? tag(b, 'description') ?? tag(b, 'summary') ?? tag(b, 'content:encoded') ?? tag(b, 'content');
    let desc = textOf(descRaw, 700);
    if (desc && desc.toLowerCase() === title.toLowerCase()) desc = '';
    const thumb = attr(b, 'media:thumbnail', 'url') ?? attr(b, 'media:content', 'url', /medium=["']image|type=["']image/i)
      ?? attr(b, 'enclosure', 'url', /type=["']image/i);
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    items.push({ title, url, published: isFinite(published) ? published : Date.now(), desc, thumb: thumb && /^https:\/\//.test(thumb) ? thumb : null });
  }
  if (kind === 'youtube') for (const it of items) {
    // skip shorts: they carry no description worth summarizing
    if (/\/shorts\//.test(it.url)) it.title = '';
  }
  return { title: feedTitle, items: items.filter(i => i.title) };
}

async function sha1hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('');
}
function normUrl(u: string): string {
  try { const x = new URL(u); ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'mod', 'mc_cid'].forEach(k => x.searchParams.delete(k)); x.hash = ''; return x.href; }
  catch { return u; }
}

async function fetchFeed(url: string, kind: 'rss' | 'youtube'): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal, redirect: kind === 'youtube' ? 'manual' : 'follow',
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5', ...(kind === 'youtube' ? { cookie: 'SOCS=CAI' } : {}) },
    });
    if (r.status >= 300 && r.status < 400) throw new Error('redirect to ' + (r.headers.get('location') || '?').slice(0, 60));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    return txt.length > 600000 ? txt.slice(0, 600000) : txt;
  } finally { clearTimeout(t); }
}

/* ---------- seed + crawl ---------- */
let seeded = false;
export async function ensureSources(env: Env): Promise<void> {
  if (seeded) return;
  const n = await env.DB.prepare('SELECT COUNT(*) n FROM news_sources').first<{ n: number }>();
  if (!n?.n) {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO news_sources(kind,url,name,topics,enabled,favorite,added_by,created_at)
       SELECT json_extract(value,'$.kind'), json_extract(value,'$.url'), json_extract(value,'$.name'), json_extract(value,'$.topics'), 1, 0, 'default', ?
       FROM json_each(?)`
    ).bind(now, JSON.stringify(DEFAULT_SOURCES)).run();
  }
  seeded = true;
}

export async function crawlCycle(env: Env, opts: { max?: number; ids?: number[] } = {}): Promise<{ fetched: number; added: number; errors: string[] }> {
  await ensureSources(env);
  const now = Date.now();
  const due = opts.ids?.length
    ? (await env.DB.prepare(`SELECT * FROM news_sources WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(opts.ids)).all<SourceRow>()).results ?? []
    : (await env.DB.prepare(
      `SELECT * FROM news_sources WHERE enabled=1 AND (last_fetch IS NULL OR last_fetch < ? - CASE kind WHEN 'youtube' THEN 1800000 ELSE 900000 END * (1 + MIN(fails,6)))
       ORDER BY favorite DESC, COALESCE(last_fetch,0) ASC LIMIT ?`
    ).bind(now, opts.max ?? CRAWL_MAX).all<SourceRow>()).results ?? [];
  if (!due.length) return { fetched: 0, added: 0, errors: [] };

  const rows: unknown[] = [];
  const states: D1PreparedStatement[] = [];
  const errors: string[] = [];
  const settled = await Promise.allSettled(due.map(s => fetchFeed(s.url, s.kind)));
  for (let i = 0; i < due.length; i++) {
    const s = due[i], r = settled[i];
    if (r.status === 'rejected') {
      const msg = String((r.reason as Error)?.message ?? r.reason).slice(0, 160);
      errors.push(s.name + ': ' + msg);
      states.push(env.DB.prepare('UPDATE news_sources SET last_fetch=?, last_error=?, fails=fails+1 WHERE id=?').bind(now, msg, s.id));
      continue;
    }
    let parsed: ReturnType<typeof parseFeed>;
    try { parsed = parseFeed(r.value, s.kind); }
    catch (e) { parsed = { title: null, items: [] }; }
    const fresh = parsed.items.filter(it => now - it.published < 7 * 864e5 && it.published - now < 864e5);
    if (!parsed.items.length) {
      states.push(env.DB.prepare('UPDATE news_sources SET last_fetch=?, last_error=?, fails=fails+1 WHERE id=?').bind(now, 'no items parsed (not a feed?)', s.id));
      errors.push(s.name + ': no items parsed');
      continue;
    }
    for (const it of fresh) {
      const url = normUrl(it.url);
      rows.push({
        id: await sha1hex(url), sid: s.id, url, title: it.title, pub: Math.min(it.published, now), raw: it.desc || null,
        thumb: it.thumb, topics: tagTopics(it.title + ' ' + it.desc, s.topics).join(','),
      });
    }
    states.push(env.DB.prepare('UPDATE news_sources SET last_fetch=?, last_ok=?, last_error=NULL, fails=0, items=? WHERE id=?').bind(now, now, fresh.length, s.id));
  }
  let added = 0;
  if (rows.length) {
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO news_items(id,source_id,url,title,published,fetched,summary_raw,thumb,topics)
       SELECT json_extract(value,'$.id'), json_extract(value,'$.sid'), json_extract(value,'$.url'), json_extract(value,'$.title'),
              json_extract(value,'$.pub'), ?, json_extract(value,'$.raw'), json_extract(value,'$.thumb'), json_extract(value,'$.topics')
       FROM json_each(?)`
    ).bind(now, JSON.stringify(rows)).run();
    added = res.meta?.changes ?? 0;
  }
  if (states.length) await env.DB.batch(states);
  return { fetched: due.length, added, errors };
}

/* ---------- AI digest ---------- */
const SYS = `You are the news editor of a markets research terminal. For each numbered item write a neutral summary of 1-2 sentences using only facts stated in the item. Then, only if the item clearly implies a directional view on one liquid market, add a trade idea; otherwise idea is null. Never invent numbers, prices or dates. Allowed asset codes: ${ASSETS.join(', ')}.
Reply with ONLY a JSON array, one object per item, in order:
{"i":0,"summary":"...","sentiment":"bull|bear|neutral","assets":["XAU"],"idea":{"asset":"XAU","bias":"long|short|watch","horizon":"days|weeks","why":"one sentence","risk":"what would prove it wrong"}}
sentiment is for the first asset in assets. No markdown, no extra text.`;
const MODELS = ['@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3.2-3b-instruct'];

function clean(s: unknown, max: number): string { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
export function validateDigest(o: any): { summary: string; sentiment: 'bull' | 'bear' | 'neutral'; assets: string[]; idea: Idea | null } | null {
  if (!o || typeof o !== 'object') return null;
  const summary = clean(o.summary, 420);
  if (summary.length < 20) return null;
  const sentiment = ['bull', 'bear', 'neutral'].includes(o.sentiment) ? o.sentiment : 'neutral';
  const assets = (Array.isArray(o.assets) ? o.assets : []).map((a: unknown) => String(a).toUpperCase()).filter((a: string) => ASSETS.includes(a)).slice(0, 4);
  let idea: Idea | null = null;
  const d = o.idea;
  if (d && typeof d === 'object') {
    const asset = String(d.asset ?? '').toUpperCase();
    const bias = String(d.bias ?? '').toLowerCase();
    const why = clean(d.why, 240), risk = clean(d.risk, 200);
    if (ASSETS.includes(asset) && ['long', 'short', 'watch'].includes(bias) && why.length > 10) {
      idea = { asset, bias: bias as Idea['bias'], horizon: ['intraday', 'days', 'weeks'].includes(String(d.horizon)) ? String(d.horizon) : 'days', why, risk: risk || 'n/a' };
      if (!assets.includes(asset)) assets.unshift(asset);
    }
  }
  return { summary, sentiment, assets, idea };
}

export async function digestBatch(env: Env, n = AI_BATCH): Promise<{ done: number; engine: string | null; error?: string }> {
  if (env.AI_ENABLED === 'false' || !env.AI) return { done: 0, engine: null, error: 'AI disabled' };
  const rs = (await env.DB.prepare(
    `SELECT i.id, i.title, i.summary_raw, s.name FROM news_items i JOIN news_sources s ON s.id=i.source_id
     WHERE i.ai_at IS NULL AND i.published > ? ORDER BY s.favorite DESC, i.published DESC LIMIT ?`
  ).bind(Date.now() - 3 * 864e5, n).all<{ id: string; title: string; summary_raw: string | null; name: string }>()).results ?? [];
  if (!rs.length) return { done: 0, engine: null };
  const user = rs.map((r, i) => `${i}. [${r.name}] ${r.title}${r.summary_raw ? ' — ' + r.summary_raw.slice(0, 520) : ''}`).join('\n\n');
  let arr: any[] | null = null, engine: string | null = null, lastErr = '';
  for (const m of MODELS) {
    try {
      const res: any = await env.AI.run(m as any, { messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }], max_tokens: 220 * rs.length, temperature: 0.1 } as any);
      const raw = String(res?.response ?? '').trim();
      const j = raw.match(/\[[\s\S]*\]/);
      if (!j) throw new Error('no json array');
      arr = JSON.parse(j[0]);
      if (!Array.isArray(arr)) throw new Error('not an array');
      engine = m.split('/')[2];
      break;
    } catch (e) { lastErr = String((e as Error).message ?? e).slice(0, 120); }
  }
  const now = Date.now();
  const stmts = rs.map((r, i) => {
    const v = arr ? validateDigest(arr.find(o => Number(o?.i) === i) ?? arr[i]) : null;
    // ai_at is stamped even on failure so one bad item never blocks the queue
    return env.DB.prepare('UPDATE news_items SET ai_at=?, ai_summary=?, ai_json=?, sentiment=? WHERE id=?')
      .bind(now, v?.summary ?? null, v ? JSON.stringify({ assets: v.assets, idea: v.idea, engine }) : JSON.stringify({ err: lastErr || 'invalid' }), v?.sentiment ?? null, r.id);
  });
  await env.DB.batch(stmts);
  return { done: rs.length, engine, error: arr ? undefined : lastErr };
}

export async function pruneNews(env: Env): Promise<number> {
  const r = await env.DB.prepare('DELETE FROM news_items WHERE published < ?').bind(Date.now() - KEEP_DAYS * 864e5).run();
  return r.meta?.changes ?? 0;
}

/* ---------- readers ---------- */
const GDELT_TOPIC: Record<string, string[]> = { gold: ['gold', 'mining'], macro: ['macro'], fx: ['macro'], energy: ['energy'], agri: ['agri'], markets: ['macro', 'gold'], all: ['gold', 'macro', 'energy', 'agri'] };
interface ItemRow { id: string; url: string; title: string; published: number; summary_raw: string | null; thumb: string | null; topics: string | null; ai_summary: string | null; ai_json: string | null; sentiment: string | null; name: string; kind: string; favorite: number }
function toItem(r: ItemRow): FeedItem {
  let j: any = null; try { j = r.ai_json ? JSON.parse(r.ai_json) : null; } catch { j = null; }
  return {
    id: r.id, url: r.url, title: r.title, source: r.name, kind: r.kind === 'youtube' ? 'youtube' : 'rss', favorite: !!r.favorite,
    published: r.published, summary: r.ai_summary ?? r.summary_raw, aiSummary: !!r.ai_summary,
    sentiment: (r.sentiment as FeedItem['sentiment']) ?? null, assets: j?.assets ?? [], idea: j?.idea ?? null,
    thumb: r.thumb, topics: (r.topics ?? '').split(',').filter(Boolean),
  };
}

export async function newsFeed(env: Env, topic: string, limit: number, opts: { favOnly?: boolean; withGdelt?: boolean } = {}): Promise<{ items: FeedItem[]; topic: string; sources: number; favorites: number; updatedAt: number | null }> {
  await ensureSources(env);
  const t = topic === 'all' || !(TOPICS as readonly string[]).includes(topic) ? 'all' : topic;
  const where: string[] = ['i.published > ?'];
  const args: unknown[] = [Date.now() - 7 * 864e5];
  if (t !== 'all') { where.push(`(',' || i.topics || ',') LIKE ?`); args.push('%,' + t + ',%'); }
  if (opts.favOnly) where.push('s.favorite=1');
  const rs = (await env.DB.prepare(
    `SELECT i.id,i.url,i.title,i.published,i.summary_raw,i.thumb,i.topics,i.ai_summary,i.ai_json,i.sentiment,s.name,s.kind,s.favorite
     FROM news_items i JOIN news_sources s ON s.id=i.source_id WHERE ${where.join(' AND ')}
     ORDER BY i.published DESC LIMIT ?`
  ).bind(...args, Math.min(80, limit * 2)).all<ItemRow>()).results ?? [];
  const stats = await env.DB.prepare('SELECT COUNT(*) n, SUM(favorite) f, MAX(last_ok) u FROM news_sources WHERE enabled=1').first<{ n: number; f: number | null; u: number | null }>();
  // de-dupe near-identical headlines across outlets
  const seen = new Set<string>();
  let items: FeedItem[] = [];
  for (const r of rs) {
    const k = r.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70);
    if (seen.has(k)) continue;
    seen.add(k); items.push(toItem(r));
  }
  // favorites float up within the same ~6h window
  items.sort((a, b) => (b.published + (b.favorite ? 6 * 36e5 : 0)) - (a.published + (a.favorite ? 6 * 36e5 : 0)));
  items = items.slice(0, limit);
  if (opts.withGdelt !== false && items.length < limit) {
    try {
      const boot = await new AppCache(env).read<any>('boot:15M');
      const pools: any[] = [];
      for (const k of GDELT_TOPIC[t] ?? []) pools.push(...((boot?.v?.news?.[k] ?? []) as any[]));
      for (const n of pools.sort((a, b) => b.publishedTs - a.publishedTs)) {
        if (items.length >= limit) break;
        const k = String(n.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70);
        if (seen.has(k) || !n.url || n.url === '#') continue;
        seen.add(k);
        items.push({ id: 'g:' + n.id, url: n.url, title: n.title, source: String(n.source).replace(/^GDELT · /, ''), kind: 'gdelt', favorite: false, published: n.publishedTs, summary: null, aiSummary: false, sentiment: n.sentiment ?? null, assets: [], idea: null, thumb: null, topics: [t] });
      }
    } catch { /* gdelt fill is optional */ }
  }
  return { items, topic: t, sources: stats?.n ?? 0, favorites: stats?.f ?? 0, updatedAt: stats?.u ?? null };
}

export async function newsIdeas(env: Env, limit: number, topic?: string): Promise<{ ideas: (Idea & { title: string; url: string; source: string; published: number; sentiment: string | null })[] }> {
  const where = ['i.ai_json LIKE \'%"idea":{%\'', 'i.published > ?'];
  const args: unknown[] = [Date.now() - 3 * 864e5];
  if (topic && topic !== 'all') { where.push(`(',' || i.topics || ',') LIKE ?`); args.push('%,' + topic + ',%'); }
  const rs = (await env.DB.prepare(
    `SELECT i.id,i.url,i.title,i.published,i.summary_raw,i.thumb,i.topics,i.ai_summary,i.ai_json,i.sentiment,s.name,s.kind,s.favorite
     FROM news_items i JOIN news_sources s ON s.id=i.source_id WHERE ${where.join(' AND ')} ORDER BY s.favorite DESC, i.published DESC LIMIT ?`
  ).bind(...args, limit * 3).all<ItemRow>()).results ?? [];
  const out: any[] = [];
  const perAsset = new Map<string, number>();
  for (const r of rs) {
    const it = toItem(r);
    if (!it.idea) continue;
    const c = perAsset.get(it.idea.asset) ?? 0;
    if (c >= 2) continue;               // at most two ideas per asset keeps the card varied
    perAsset.set(it.idea.asset, c + 1);
    out.push({ ...it.idea, title: it.title, url: it.url, source: it.source, published: it.published, sentiment: it.sentiment });
    if (out.length >= limit) break;
  }
  return { ideas: out };
}

/* ---------- admin: manage sources ---------- */
export async function listSources(env: Env): Promise<{ sources: (SourceRow & { stored: number; summarized: number })[] }> {
  await ensureSources(env);
  const rs = (await env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM news_items i WHERE i.source_id=s.id) stored,
            (SELECT COUNT(*) FROM news_items i WHERE i.source_id=s.id AND i.ai_summary IS NOT NULL) summarized
     FROM news_sources s ORDER BY s.favorite DESC, s.kind, s.name`
  ).all<SourceRow & { stored: number; summarized: number }>()).results ?? [];
  return { sources: rs };
}

/** accepts: any RSS/Atom URL, a site page that advertises a feed, a YouTube feed URL,
    youtube.com/channel/UC…, youtube.com/@handle, /c/name or /user/name */
export async function resolveSource(input: string): Promise<{ kind: 'rss' | 'youtube'; url: string; name: string }> {
  let u: URL;
  try { u = new URL(input.trim().startsWith('http') ? input.trim() : 'https://' + input.trim()); } catch { throw new Error('not a valid URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s) URLs');
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtube.com' || host === 'youtu.be') {
    let id = u.searchParams.get('channel_id') || (/^\/channel\/(UC[\w-]{22})/.exec(u.pathname)?.[1] ?? null);
    let name = '';
    if (!id) {
      const page = await fetch('https://www.youtube.com' + u.pathname.split('/').slice(0, 2).join('/'), { headers: { 'user-agent': UA, cookie: 'SOCS=CAI', 'accept-language': 'en' }, redirect: 'manual' });
      if (page.status >= 300 && page.status < 400) throw new Error('YouTube consent redirect — paste the /channel/UC… link instead');
      if (!page.ok) throw new Error('YouTube page HTTP ' + page.status);
      const html = (await page.text()).slice(0, 900000);
      id = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)?.[1]
        ?? /<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)?.[1]
        ?? /feeds\/videos\.xml\?channel_id=(UC[\w-]{22})/.exec(html)?.[1]
        ?? /"externalId":"(UC[\w-]{22})"/.exec(html)?.[1] ?? null;
      name = decode(/<meta property="og:title" content="([^"]+)"/.exec(html)?.[1] ?? '');
    }
    if (!id || !/^UC[\w-]{22}$/.test(id)) throw new Error('could not find the channel id on that page');
    const feed = YT(id);
    if (!name) {
      try { name = parseFeed(await fetchFeed(feed, 'youtube'), 'youtube').title ?? ''; } catch { /* feed endpoint is flaky; name is cosmetic */ }
    }
    return { kind: 'youtube', url: feed, name: name || 'YouTube ' + id.slice(0, 8) };
  }
  const body = await fetchFeed(u.href, 'rss');
  if (/<(rss|feed|rdf:RDF)[\s>]/i.test(body.slice(0, 3000))) {
    const p = parseFeed(body, 'rss');
    if (!p.items.length) throw new Error('feed has no items');
    return { kind: 'rss', url: u.href, name: p.title || host };
  }
  // html page: follow its advertised feed
  const alt = /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i.exec(body)?.[0];
  const href = alt ? /href=["']([^"']+)["']/i.exec(alt)?.[1] : null;
  if (!href) throw new Error('no RSS/Atom feed found at that address');
  const feedUrl = new URL(decode(href), u).href;
  const p = parseFeed(await fetchFeed(feedUrl, 'rss'), 'rss');
  if (!p.items.length) throw new Error('feed has no items');
  return { kind: 'rss', url: feedUrl, name: p.title || host };
}

export async function addSource(env: Env, input: { url: string; name?: string; topics?: string; favorite?: boolean }, by: string): Promise<{ id: number; kind: string; url: string; name: string }> {
  await ensureSources(env);
  const r = await resolveSource(String(input.url ?? ''));
  const topics = String(input.topics ?? '').split(',').map(s => s.trim().toLowerCase()).filter(t => (TOPICS as readonly string[]).includes(t)).join(',') || 'markets';
  const name = clean(input.name, 60) || r.name.slice(0, 60);
  const fav = input.favorite === false ? 0 : 1;
  await env.DB.prepare(
    `INSERT INTO news_sources(kind,url,name,topics,enabled,favorite,added_by,created_at) VALUES(?,?,?,?,1,?,?,?)
     ON CONFLICT(url) DO UPDATE SET name=excluded.name, topics=excluded.topics, enabled=1, favorite=excluded.favorite`
  ).bind(r.kind, r.url, name, topics, fav, by, Date.now()).run();
  const row = await env.DB.prepare('SELECT id FROM news_sources WHERE url=?').bind(r.url).first<{ id: number }>();
  return { id: row?.id ?? 0, kind: r.kind, url: r.url, name };
}
export async function updateSource(env: Env, id: number, patch: { enabled?: boolean; favorite?: boolean; topics?: string }): Promise<void> {
  const sets: string[] = [], args: unknown[] = [];
  if (patch.enabled != null) { sets.push('enabled=?'); args.push(patch.enabled ? 1 : 0); }
  if (patch.favorite != null) { sets.push('favorite=?'); args.push(patch.favorite ? 1 : 0); }
  if (patch.topics != null) { sets.push('topics=?'); args.push(String(patch.topics).split(',').map(s => s.trim().toLowerCase()).filter(t => (TOPICS as readonly string[]).includes(t)).join(',') || 'markets'); }
  if (!sets.length) return;
  if (patch.enabled) sets.push('fails=0');
  await env.DB.prepare(`UPDATE news_sources SET ${sets.join(',')} WHERE id=?`).bind(...args, id).run();
}
export async function deleteSource(env: Env, id: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM news_items WHERE source_id=?').bind(id),
    env.DB.prepare('DELETE FROM news_sources WHERE id=?').bind(id),
  ]);
}
