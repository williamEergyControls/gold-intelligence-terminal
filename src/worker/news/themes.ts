/* ================================================================
   THEMES — one shared vocabulary so an independent podcast and a Reuters headline
   about the same story land on the same label.
   INIT     CANON: ~55 regex → label pairs (markets, policy, geopolitics, shipping, energy)
   TAG      crawl time: title + description → canonical labels (no AI needed, deterministic)
   MERGE    digest time: AI themes → mapped onto a canonical label when one matches,
            otherwise kept as a normalized free label
   ================================================================ */
export const CANON: [string, RegExp][] = [
  ['fed rate cuts', /\brate cuts?\b|\bcut(?:ting)? (?:interest )?rates\b|easing cycle|\bdovish\b/i],
  ['fed hawkish', /\brate hikes?\b|\bhawkish\b|higher for longer/i],
  ['fed independence', /fed(?:eral reserve)? independence|(?:fire|firing|oust)\w*.{0,20}(?:powell|fed chair)|fed chair (?:pick|nominee|race)/i],
  ['inflation', /\binflation\b|\bcpi\b|\bpce\b|price pressures|stagflation/i],
  ['recession risk', /\brecession\b|hard landing|economic downturn|\bcontraction\b/i],
  ['labor market', /\bpayrolls?\b|jobless|unemployment|jobs report|labou?r market|\blayoffs?\b/i],
  ['tariffs & trade', /\btariffs?\b|trade war|trade deal|section 232|\bduties\b/i],
  ['us deficit & debt', /\bdeficits?\b|national debt|debt ceiling|treasury issuance|fiscal dominance|bond vigilantes/i],
  ['treasury yields', /treasury yields?|10-year yield|\bbond (?:market|sell-?off|rout)\b|term premium|long end of the curve/i],
  ['dollar', /\bdollar\b|\bdxy\b|greenback/i],
  ['de-dollarization', /de-?dollari[sz]ation|\bbrics\b|petroyuan|dollar dominance/i],
  ['central bank gold buying', /central banks?.{0,30}gold|gold (?:reserves|purchases|buying)|pboc.{0,20}gold/i],
  ['gold rally', /gold (?:hits|record|rall|surge|soar|all-time|tops|breaks)|record gold|gold price/i],
  ['silver', /\bsilver\b/i],
  ['liquidity & qe/qt', /\bliquidity\b|quantitative (?:easing|tightening)|\bqt\b|\bqe\b|fed balance sheet|repo market|reverse repo|\bsofr\b/i],
  ['private credit', /private credit|shadow bank/i],
  ['bank stress', /bank (?:run|failures?|stress)|regional banks?|deposit flight/i],
  ['ai spending', /\bai\b.{0,25}(?:capex|bubble|spending|boom)|data cent(?:er|re)s?|nvidia|hyperscalers?/i],
  ['equity valuations', /\bbubble\b|\bfroth\w*|overvalued|stretched valuations?/i],
  ['china economy', /china.{0,30}(?:economy|property|stimulus|deflation|growth|exports)|chinese (?:economy|stimulus|property)/i],
  ['us-china tensions', /\btaiwan\b|south china sea|export controls?|rare earths?|(?:u\.?s\.?|washington).{0,15}(?:beijing|china) (?:talks|tensions|deal)/i],
  ['russia-ukraine war', /\bukrain\w*|\bkremlin\b|zelensk\w*|\bputin\b|russian (?:offensive|strikes?|forces)/i],
  ['russia sanctions', /sanction\w*.{0,30}russia|russia\w*.{0,30}sanction|price cap|shadow fleet/i],
  ['middle east conflict', /\biran\w*|\bisrael\w*|\bgaza\b|hezbollah|\bidf\b|tehran/i],
  ['red sea & suez', /red sea|\bsuez\b|bab el-mandeb|houthis?/i],
  ['strait of hormuz', /hormuz|persian gulf/i],
  ['panama canal', /panama canal/i],
  ['black sea', /black sea/i],
  ['opec+ supply', /\bopec\b|output cuts?|production cuts?|saudi.{0,20}(?:output|production)/i],
  ['oil prices', /oil prices?|crude (?:prices?|rall\w*|slump\w*)|\bbrent\b|\bwti\b/i],
  ['natural gas & lng', /natural gas|\blng\b|gas prices?/i],
  ['refining & diesel', /\brefin(?:ery|eries|ing|ers?)\b|\bdiesel\b|crack spreads?|\bgasoline\b/i],
  ['pipelines', /\bpipelines?\b/i],
  ['container freight', /container (?:rates?|freight|shipping|lines?)|freight rates?|drewry|\bscfi\b|\bwci\b/i],
  ['port congestion & labor', /port (?:congestion|strikes?|closures?)|dockworkers?|longshore\w*|\bila\b|\bilwu\b/i],
  ['tankers', /\btankers?\b|\bvlccs?\b/i],
  ['shipbuilding', /shipbuild\w*|shipyards?/i],
  ['naval & maritime security', /\bnavy\b|\bnaval\b|warships?|carrier strike|maritime security|piracy/i],
  ['drought & water', /\bdrought\b|water shortage|reservoirs?|aquifers?|low water|river levels?/i],
  ['grains & food prices', /\bgrains?\b|\bwheat\b|\bcorn\b|soybeans?|food prices?|fertili[sz]ers?/i],
  ['stablecoins', /stablecoins?|\btether\b|\busdt\b|\busdc\b|genius act/i],
  ['bitcoin', /\bbitcoin\b|\bbtc\b|crypto (?:market|rall\w*|crash\w*)/i],
  ['housing', /\bhousing\b|mortgage rates?|home prices?|real estate/i],
  ['power grid & electricity', /power grid|electricity (?:prices|demand)|blackouts?|\bgrid\b/i],
  ['cyber attacks', /cyber ?attacks?|ransomware|\bhack(?:ed|ers?)\b/i],
  ['us politics & congress', /\belections?\b|midterms?|\bcongress\b|\bsenate\b|government shutdown/i],
  ['civil unrest', /\bprotests?\b|\briots?\b|\bunrest\b|martial law/i],
  ['europe economy', /eurozone|\becb\b|german(?:y|y's)? (?:economy|recession)|european economy/i],
  ['japan & yen', /\bboj\b|bank of japan|\byen\b|carry trade|\bjgbs?\b/i],
  ['emerging markets', /emerging markets?/i],
  ['supply chains', /supply chains?|reshoring|nearshoring/i],
  ['mining & miners', /gold miners?|mining (?:stocks|companies|output)|\bgdx\b/i],
  ['copper & metals', /\bcopper\b|\blithium\b|\bnickel\b|critical minerals?/i],
];

const STOP = /^(the|a|an|of|and|in|on|for|to|us|u\.s\.|new|latest|update|news)$/;
/** free AI label → short, lowercase, stable */
export function normTheme(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9&\-\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.test(w))
    .map(w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ').slice(0, 40).trim();
}

/** title + description → canonical labels (max 5) */
export function tagThemes(text: string): string[] {
  const out: string[] = [];
  for (const [label, re] of CANON) { if (re.test(text)) { out.push(label); if (out.length >= 5) break; } }
  return out;
}

/** existing comma list ∪ AI themes (mapped onto canonical labels when one matches) → comma list, max 7 */
export function mergeThemes(existing: string | null, ai: string[]): string {
  const set = new Set((existing ?? '').split(',').map(s => s.trim()).filter(Boolean));
  for (const t of ai) {
    const canon = CANON.find(([, re]) => re.test(t));
    const v = canon ? canon[0] : normTheme(t);
    if (v.length >= 3) set.add(v);
    if (set.size >= 7) break;
  }
  return [...set].join(',');
}
