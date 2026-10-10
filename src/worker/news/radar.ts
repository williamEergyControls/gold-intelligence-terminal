/* ================================================================
   NARRATIVE RADAR — what independent voices (YouTube, podcasts) talk about vs the mainstream
   INIT     14 days of news_items with themes (canonical tags at crawl + AI themes + episode digests)
   COUNT    per theme and class: items, first seen, last 72 h vs the 11 days before, tone
   EVALUATE ahead       independent ≥ 2 and mainstream silent, or independent first by ≥ 24 h
            louder      independent share of its own coverage ≥ 2× mainstream share (both present)
            mainstream  mainstream ≥ 4, independent silent
            tone        both ≥ 2 and net tone differs by ≥ 0.5 (bull − bear over items)
            rising      ≥ 3 items in 72 h and ≥ 2× the earlier daily rate
   PUBLISH  /api/news/radar (shared D1 cache, 30 min) — one 14-day read, a few ms of CPU
   ================================================================ */
import type { Env } from '../types';

interface R { themes: string | null; published: number; sentiment: string | null; cls: string | null; title: string; url: string; name: string }
interface Agg { n: number; first: number; last: number; bull: number; bear: number; recent: number; ex: { title: string; url: string; source: string; published: number }[] }
const mk = (): Agg => ({ n: 0, first: Infinity, last: 0, bull: 0, bear: 0, recent: 0, ex: [] });

export interface RadarTheme {
  theme: string; ind: number; main: number; indFirst: number | null; mainFirst: number | null; leadH: number | null;
  indTone: number | null; mainTone: number | null; recent: number; prior: number; ratio: number | null;
  exInd: Agg['ex']; exMain: Agg['ex'];
}

export async function buildRadar(env: Env): Promise<{
  ts: number; window: { days: number; ind: number; main: number; indSources: number; mainSources: number };
  ahead: RadarTheme[]; louder: RadarTheme[]; mainstream: RadarTheme[]; tone: RadarTheme[]; rising: RadarTheme[]; all: RadarTheme[];
}> {
  const now = Date.now(), DAYS = 14, RECENT = 3 * 864e5;
  const rs = (await env.DB.prepare(
    `SELECT i.themes, i.published, i.sentiment, i.title, i.url, s.cls, s.name FROM news_items i JOIN news_sources s ON s.id=i.source_id
     WHERE i.published > ? AND i.themes IS NOT NULL AND i.themes != '' ORDER BY i.published DESC LIMIT 6000`
  ).bind(now - DAYS * 864e5).all<R>()).results ?? [];
  const m = new Map<string, { ind: Agg; main: Agg }>();
  let nInd = 0, nMain = 0; const sInd = new Set<string>(), sMain = new Set<string>();
  for (const r of rs) {
    const ind = r.cls === 'independent';
    if (ind) { nInd++; sInd.add(r.name); } else { nMain++; sMain.add(r.name); }
    for (const t of (r.themes ?? '').split(',')) {
      if (!t) continue;
      let e = m.get(t); if (!e) { e = { ind: mk(), main: mk() }; m.set(t, e); }
      const a = ind ? e.ind : e.main;
      a.n++; a.first = Math.min(a.first, r.published); a.last = Math.max(a.last, r.published);
      if (r.sentiment === 'bull') a.bull++; else if (r.sentiment === 'bear') a.bear++;
      if (now - r.published < RECENT) a.recent++;
      // rows arrive newest first, so the first three per theme are the newest examples
      if (a.ex.length < 3) a.ex.push({ title: r.title, url: r.url, source: r.name, published: r.published });
    }
  }
  const tone = (a: Agg) => (a.bull + a.bear >= 2 ? (a.bull - a.bear) / a.n : null);
  const all: RadarTheme[] = [];
  for (const [theme, { ind, main }] of m) {
    const n = ind.n + main.n; if (n < 2) continue;
    const recent = ind.recent + main.recent, prior = n - recent;
    const shInd = nInd ? ind.n / nInd : 0, shMain = nMain ? main.n / nMain : 0;
    all.push({
      theme, ind: ind.n, main: main.n,
      indFirst: ind.n ? ind.first : null, mainFirst: main.n ? main.first : null,
      leadH: ind.n && main.n ? Math.round((main.first - ind.first) / 36e5) : null,
      indTone: tone(ind), mainTone: tone(main), recent, prior,
      ratio: shMain > 0 ? +(shInd / shMain).toFixed(2) : null,
      exInd: ind.ex.sort((x, y) => y.published - x.published), exMain: main.ex.sort((x, y) => y.published - x.published),
    });
  }
  const byInd = (a: RadarTheme, b: RadarTheme) => b.ind - a.ind || b.recent - a.recent;
  const ahead = all.filter(t => t.ind >= 2 && (t.main === 0 || (t.leadH != null && t.leadH >= 24))).sort(byInd).slice(0, 10);
  const louder = all.filter(t => t.ind >= 3 && t.main >= 1 && t.ratio != null && t.ratio >= 2 && !ahead.includes(t)).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0)).slice(0, 8);
  const mainstream = all.filter(t => t.main >= 4 && t.ind === 0).sort((a, b) => b.main - a.main).slice(0, 8);
  const toneGap = all.filter(t => t.ind >= 2 && t.main >= 2 && t.indTone != null && t.mainTone != null && Math.abs(t.indTone - t.mainTone) >= 0.5)
    .sort((a, b) => Math.abs((b.indTone ?? 0) - (b.mainTone ?? 0)) - Math.abs((a.indTone ?? 0) - (a.mainTone ?? 0))).slice(0, 8);
  const rising = all.filter(t => t.recent >= 3 && t.recent / 3 >= 2 * Math.max(t.prior / (DAYS - 3), 0.15)).sort((a, b) => b.recent - a.recent).slice(0, 8);
  all.sort((a, b) => (b.ind + b.main) - (a.ind + a.main));
  return {
    ts: now, window: { days: DAYS, ind: nInd, main: nMain, indSources: sInd.size, mainSources: sMain.size },
    ahead, louder, mainstream, tone: toneGap, rising, all: all.slice(0, 40),
  };
}
