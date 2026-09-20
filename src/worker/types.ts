export type Delay =
  | 'realtime' | 'near-live' | 'delayed' | 'eod' | 'daily'
  | 'monthly' | 'reference' | 'event-driven' | 'simulated';
export type Tf = '5M' | '15M' | '1H' | '1D' | '1W';

export interface Quote {
  symbol: string; name?: string;
  price: number; prevClose?: number; change?: number; changePct?: number;
  open?: number; high?: number; low?: number; volume?: number;
  bid?: number; ask?: number;
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
  topic: 'gold' | 'mining' | 'macro' | 'energy' | 'agri';
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
  latencyMs: number | null;
  status: 'online' | 'degraded' | 'offline' | 'idle' | 'not-configured';
}
export interface AlertItem { se: 'crit' | 'warn' | 'info'; t: string; txt: string; cat: string }
export interface Bootstrap {
  mode: 'live' | 'simulated'; builtAt: number; tf: Tf;
  gold: Quote; silver: Quote; dxy: Quote; ratio: number | null; tape: Quote[];
  candles: Candle[];
  miners: Quote[];
  fx: Quote[];
  series: { goldIdx: number[]; dxyIdx: number[]; ryIdx: number[]; ratio: number[]; dailyCloses: number[] };
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

/* ===== EXPANSION: page payloads (ENERGY / AGRI) ===== */
export interface SpotCard { symbol: string; name: string; price: number; changePct: number; note: string }
export interface PagePayload {
  mode: 'live' | 'simulated'; builtAt: number;
  hero: Quote; tape: Quote[]; monitor: (Quote & { unit: string })[];
  spotlights: SpotCard[];
  ratios: { label: string; value: number; unit: string }[];
  spreads: { label: string; value: string; change: string | null }[];
  eia?: { label: string; value: number; unit: string; asOf: string; change: number | null }[];
  water?: { nqH2o: { value: number; prior: number; asOf: string } | null; levels: { site: string; name: string; gageFt: number; ts: number }[] };
  weather?: { tempC: number; windKph: number; code: number; daily: { date: string; tmax: number; tmin: number; precip: number }[] };
  news: NewsItem[];
  calendar: { when: string; event: string; note: string }[];
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
  EIA_API_KEY?: string;
  GOLDAPI_KEY?: string;
  AI_ENABLED?: string;
  METALS_TTL?: string;
  ADMIN_TOKEN?: string;
}
