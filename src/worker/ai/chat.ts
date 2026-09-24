import type { Bootstrap, Env } from '../types';

const SYS = `You are a desk analyst on a gold research terminal. Answer using ONLY the data in the context.
Rules: 1. Reference exact figures from the data. 2. Max 8 lines. 3. End with: NOT FINANCIAL ADVICE.`;

export async function agentChat(env: Env, messages: any[] | undefined, boot: Bootstrap, stale: boolean): Promise<{ reply: string; engine: string; stale: boolean }> {
  if (!env.AI) return { reply: 'AI not configured. Set AI_ENABLED=true and ensure the AI binding exists.', engine: 'none', stale };
  const safe = (messages || []).filter(m => m && typeof m.role === 'string' && typeof m.content === 'string').slice(-8).map(m => ({ role: m.role === 'user' || m.role === 'assistant' ? m.role : 'user', content: m.content.slice(0, 2000) }));
  if (!safe.length) return { reply: 'No messages provided.', engine: 'none', stale };
  const ctx = {
    gold: { price: boot.gold.price, changePct: boot.gold.changePct, source: boot.gold.source },
    dxy: { price: boot.dxy.price, changePct: boot.dxy.changePct },
    macro: boot.macro.rows.slice(0, 8).map(r => ({ k: r.key, v: r.value, p: r.prior })),
    why: { confidence: boot.why.confidence, drivers: boot.why.drivers.slice(0, 3) },
    newsSent: { bull: (boot.news.gold || []).filter(n => n.sentiment === 'bull').length, bear: (boot.news.gold || []).filter(n => n.sentiment === 'bear').length },
  };
  try {
    const res: any = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'system', content: SYS + '\n\nMARKET CONTEXT:\n' + JSON.stringify(ctx) }, ...safe],
      max_tokens: 400, temperature: 0.3,
    });
    return { reply: String(res?.response || '').trim() || 'No response.', engine: 'llama-3.1-8b', stale };
  } catch (e) {
    return { reply: 'AI temporarily unavailable. Error: ' + String((e as Error).message).slice(0, 100), engine: 'error', stale };
  }
}
