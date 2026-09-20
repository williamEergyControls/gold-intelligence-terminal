import type { AnalyticsResult, Env, WhyGold } from '../types';

const SYSTEM = `You are the AI Analyst inside a financial research terminal.
RULES (absolute):
1. Use ONLY the numbers provided in the JSON. Never invent, estimate or round into new figures.
2. Explain what the computed metrics mean and how they conflict or reinforce.
3. Maximum 6 short lines. No preamble.
4. End with exactly: NOT FINANCIAL ADVICE.
5. If the data is simulated or stale, say so in one clause.
6. If an 'ml' object is present, reference its probability, regime and agent agreement; never replace them with your own estimate.`;

// Model fallback chain — Cloudflare rotates/retires model IDs over time.
// If all fail, the errors are RETURNED in aiErrors so the reason is visible.
const MODELS = [
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3-8b-instruct',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/mistral/mistral-7b-instruct-v0.1',
];

function template(a: AnalyticsResult, w: WhyGold): string {
  const L: string[] = [];
  L.push(`Composite ${a.scores.composite}/100 (${a.label}). Trend ${a.scores.trend}, momentum ${a.scores.momentum} (RSI ${a.indicators.rsi14}).`);
  L.push(a.scores.volatilityRisk > 65 ? `Volatility elevated: ${a.indicators.annVolPct}% annualized, drawdown ${a.indicators.currentDrawdownPct}% from peak.` : `Volatility contained at ${a.indicators.annVolPct}% annualized.`);
  L.push(`Attribution: ${w.drivers.slice(0, 2).map(d => `${d.name} ${d.delta}`).join('; ')} — confidence ${w.confidence}%.`);
  L.push(a.scores.composite >= 60 ? 'Trend and momentum reinforce; primary risk is positioning and mean reversion.' : 'Trend and momentum do not reinforce; risk of chop.');
  L.push(`Generated deterministically from computed metrics. NOT FINANCIAL ADVICE.`);
  return L.join('\n');
}

async function runModel(env: Env, model: string, messages: { role: string; content: string }[], maxTokens: number): Promise<string> {
  const res: any = await env.AI!.run(model, { messages, max_tokens: maxTokens, temperature: 0.2 });
  const text = String(res?.response ?? res?.result ?? '').trim();
  if (!text) throw new Error('empty response');
  return text;
}

export async function aiAnalyst(env: Env, a: AnalyticsResult, w: WhyGold, extra: Record<string, unknown>):
  Promise<{ text: string; engine: string; ts: number; aiEnabled: boolean; aiErrors?: string[] }> {
  const payload = { symbol: a.symbol, price: a.last, source: a.source, delay: a.delay, scores: a.scores, indicators: a.indicators, why: { confidence: w.confidence, drivers: w.drivers }, ...extra, ml: (extra as any).ml ?? null };
  if (env.AI_ENABLED === 'false' || !env.AI) return { text: template(a, w), engine: 'deterministic-template', ts: Date.now(), aiEnabled: false };
  const errors: string[] = [];
  for (const m of MODELS) {
    try {
      const text = await runModel(env, m, [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(payload) }], 380);
      return { text, engine: 'workers-ai/' + m.split('/')[2], ts: Date.now(), aiEnabled: true };
    } catch (e) { errors.push(m.split('/')[2] + ': ' + String((e as Error).message).slice(0, 90)); }
  }
  return { text: template(a, w), engine: 'deterministic-template (AI unavailable)', ts: Date.now(), aiEnabled: false, aiErrors: errors };
}

/* ---- HOURLY LLAMA NEWS SENTIMENT (cron-only, ~1 AI call/hour, free quota) ---- */
export async function newsSentimentHourly(env: Env): Promise<void> {
  try {
    if (!env.AI) return;
    const cached = (await env.CACHE.get('news', 'json')) as any;
    const all = Array.isArray(cached) ? cached : (cached?.v ?? cached?.news ?? []); // unwrap AppCache envelope
    const items = (Array.isArray(all) ? all : []).filter((n: any) => n?.topic === 'gold').slice(0, 10) as { id: string; title: string }[];
    if (!items.length) return;
    const prompt = 'Classify each headline by its implication for GOLD prices. Reply with ONLY a JSON array, one object per headline in the same order, format: {"i":<index>,"s":"bull"|"bear"|"neutral"}. No other text.\n' + items.map((it, i) => `${i}. ${it.title}`).join('\n');
    let out: { i: number; s: string }[] | null = null;
    for (const m of MODELS) {
      try {
        const raw = await runModel(env, m, [{ role: 'user', content: prompt }], 500);
        const arr = raw.match(/\[[\s\S]*\]/);
        if (arr) { out = JSON.parse(arr[0]); break; }
      } catch { /* try next model */ }
    }
    if (!out) return;
    await env.CACHE.put('news:sentiment', JSON.stringify({
      ts: Date.now(),
      items: items.map((it, i) => ({ id: it.id, s: String(out!.find(o => o.i === i)?.s ?? 'neutral').toLowerCase() })),
    }), { expirationTtl: 172800 });
  } catch { /* never break the cron */ }
}
