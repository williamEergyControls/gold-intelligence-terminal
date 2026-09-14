export type Delay =
  | 'realtime' | 'near-live' | 'delayed' | 'eod' | 'daily'
  | 'monthly' | 'reference' | 'event-driven' | 'simulated';
export type Tf = '5M' | '15M' | '1H' | '1D' | '1W';

export interface Quote {
  symbol: string; name?: string;
  price: number; prevClose?: number; change?: number; changePct?: number;
  open?: number; high?: number; low?: number; volume?: number;
  currency: string; unit?: string;
  source: string; delay: Delay; ts: number;
  wkHigh?: number; wkLow?: number;
}
export interface Candle { t: number; o: number; h: number; l: number; c: number; v?: number }

export interface MacroRow {
  key: string; label: string; value: number; prior: number;
  unit: 'pct' | 'bp' | 'level'; freq: string;
  source: string; delay: Delay; asOf: string; spark: number[];
}
export interface NewsItem {
  id: string; title: string; source: string; url: string; publishedTs: number;
  topic: 'gold' | 'mining' | 'macro';
  sentiment: 'bull' | 'bear' | 'neutral'; sentimentNote: string;
}
export interface Driver { name: string; delta: string; dir: -1 | 0 | 1; magnitude: number }
export interface WhyGold {
  movePct: number; drivers: Driver[]; evidence: string[]; counter: string[];
  confidence: number; method: string; ts: number;
}
export interface AnalyticsResult {
  symbol: string; ts: number; last: number; source: string; delay: Delay;
  indicators: {
    sma20: number | null; sma50: number | null; sma200: number | null;
    rsi14: number; macdHist: number; atr14: number; annVolPct: number;
    maxDrawdownPct: number; currentDrawdownPct: number;
    distTo52wHighPct: number; volumeZ: number | null;
  };
  scores: {
    trend: number; momentum: number; volume: number;
    volatilityRisk: number; drawdownRisk: number; relativeStrength: number;
    composite: number;
  };
  label: 'STRONG' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'WEAK';
}
export interface ProviderStatus {
  name: string; configured: boolean; delay: Delay | null;
  lastSuccess: number | null; lastFailure: number | null;
  latencyMs: number | null; status: 'online' | 'degraded' | 'offline' | 'not-configured';
}
export interface AlertItem { se: 'crit' | 'warn' | 'info'; t: string; txt: string; cat: string }
export interface Bootstrap {
  mode: 'live' | 'simulated'; builtAt: number; tf: Tf;
  gold: Quote; silver: Quote; dxy: Quote; ratio: number | null; tape: Quote[];
  candles: Candle[];
  miners: Quote[];
  fx: Quote[];
  series: { goldIdx: number[]; dxyIdx: number[]; ryIdx: number[]; ratio: number[] };
  corr: { dxy: number | null; ry: number | null };
  macro: {
    rows: MacroRow[];
    cpiBreakdown: { label: string; yoy: number; source: string }[];
    components: Record<string, number>;
  };
  realeconomy: { periods: Record<string, Record<string, number>> };
  alerts: AlertItem[];
  news: { gold: NewsItem[]; mining: NewsItem[]; macro: NewsItem[] };
  reference: {
    shipping: { label: string; value: string; delta: string; deltaDir: 1 | -1; typetag: string; note: string }[];
    insurance: { line: string; yoy: number; pressure: number; tag: string }[];
    centralBanks: { bank: string; rate: string; next: string; stance: string; gold: string }[];
    calendar: { when: string; event: string; cons: string; prior: string; imp: number; ts: number }[];
  };
  analytics: AnalyticsResult;
  why: WhyGold;
  health: ProviderStatus[];
}

export interface Env {
  CACHE: KVNamespace;
  DB: D1Database;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  METALS_API_KEY?: string;
  FRED_API_KEY?: string;
  BLS_API_KEY?: string;
  SEC_USER_AGENT?: string;
  AI_ENABLED?: string;
}
