/* ================================================================
   PODCAST + VIDEO DIGESTS — full-episode summaries from YouTube captions (map → reduce)
   runs in the :x7 maintenance slot whenever no daily job is due (≈ 140 idle slots a day),
   one step per slot, so each step has its own CPU + subrequest budget.
     QUEUE   newest videos from favorite or independent channels, last 4 days, ≤ YT_DAILY a day
     FETCH   watch page → innertube player (ANDROID client) → caption track → timed text
             no captions → the full video description (chapters, links, notes) instead
     MAP     one Workers AI call per ~6k-char chunk: points, themes, assets, claims
     REDUCE  one call over all notes: headline, summary, key points, themes, assets, stance,
             risks, claims, where it differs from consensus
     PUBLISH yt_digest.summary · themes merged into news_items.themes (narrative radar)
             transcript chunks and notes are deleted once the digest exists (nothing is republished)
   ================================================================ */
import type { Env } from '../types';
import { ASSETS, decode } from './crawler';
import { mergeThemes } from './themes';

export const YT_DAILY = 4;                 // episodes per UTC day (Workers AI free allowance)
const CHUNK = 6000, MAX_CHUNKS = 8, SAMPLE_CHARS = 9000;
const MODELS = ['@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3.2-3b-instruct'];
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

export interface Digest {
  headline: string; summary: string; key_points: string[]; themes: string[];
  assets: { asset: string; bias: 'long' | 'short' | 'watch'; why: string }[];
  stance: 'risk-on' | 'risk-off' | 'mixed'; risks: string[]; claims: string[]; contrarian: string;
}
interface Note { points: string[]; themes: string[]; assets: { asset: string; view: string; why: string }[]; claims: string[] }
interface Row { vid: string; item_id: string; source_id: number; title: string; url: string; published: number; status: string; mode: string | null; chunks: string | null; notes: string | null; idx: number; n: number; tries: number; name?: string }

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const strs = (a: unknown, n: number, max: number) => (Array.isArray(a) ? a : []).map(x => clean(x, max)).filter(x => x.length > 2).slice(0, n);

/* ---------- small text helpers (no full JSON.parse of 1 MB pages: Free CPU budget) ---------- */
function jsonArrayAt(s: string, key: string): any[] | null {
  const k = s.indexOf('"' + key + '":[');
  if (k < 0) return null;
  let i = s.indexOf('[', k), depth = 0, inStr = false;
  for (let j = i; j < s.length && j < i + 200000; j++) {
    const c = s[j];
    if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; } } }
  }
  return null;
}
function jsonStringAt(s: string, key: string): string | null {
  const k = s.indexOf('"' + key + '":"');
  if (k < 0) return null;
  const a = k + key.length + 4;
  for (let j = a; j < s.length && j < a + 20000; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '"') { try { return JSON.parse(s.slice(a - 1, j + 1)); } catch { return null; } }
  }
  return null;
}
function vidOf(url: string): string | null {
  return /[?&]v=([\w-]{11})/.exec(url)?.[1] ?? /youtu\.be\/([\w-]{11})/.exec(url)?.[1] ?? /\/(?:shorts|live|embed)\/([\w-]{11})/.exec(url)?.[1] ?? null;
}
async function get(url: string, init: RequestInit = {}, ms = 9000): Promise<Response> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}

/** captions as plain text, or the description when a video has none */
export async function fetchTranscript(vid: string): Promise<{ text: string; mode: 'captions' | 'description'; lang?: string }> {
  const hdr = { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.8', cookie: 'SOCS=CAI; CONSENT=YES+1' };
  const page = await get('https://www.youtube.com/watch?v=' + vid + '&hl=en', { headers: hdr, redirect: 'follow' });
  if (!page.ok) throw new Error('watch page HTTP ' + page.status);
  const html = (await page.text()).slice(0, 1_500_000);
  const desc = jsonStringAt(html, 'shortDescription') ?? '';
  const key = jsonStringAt(html, 'INNERTUBE_API_KEY');
  let tracks: any[] | null = null;
  if (key) {
    // the ANDROID player response carries caption URLs that do not need a browser proof token
    try {
      const pr = await get('https://www.youtube.com/youtubei/v1/player?key=' + encodeURIComponent(key) + '&prettyPrint=false', {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip', 'accept-language': 'en-US' },
        body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en' } }, videoId: vid }),
      });
      if (pr.ok) tracks = jsonArrayAt(await pr.text(), 'captionTracks');
    } catch { /* fall back to the page's own tracks */ }
  }
  if (!tracks?.length) tracks = jsonArrayAt(html, 'captionTracks');
  const pick = (tracks ?? []).filter(t => t?.baseUrl);
  const tr = pick.find(t => /^en/.test(t.languageCode) && t.kind !== 'asr') ?? pick.find(t => /^en/.test(t.languageCode)) ?? pick[0];
  if (tr) {
    const r = await get(String(tr.baseUrl).replace(/&fmt=[^&]*/g, ''), { headers: hdr });
    if (r.ok) {
      const xml = (await r.text()).slice(0, 400_000);   // ~2 h of srv1 captions; keeps parsing inside the Free CPU budget
      // timedtext: <text start dur>…</text> (srv1) or <p t d><s>…</s></p> (srv3)
      const parts = xml.match(/<(?:text|p)\b[^>]*>[\s\S]*?<\/(?:text|p)>/g) ?? [];
      let text = parts.map(p => decode(decode(p.replace(/<[^>]+>/g, ' ')))).join(' ');
      text = text.replace(/\[(?:music|applause|laughter|inaudible)\]/gi, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > 400) return { text, mode: 'captions', lang: tr.languageCode };
    }
  }
  const d = desc.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  return { text: d, mode: 'description' };
}

/** ≤ 48k chars: 6k chunks on word boundaries. longer: 8 evenly spaced 9k windows (covers the whole episode) */
export function chunkText(t: string): string[] {
  const out: string[] = [];
  if (t.length <= CHUNK * MAX_CHUNKS) {
    for (let i = 0; i < t.length;) {
      let j = Math.min(t.length, i + CHUNK);
      if (j < t.length) { const sp = t.lastIndexOf(' ', j); if (sp > i + CHUNK * 0.7) j = sp; }
      out.push(t.slice(i, j).trim()); i = j;
    }
  } else {
    const w = t.length / MAX_CHUNKS;
    for (let k = 0; k < MAX_CHUNKS; k++) { const a = Math.floor(k * w); out.push(t.slice(a, a + SAMPLE_CHARS).replace(/^\S*\s/, '').trim()); }
  }
  return out.filter(c => c.length > 80);
}

/* ---------- AI ---------- */
const MAP_SYS = `You take notes on one part of a podcast or video transcript for a markets research desk. Use only what is said in this part. Never invent numbers.
Reply with ONLY JSON: {"points":["..."],"themes":["..."],"assets":[{"asset":"XAU","view":"bull|bear|neutral","why":"..."}],"claims":["..."]}
points: up to 5 short sentences on what the speakers argue. themes: up to 4 short lowercase noun phrases naming the stories. assets: only codes from ${ASSETS.join(', ')}. claims: up to 3 specific factual or forecast claims, numbers exactly as spoken.`;
const RED_SYS = `You write the final digest of one podcast or video episode for a markets research desk, from section notes in order. Use only the notes. Never invent numbers.
Reply with ONLY JSON: {"headline":"...","summary":"...","key_points":["..."],"themes":["..."],"assets":[{"asset":"XAU","bias":"long|short|watch","why":"..."}],"stance":"risk-on|risk-off|mixed","risks":["..."],"claims":["..."],"contrarian":"..."}
headline ≤ 90 characters. summary 3-4 sentences. key_points up to 8. themes up to 6 short lowercase noun phrases. assets only codes from ${ASSETS.join(', ')}. risks: up to 4 warnings the speakers give. claims: up to 5 specific claims worth checking. contrarian: one sentence on where the view differs from the mainstream consensus, or "".`;

async function ai(env: Env, sys: string, user: string, maxTok: number): Promise<{ o: any; engine: string }> {
  let last = '';
  for (const m of MODELS) {
    try {
      const res: any = await env.AI!.run(m, { messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], max_tokens: maxTok, temperature: 0.1 });
      const raw = String(res?.response ?? '');
      const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
      if (a < 0 || b <= a) throw new Error('no json');
      return { o: JSON.parse(raw.slice(a, b + 1)), engine: m.split('/')[2] };
    } catch (e) { last = String((e as Error)?.message ?? e).slice(0, 120); }
  }
  throw new Error('AI: ' + last);
}
function validNote(o: any): Note {
  return {
    points: strs(o?.points, 5, 260), themes: strs(o?.themes, 4, 40).map(t => t.toLowerCase()), claims: strs(o?.claims, 3, 220),
    assets: (Array.isArray(o?.assets) ? o.assets : []).map((a: any) => ({ asset: String(a?.asset ?? '').toUpperCase(), view: ['bull', 'bear', 'neutral'].includes(a?.view) ? a.view : 'neutral', why: clean(a?.why, 160) }))
      .filter((a: any) => ASSETS.includes(a.asset)).slice(0, 4),
  };
}
export function validDigest(o: any): Digest | null {
  const summary = clean(o?.summary, 900);
  if (summary.length < 40) return null;
  return {
    headline: clean(o?.headline, 110) || summary.slice(0, 90), summary,
    key_points: strs(o?.key_points, 8, 280), themes: strs(o?.themes, 6, 40).map(t => t.toLowerCase()),
    assets: (Array.isArray(o?.assets) ? o.assets : []).map((a: any) => ({ asset: String(a?.asset ?? '').toUpperCase(), bias: ['long', 'short', 'watch'].includes(a?.bias) ? a.bias : 'watch', why: clean(a?.why, 200) }))
      .filter((a: any) => ASSETS.includes(a.asset) && a.why.length > 5).slice(0, 5),
    stance: ['risk-on', 'risk-off', 'mixed'].includes(o?.stance) ? o.stance : 'mixed',
    risks: strs(o?.risks, 4, 220), claims: strs(o?.claims, 5, 240), contrarian: clean(o?.contrarian, 260),
  };
}

/* ---------- one step per call ---------- */
export async function ytStep(env: Env): Promise<{ step: string; vid?: string; note?: string }> {
  if (env.AI_ENABLED === 'false' || !env.AI) return { step: 'off', note: 'AI disabled' };
  const db = env.DB;
  const now = Date.now();
  const row = await db.prepare(`SELECT * FROM yt_digest WHERE status IN ('map','reduce','queued') AND tries < 3
    ORDER BY CASE status WHEN 'reduce' THEN 0 WHEN 'map' THEN 1 ELSE 2 END, published DESC LIMIT 1`).first<Row>();
  if (!row) return queue(env, now);
  // claim the try BEFORE the work: a Free-plan CPU-limit kill cannot be caught, and an unclaimed row
  // would be first in line again on every slot and block the queue. success paths reset tries to 0.
  await db.prepare(`UPDATE yt_digest SET tries=tries+1, updated=? WHERE vid=?`).bind(now, row.vid).run();
  const fail = async (e: unknown) => {
    const msg = String((e as Error)?.message ?? e).slice(0, 160);
    await db.prepare(`UPDATE yt_digest SET err=?, updated=?, status=CASE WHEN tries>=3 THEN 'fail' ELSE status END,
      chunks=CASE WHEN tries>=3 THEN NULL ELSE chunks END, notes=CASE WHEN tries>=3 THEN NULL ELSE notes END WHERE vid=?`).bind(msg, now, row.vid).run();
    return { step: 'error', vid: row.vid, note: msg };
  };
  try {
    if (row.status === 'queued') {
      let t: { text: string; mode: string };
      try { t = await fetchTranscript(row.vid); }
      catch (e) {
        // YouTube sometimes blocks datacenter IPs: after one failed try, fall back to the feed's own description
        if (row.tries < 1) throw e;   // row.tries = tries before this attempt
        const it = await db.prepare('SELECT summary_raw FROM news_items WHERE id=?').bind(row.item_id).first<{ summary_raw: string | null }>();
        t = { text: (it?.summary_raw ?? '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim(), mode: 'feed' };
      }
      if (t.text.length < 300) {
        await db.prepare(`UPDATE yt_digest SET status='skip', mode=?, err='no captions and a short description', tries=0, updated=? WHERE vid=?`).bind(t.mode, now, row.vid).run();
        return { step: 'skip', vid: row.vid };
      }
      const ch = chunkText(t.text);
      await db.prepare(`UPDATE yt_digest SET status='map', mode=?, chunks=?, notes='[]', idx=0, n=?, chars=?, err=NULL, tries=0, updated=? WHERE vid=?`)
        .bind(t.mode, JSON.stringify(ch), ch.length, t.text.length, now, row.vid).run();
      return { step: 'fetched', vid: row.vid, note: t.mode + ' ' + t.text.length + ' chars, ' + ch.length + ' chunks' };
    }
    const src = await db.prepare('SELECT name FROM news_sources WHERE id=?').bind(row.source_id).first<{ name: string }>();
    const show = src?.name ?? 'YouTube';
    if (row.status === 'map') {
      const chunks: string[] = JSON.parse(row.chunks ?? '[]');
      const notes: Note[] = JSON.parse(row.notes ?? '[]');
      const i = row.idx;
      if (i >= chunks.length) { await db.prepare(`UPDATE yt_digest SET status='reduce', tries=0, updated=? WHERE vid=?`).bind(now, row.vid).run(); return { step: 'mapped', vid: row.vid }; }
      const r = await ai(env, MAP_SYS, `Show: ${show}\nEpisode: ${row.title}\n${row.mode !== 'captions' ? 'Video description' : 'Transcript part ' + (i + 1) + ' of ' + chunks.length}:\n${chunks[i]}`, 450);
      notes.push(validNote(r.o));
      const next = i + 1;
      await db.prepare(`UPDATE yt_digest SET notes=?, idx=?, status=?, engine=?, tries=0, updated=? WHERE vid=?`)
        .bind(JSON.stringify(notes), next, next >= chunks.length ? 'reduce' : 'map', r.engine, now, row.vid).run();
      return { step: 'map', vid: row.vid, note: next + '/' + chunks.length };
    }
    // reduce
    const notes: Note[] = JSON.parse(row.notes ?? '[]');
    if (!notes.length) throw new Error('no notes');
    const compact = notes.map((n, k) => `Part ${k + 1}: ` + JSON.stringify(n)).join('\n');
    const r = await ai(env, RED_SYS, `Show: ${show}\nEpisode: ${row.title}\nSource: ${row.mode === 'captions' ? 'full transcript' : 'video description only'}\nNotes:\n${compact.slice(0, 14000)}`, 900);
    const d = validDigest(r.o);
    if (!d) throw new Error('digest failed validation');
    const it = await db.prepare('SELECT themes FROM news_items WHERE id=?').bind(row.item_id).first<{ themes: string | null }>();
    await db.batch([
      db.prepare(`UPDATE yt_digest SET status='done', summary=?, engine=?, chunks=NULL, notes=NULL, err=NULL, tries=0, updated=? WHERE vid=?`).bind(JSON.stringify(d), r.engine, now, row.vid),
      db.prepare('UPDATE news_items SET themes=? WHERE id=?').bind(mergeThemes(it?.themes ?? null, d.themes) || null, row.item_id),
    ]);
    return { step: 'done', vid: row.vid, note: d.headline };
  } catch (e) { return fail(e); }
}

/** pick up to 2 new episodes (favorites or independent channels), respecting the daily cap */
async function queue(env: Env, now: number): Promise<{ step: string; note?: string }> {
  const day0 = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z');
  const today = await env.DB.prepare('SELECT COUNT(*) n FROM yt_digest WHERE created >= ?').bind(day0).first<{ n: number }>();
  const room = YT_DAILY - (today?.n ?? 0);
  if (room <= 0) return { step: 'idle', note: 'daily cap reached' };
  const rs = (await env.DB.prepare(
    `SELECT i.id, i.url, i.title, i.published, i.source_id FROM news_items i JOIN news_sources s ON s.id=i.source_id
     WHERE s.kind='youtube' AND s.enabled=1 AND (s.favorite=1 OR s.cls='independent') AND i.published > ?
       AND NOT EXISTS (SELECT 1 FROM yt_digest d WHERE d.item_id=i.id)
     ORDER BY s.favorite DESC, i.published DESC LIMIT ?`
  ).bind(now - 4 * 864e5, Math.min(2, room)).all<{ id: string; url: string; title: string; published: number; source_id: number }>()).results ?? [];
  const add = rs.map(r => ({ ...r, vid: vidOf(r.url) })).filter(r => r.vid);
  if (!add.length) return { step: 'idle', note: 'nothing new' };
  await env.DB.batch(add.map(r => env.DB.prepare(
    `INSERT OR IGNORE INTO yt_digest (vid, item_id, source_id, title, url, published, status, created, updated) VALUES (?,?,?,?,?,?, 'queued', ?, ?)`
  ).bind(r.vid, r.id, r.source_id, r.title, r.url, r.published, now, now)));
  return { step: 'queued', note: add.length + ' episodes' };
}

/* ---------- reader ---------- */
export async function listEpisodes(env: Env, limit = 12): Promise<{ episodes: any[]; queue: { status: string; n: number }[] }> {
  const [rs, q] = await Promise.all([
    env.DB.prepare(`SELECT d.vid, d.title, d.url, d.published, d.mode, d.chars, d.summary, d.engine, d.updated, s.name source, s.cls, i.thumb
      FROM yt_digest d LEFT JOIN news_sources s ON s.id=d.source_id LEFT JOIN news_items i ON i.id=d.item_id
      WHERE d.status='done' ORDER BY d.published DESC LIMIT ?`).bind(limit).all<any>(),
    env.DB.prepare(`SELECT status, COUNT(*) n FROM yt_digest WHERE updated > ? GROUP BY status`).bind(Date.now() - 7 * 864e5).all<{ status: string; n: number }>(),
  ]);
  return {
    episodes: (rs.results ?? []).map(r => { let s: Digest | null = null; try { s = JSON.parse(r.summary); } catch { s = null; } return { ...r, summary: s }; }).filter(r => r.summary),
    queue: q.results ?? [],
  };
}
