import type { AnalyticsResult, Env, WhyGold } from '../types';

const SYSTEM = `You are the AI Analyst inside a financial research terminal.
RULES (absolute):
1. Use ONLY the numbers provided in the JSON. Never invent, estimate or round into new figures.
2. Explain what the computed metrics mean and how they conflict or reinforce.
3. Maximum 6 short lines. No preamble.
4. End with exactly: NOT FINANCIAL ADVICE.
5. If the data is simulated or stale, say so in one clause.`;

// Deterministic fallback — the product NEVER depends on the model being available.
function template(a: AnalyticsResult, w: WhyGold): string {
  const L: string[] = [];
  L.push(`Composite ${a.scores.composite}/100 (${a.label}). Trend ${a.scores.trend}, momentum ${a.scores.momentum} (RSI ${a.indicators.rsi14}).`);
  L.push(a.scores.volatilityRisk > 65 ? `Volatility elevated: ${a.indicators.annVolPct}% annualized, drawdown ${a.indicators.currentDrawdownPct}% from peak.` : `Volatility contained at ${a.indicators.annVolPct}% annualized.`);
  L.push(`Attribution: ${w.drivers.slice(0, 2).map(d => `${d.name} ${d.delta}`).join('; ')} — confidence ${w.confidence}%.`);
  L.push(a.scores.composite >= 60 ? 'Trend and momentum reinforce; primary risk is positioning and mean reversion.' : 'Trend and momentum do not reinforce; risk of chop.');
  L.push(`Generated deterministically from computed metrics. NOT FINANCIAL ADVICE.`);
  return L.join('\n');
}

export async function aiAnalyst(env: Env, a: AnalyticsResult, w: WhyGold, extra: Record<string, unknown>):
  Promise<{ text: string; engine: string; ts: number; aiEnabled: boolean }> {
  const payload = { symbol: a.symbol, price: a.last, source: a.source, delay: a.delay, scores: a.scores, indicators: a.indicators, why: { confidence: w.confidence, drivers: w.drivers }, ...extra };
  if (env.AI_ENABLED === 'false' || !env.AI) return { text: template(a, w), engine: 'deterministic-template', ts: Date.now(), aiEnabled: false };
  try {
    const res: any = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(payload) }],
      max_tokens: 380, temperature: 0.2,
    });
    const text = String(res?.response ?? '').trim();
    if (!text) throw new Error('empty');
    return { text, engine: 'workers-ai/llama-3.1-8b-instruct', ts: Date.now(), aiEnabled: true };
  } catch {
    return { text: template(a, w), engine: 'deterministic-template (AI unavailable)', ts: Date.now(), aiEnabled: false };
  }
}
