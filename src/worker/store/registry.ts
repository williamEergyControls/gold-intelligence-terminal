/* ================================================================
   SERIES REGISTRY — the poll list for the D1 time-series warehouse.
   SCADA analogy: each UNIT is one poll (one upstream request) with its
   own scan class (cadenceMin). a unit can return several tags (series).
   every series keyed by id; one point per observation date (UTC ms).
   ================================================================ */

export type SeriesKind =
  | 'price'   // traded price → log returns, % vol
  | 'yield'   // percent level → bp changes, bp vol
  | 'rate'    // policy rate level (no vol table)
  | 'index'   // vol index level (VIX, MOVE…) → level percentile + vol-of-vol
  | 'peg'     // stablecoin price ≈ 1 → deviation in bp
  | 'mcap'    // market cap (USD)
  | 'cpi';    // monthly index → YoY, MoM, MoM vol
export type VolClass = 'rates' | 'fx' | 'stable' | 'insurance' | 'equity' | 'commod';
export type SeriesClass = VolClass | 'aux';
export type Source = 'yahoo' | 'fred' | 'frankfurter' | 'coingecko';

export interface SeriesDef {
  id: string; label: string; cls: SeriesClass; kind: SeriesKind;
  unit: string; freq: 'daily' | 'monthly'; tradingDays: 252 | 365;
}
export interface UnitDef {
  key: string; source: Source; arg: string; cadenceMin: number;
  backfillDays: number; series: SeriesDef[];
}

const d = (id: string, label: string, cls: SeriesClass, kind: SeriesKind, unit: string, freq: 'daily' | 'monthly' = 'daily', tradingDays: 252 | 365 = 252): SeriesDef =>
  ({ id, label, cls, kind, unit, freq, tradingDays });

const Y = (sym: string, s: SeriesDef, cadenceMin = 30): UnitDef =>
  ({ key: 'yahoo:' + sym, source: 'yahoo', arg: sym, cadenceMin, backfillDays: 730, series: [s] });
const F = (sid: string, s: SeriesDef, cadenceMin: number, backfillDays: number): UnitDef =>
  ({ key: 'fred:' + sid, source: 'fred', arg: sid, cadenceMin, backfillDays, series: [s] });
const CG = (coin: string, sym: string, label: string): UnitDef => ({
  key: 'coingecko:' + coin, source: 'coingecko', arg: coin, cadenceMin: 60, backfillDays: 365,
  series: [d(sym, label, 'stable', 'peg', 'USD', 'daily', 365), d(sym + '.MCAP', label + ' market cap', 'stable', 'mcap', 'USD', 'daily', 365)],
});

export const FX_QUOTED_INVERT = ['EUR', 'GBP', 'AUD']; // Frankfurter gives USD→XXX; these are quoted XXX/USD

export const UNITS: UnitDef[] = [
  /* ---------- RATES (FRED daily, 1 business-day lag) ---------- */
  F('DGS3MO', d('UST3M', 'UST 3M yield', 'rates', 'yield', '%'), 360, 1825),
  F('DGS2', d('UST2Y', 'UST 2Y yield', 'rates', 'yield', '%'), 360, 1825),
  F('DGS5', d('UST5Y', 'UST 5Y yield', 'rates', 'yield', '%'), 360, 1825),
  F('DGS10', d('UST10Y', 'UST 10Y yield', 'rates', 'yield', '%'), 360, 1825),
  F('DGS30', d('UST30Y', 'UST 30Y yield', 'rates', 'yield', '%'), 360, 1825),
  F('DFII10', d('TIPS10Y', '10Y real yield (TIPS)', 'rates', 'yield', '%'), 360, 1825),
  F('T10YIE', d('BE10Y', '10Y breakeven inflation', 'rates', 'yield', '%'), 360, 1825),
  Y('^MOVE', d('MOVE', 'MOVE index (UST implied vol)', 'rates', 'index', 'bp')),
  F('DFEDTARL', d('FEDLO', 'Fed funds target low', 'aux', 'rate', '%'), 720, 400),
  F('DFEDTARU', d('FEDHI', 'Fed funds target high', 'aux', 'rate', '%'), 720, 400),
  F('ECBDFR', d('ECBDFR', 'ECB deposit facility rate', 'aux', 'rate', '%'), 720, 400),

  /* ---------- FX (ECB reference via Frankfurter: 1 call = 8 pairs) ---------- */
  {
    key: 'frankfurter:majors', source: 'frankfurter', arg: 'EUR,JPY,GBP,CAD,AUD,CNY,CHF,MXN', cadenceMin: 360, backfillDays: 730,
    series: [
      d('EURUSD', 'EUR/USD', 'fx', 'price', 'USD'), d('USDJPY', 'USD/JPY', 'fx', 'price', 'JPY'),
      d('GBPUSD', 'GBP/USD', 'fx', 'price', 'USD'), d('USDCAD', 'USD/CAD', 'fx', 'price', 'CAD'),
      d('AUDUSD', 'AUD/USD', 'fx', 'price', 'USD'), d('USDCNY', 'USD/CNY', 'fx', 'price', 'CNY'),
      d('USDCHF', 'USD/CHF', 'fx', 'price', 'CHF'), d('USDMXN', 'USD/MXN', 'fx', 'price', 'MXN'),
    ],
  },
  Y('DX-Y.NYB', d('DXY', 'US dollar index (DXY)', 'fx', 'price', 'index')),

  /* ---------- STABLECOINS (CoinGecko public, 365d history limit) ---------- */
  CG('tether', 'USDT', 'Tether USDT'),
  CG('usd-coin', 'USDC', 'USD Coin'),
  CG('dai', 'DAI', 'Dai'),
  CG('ethena-usde', 'USDE', 'Ethena USDe'),
  CG('first-digital-usd', 'FDUSD', 'First Digital USD'),
  CG('paypal-usd', 'PYUSD', 'PayPal USD'),

  /* ---------- INSURANCE (BLS CPI / PPI via FRED, monthly) ---------- */
  F('CUSR0000SETE', d('INS_AUTO', 'CPI motor vehicle insurance', 'insurance', 'cpi', 'index', 'monthly'), 1440, 5475),
  F('CUUR0000SEHD', d('INS_HOME', "CPI tenants' & household insurance", 'insurance', 'cpi', 'index', 'monthly'), 1440, 5475),
  F('CUUR0000SEME', d('INS_HEALTH', 'CPI health insurance', 'insurance', 'cpi', 'index', 'monthly'), 1440, 5475),
  F('PCU524126524126', d('INS_PC_PPI', 'PPI direct P&C insurers', 'insurance', 'cpi', 'index', 'monthly'), 1440, 5475),
  F('CPIAUCSL', d('CPI_ALL', 'CPI all items (benchmark)', 'insurance', 'cpi', 'index', 'monthly'), 1440, 5475),
  // CPI components for the home-page "real inflation" basket (were hardcoded 4.2 / 2.7 / -1.9)
  F('CUSR0000SAH1', d('CPI_SHELTER', 'CPI shelter', 'aux', 'cpi', 'index', 'monthly'), 1440, 800),
  F('CPIUFDSL', d('CPI_FOOD', 'CPI food', 'aux', 'cpi', 'index', 'monthly'), 1440, 800),
  F('CPIENGSL', d('CPI_ENERGY', 'CPI energy', 'aux', 'cpi', 'index', 'monthly'), 1440, 800),
  Y('KIE', d('KIE', 'Insurance stocks ETF (KIE)', 'insurance', 'price', 'USD')),

  /* ---------- EQUITIES ---------- */
  Y('^GSPC', d('SPX', 'S&P 500', 'equity', 'price', 'index')),
  Y('^NDX', d('NDX', 'Nasdaq 100', 'equity', 'price', 'index')),
  Y('^RUT', d('RUT', 'Russell 2000', 'equity', 'price', 'index')),
  Y('^VIX', d('VIX', 'VIX (S&P implied vol)', 'equity', 'index', 'vol pts')),
  Y('^VXN', d('VXN', 'VXN (Nasdaq implied vol)', 'equity', 'index', 'vol pts')),
  Y('^VVIX', d('VVIX', 'VVIX (vol of VIX)', 'equity', 'index', 'vol pts'), 60),
  Y('XLK', d('XLK', 'Tech sector (XLK)', 'equity', 'price', 'USD'), 60),
  Y('XLF', d('XLF', 'Financials (XLF)', 'equity', 'price', 'USD'), 60),
  Y('XLE', d('XLE', 'Energy (XLE)', 'equity', 'price', 'USD'), 60),
  Y('XLV', d('XLV', 'Health care (XLV)', 'equity', 'price', 'USD'), 60),
  Y('XLU', d('XLU', 'Utilities (XLU)', 'equity', 'price', 'USD'), 60),
  Y('XLI', d('XLI', 'Industrials (XLI)', 'equity', 'price', 'USD'), 60),

  /* ---------- COMMODITIES (gold desk context + ML inputs) ---------- */
  Y('GC=F', d('GOLD', 'Gold futures (GC)', 'commod', 'price', 'USD/oz')),
  Y('SI=F', d('SILVER', 'Silver futures (SI)', 'commod', 'price', 'USD/oz')),
  Y('CL=F', d('OIL', 'WTI crude futures (CL)', 'commod', 'price', 'USD/bbl')),
  Y('^GVZ', d('GVZ', 'GVZ (gold implied vol)', 'commod', 'index', 'vol pts'), 60),
  Y('^OVX', d('OVX', 'OVX (oil implied vol)', 'commod', 'index', 'vol pts'), 60),
];

export const SERIES: Record<string, SeriesDef & { unitKey: string; source: Source; srcId: string }> = {};
for (const u of UNITS) for (const s of u.series) {
  SERIES[s.id] = { ...s, unitKey: u.key, source: u.source, srcId: u.source === 'frankfurter' ? s.id : u.arg };
}
export const CLASS_IDS = (cls: SeriesClass) => Object.values(SERIES).filter(s => s.cls === cls).map(s => s.id);
export const SOURCE_LABEL: Record<Source, string> = {
  yahoo: 'Yahoo Finance (unofficial)', fred: 'FRED (St. Louis Fed)', frankfurter: 'ECB via Frankfurter', coingecko: 'CoinGecko',
};
