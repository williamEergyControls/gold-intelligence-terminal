import type { Env, NewsItem } from '../types';
import { fetchJson } from './provider';

const QUERIES: Record<string, string> = {
  gold: 'gold price OR "gold market" sourcelang:english',
  mining: '"gold mining" OR newmont OR barrick OR agnico sourcelang:english',
  macro: 'inflation OR "federal reserve" OR CPI OR "central bank" sourcelang:english',
};
const POS = ['rally', 'surge', 'record', 'gain', 'rise', 'jumps', 'boost', 'strong', 'buying'];
const NEG = ['plunge', 'slump', 'fall', 'drops', 'crisis', 'war', 'fear', 'weak', 'selling', 'default'];

export async function gdeltNews(_env: Env, topics: string[]): Promise<NewsItem[]> {
  const all: NewsItem[] = [];
  for (const topic of topics) {
    const q = QUERIES[topic];
    if (!q) continue;
    const j = await fetchJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=8&format=json&timespan=1d`);
    for (const a of j?.articles ?? []) {
      const title: string = String(a.title ?? '').trim();
      if (!title || !a.url) continue;
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(a.seendate ?? ''));
      const ts = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.now();
      const low = title.toLowerCase();
      const p = POS.filter(w => low.includes(w)).length, n = NEG.filter(w => low.includes(w)).length;
      const sentiment = p > n ? 'bull' : n > p ? 'bear' : 'neutral';
      all.push({
        id: String(a.url), title, source: `GDELT · ${a.domain ?? 'web'}`, url: String(a.url),
        publishedTs: ts, topic: topic as NewsItem['topic'],
        sentiment, sentimentNote: 'KEYWORD HEURISTIC (not a model)',
      });
    }
  }
  if (!all.length) throw new Error('gdelt: no articles');
  return all.sort((a, b) => b.publishedTs - a.publishedTs).slice(0, 24);
}
