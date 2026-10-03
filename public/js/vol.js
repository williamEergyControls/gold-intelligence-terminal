/* ================================================================
   VOLATILITY DESK — client
   cycle: INIT (token) → POLL /api/vol every 120 s (precomputed snapshots)
          → EVALUATE (pick class, rows, regimes) → PUBLISH (tables, charts)
   detail: POLL /api/series?id= on row click → level + RV20/GARCH charts
   ================================================================ */
(function () {
'use strict';
var $ = function (s) { return document.querySelector(s); };
var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
var GK = window.GK, esc = GK.esc, fmt = GK.fmt, css = GK.css;
var TOKEN = ''; try { TOKEN = localStorage.getItem('git-token') || ''; } catch (e) { }
if (!TOKEN) { location.replace('/login.html'); return; }

var V = null, CLS = 'rates', SEL = null;
try { CLS = localStorage.getItem('git-vol-cls') || 'rates'; } catch (e) { }
var CLASS_INFO = {
  rates: { t: 'Treasuries · yields + MOVE', chip: 'DAILY', note: 'FRED Treasury yields are daily with a 1-business-day lag. Vol = annualized stdev of daily changes in bp. MOVE (ICE BofA) = implied UST vol, Yahoo (unofficial).' },
  fx: { t: 'FX · ECB reference rates + DXY', chip: 'DAILY', note: 'Pairs: ECB reference rates via Frankfurter (one fixing per TARGET day, ~16:00 CET). DXY: Yahoo (unofficial). Vol = annualized stdev of daily log returns.' },
  stable: { t: 'Stablecoins · peg risk', chip: 'DAILY + LATEST', note: 'CoinGecko public API. Deviation = (price − 1.00) × 10,000 bp. σ = stdev of daily deviation changes, bp/day (24/7 market).' },
  insurance: { t: 'Insurance prices · CPI / PPI + insurer stocks', chip: 'MONTHLY', note: 'BLS via FRED, monthly (≈2-week release lag). YoY = index vs 12 months earlier. z = latest m/m vs its 36-month mean/stdev. KIE = insurer stocks ETF, Yahoo.' },
  equity: { t: 'Stocks · indices, sectors, implied vol', chip: 'DAILY', note: 'Yahoo Finance (unofficial). Implied vol indices (VIX, VXN, VVIX): the level is the signal → 1y level percentile. Others: RV20 percentile.' },
  commod: { t: 'Gold · silver · oil + implied vol', chip: 'DAILY', note: 'Front-month futures (GC, SI, CL) + CBOE GVZ / OVX via Yahoo (unofficial). Futures ≠ spot; the gold desk hero uses spot.' },
};

setInterval(function () { $('#clock').textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);
$('#clock').textContent = new Date().toLocaleTimeString('en-GB');

function getJSON(u) {
  return fetch(u, { headers: { 'x-session': TOKEN } }).then(function (r) {
    if (r.status === 401) { location.replace('/login.html'); throw new Error('UNAUTHORIZED'); }
    return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
  });
}
function age(ms) { if (ms == null) return '--'; var s = Math.round(ms / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : s < 172800 ? (s / 3600).toFixed(1) + 'h' : Math.round(s / 86400) + 'd'; }
function day(ts) { return ts ? new Date(ts).toISOString().slice(0, 10) : '--'; }
function sg(v) { return v > 0 ? '+' : ''; }
function cls(v) { return v == null ? 'dim' : v >= 0 ? 'up' : 'dn'; }
function reg(r) { return '<span class="reg ' + esc(r) + '">' + esc(r === '—' ? 'N/A' : r) + '</span>'; }
function pbar(p) { return p == null ? '<span class="dim">--</span>' : '<span class="pbar" title="' + p + 'th percentile"><s style="width:' + p + '%"></s><i style="left:' + p + '%"></i></span> <span class="mut">' + p + '</span>'; }
function zc(z) { if (z == null) return '<span class="dim">--</span>'; var a = Math.abs(z); return '<b class="' + (a >= 2.5 ? 'dn' : a >= 1.5 ? 'gold' : 'mut') + '">' + sg(z) + fmt(z, 1) + 'σ</b>'; }
function dec(r) { if (r.kind === 'yield') return 3; if (r.last != null && Math.abs(r.last) < 20) return 4; return 2; }
function allRows() { var o = []; if (!V) return o; Object.keys(V.classes).forEach(function (c) { var s = V.classes[c]; if (s && s.rows) s.rows.forEach(function (r) { o.push(Object.assign({ cls: c }, r)); }); }); return o; }
function findRow(id) { return allRows().filter(function (r) { return r.id === id; })[0]; }

/* ---------------- KPIs ---------------- */
function kpi(label, val, sub, c, cls_, id) { return '<div class="kpi" data-c="' + (cls_ || '') + '" data-id="' + (id || '') + '"><label>' + esc(label) + '</label><b class="' + (c || '') + '">' + val + '</b><small>' + esc(sub || '') + '</small></div>'; }
function regCls(r) { return r === 'STRESS' ? 'dn' : r === 'ELEVATED' ? 'gold' : r === 'LOW' ? 'up' : ''; }
function renderKpis() {
  var x = V.cross, st = x && x.stress;
  var R = function (id) { return findRow(id) || {}; };
  var h = '';
  h += kpi('STRESS INDEX', st && st.score != null ? st.score + ' / 100' : '--', st ? st.regime + ' · composite pctl' : 'warming', st ? regCls(st.regime) : '', '', '');
  var vix = R('VIX'), mv = R('MOVE'), dxy = R('DXY'), t10 = R('UST10Y'), gvz = R('GVZ'), usdt = R('USDT'), ins = R('INS_AUTO');
  h += kpi('VIX', vix.last != null ? fmt(vix.last, 2) : '--', vix.pct != null ? vix.pct + 'th pctl · ' + vix.regime : '', regCls(vix.regime), 'equity', 'VIX');
  h += kpi('MOVE (UST IMPLIED)', mv.last != null ? fmt(mv.last, 1) : '--', mv.pct != null ? mv.pct + 'th pctl · ' + mv.regime : '', regCls(mv.regime), 'rates', 'MOVE');
  h += kpi('UST 10Y RV20', t10.rv20 != null ? fmt(t10.rv20, 0) + ' bp' : '--', t10.pct != null ? t10.pct + 'th pctl · GARCH ' + fmt(t10.garch && t10.garch.sig20Ann, 0) : '', regCls(t10.regime), 'rates', 'UST10Y');
  h += kpi('DXY RV20', dxy.rv20 != null ? fmt(dxy.rv20, 1) + '%' : '--', dxy.pct != null ? dxy.pct + 'th pctl · ' + dxy.regime : '', regCls(dxy.regime), 'fx', 'DXY');
  h += kpi('GVZ (GOLD IMPLIED)', gvz.last != null ? fmt(gvz.last, 1) : '--', gvz.pct != null ? gvz.pct + 'th pctl · ' + gvz.regime : '', regCls(gvz.regime), 'commod', 'GVZ');
  var dv = usdt.extra && usdt.extra.devBp;
  h += kpi('USDT DEPEG', dv != null ? sg(dv) + fmt(dv, 1) + ' bp' : '--', usdt.extra ? 'max 90d ' + fmt(usdt.extra.max90Bp, 0) + ' bp' : '', regCls(usdt.regime), 'stable', 'USDT');
  var y = ins.extra && ins.extra.yoy;
  h += kpi('AUTO INSURANCE CPI', y != null ? sg(y) + fmt(y, 1) + '% y/y' : '--', ins.lastTs ? 'BLS · ' + day(ins.lastTs).slice(0, 7) : '', y != null && y > 5 ? 'dn' : '', 'insurance', 'INS_AUTO');
  $('#kpis').innerHTML = h;
}
$('#kpis').addEventListener('click', function (e) { var k = e.target.closest('.kpi'); if (!k || !k.dataset.c) return; setClass(k.dataset.c); if (k.dataset.id) loadDetail(k.dataset.id); });

/* ---------------- class table ---------------- */
var GROUP_NAME = { yield: 'YIELDS', price: 'PRICES', index: 'IMPLIED VOL INDICES', peg: 'STABLECOINS', cpi: 'PRICE INDICES (MONTHLY)' };
function tableFor(kind, rows) {
  var up = css('--gold'), h = '';
  if (kind === 'peg') {
    h += '<thead><tr><th>' + GROUP_NAME[kind] + '</th><th class="r">PRICE</th><th class="r">DEV</th><th class="r">MAX 30D</th><th class="r">MAX 90D</th><th class="r">σ BP/DAY</th><th class="r">DAYS &gt;10BP (90D)</th><th>REGIME</th><th>DEV 90D</th><th>AS OF</th></tr></thead><tbody>';
    rows.forEach(function (r) { var e = r.extra || {};
      h += '<tr class="rowc' + (SEL === r.id ? ' sel' : '') + '" data-id="' + esc(r.id) + '"><td><b>' + esc(r.id) + '</b> <span class="dim">' + esc(r.label) + '</span></td><td class="r">' + fmt(r.last, 4) + '</td><td class="r ' + (Math.abs(e.devBp || 0) > 10 ? 'dn' : 'mut') + '">' + sg(e.devBp) + fmt(e.devBp, 1) + '</td><td class="r">' + fmt(e.max30Bp, 1) + '</td><td class="r">' + fmt(e.max90Bp, 1) + '</td><td class="r">' + fmt(r.rv20, 2) + '</td><td class="r">' + (e.daysOver10bp90 != null ? e.daysOver10bp90 : '--') + '</td><td>' + reg(r.regime) + '</td><td>' + GK.spark(r.spark, up) + '</td><td class="mut">' + day(r.lastTs) + (r.stale ? ' <b class="dn">STALE</b>' : '') + '</td></tr>'; });
    return h + '</tbody>';
  }
  if (kind === 'cpi') {
    h += '<thead><tr><th>' + GROUP_NAME[kind] + '</th><th class="r">YOY</th><th class="r">1Y AGO</th><th class="r">M/M</th><th class="r">3M ANN.</th><th class="r">M/M σ 36M</th><th>YOY PCTL 10Y</th><th>REGIME</th><th class="r">Z</th><th>YOY 5Y</th><th>MONTH</th></tr></thead><tbody>';
    rows.forEach(function (r) { var e = r.extra || {};
      h += '<tr class="rowc' + (SEL === r.id ? ' sel' : '') + '" data-id="' + esc(r.id) + '"><td><b>' + esc(r.label) + '</b></td><td class="r"><b class="' + ((e.yoy || 0) > 5 ? 'dn' : '') + '">' + sg(e.yoy) + fmt(e.yoy, 2) + '%</b></td><td class="r mut">' + fmt(e.yoy1yAgo, 2) + '%</td><td class="r ' + cls(r.chg) + '">' + sg(r.chg) + fmt(r.chg, 2) + '%</td><td class="r">' + fmt(e.ann3m, 1) + '%</td><td class="r">' + fmt(e.momVol36, 2) + '</td><td>' + pbar(r.pct) + '</td><td>' + reg(r.regime) + '</td><td class="r">' + zc(r.z) + '</td><td>' + GK.spark(r.spark, up) + '</td><td class="mut">' + day(r.lastTs).slice(0, 7) + (r.stale ? ' <b class="dn">STALE</b>' : '') + '</td></tr>'; });
    return h + '</tbody>';
  }
  var isY = kind === 'yield', isI = kind === 'index';
  h += '<thead><tr><th>' + GROUP_NAME[kind] + '</th><th class="r">LAST</th><th class="r">CHG</th><th class="r">' + (isI ? 'VOL-OF-VOL 20D' : 'RV20') + '</th><th class="r">RV60</th><th class="r">GARCH 20D</th><th>' + (isI ? 'LEVEL PCTL 1Y' : 'RV20 PCTL 1Y') + '</th><th>REGIME</th><th class="r">σ MOVE</th><th class="r">' + (isI ? '1Y RANGE' : '5D 1σ') + '</th><th>' + (isI ? 'LEVEL' : 'RV20 TREND') + '</th><th>AS OF</th></tr></thead><tbody>';
  rows.forEach(function (r) {
    var u = isY ? 'bp' : isI ? '' : '%', vu = isY ? ' bp' : '%';
    var rng = isI && r.extra ? fmt(r.extra.lo1y, 1) + '–' + fmt(r.extra.hi1y, 1) : (r.exp5d != null ? '±' + fmt(r.exp5d, isY ? 0 : dec(r)) + (isY ? ' bp' : '') : '--');
    h += '<tr class="rowc' + (SEL === r.id ? ' sel' : '') + '" data-id="' + esc(r.id) + '"><td><b>' + esc(r.id) + '</b> <span class="dim">' + esc(r.label) + '</span></td>' +
      '<td class="r"><b>' + fmt(r.last, isY ? 3 : dec(r)) + (isY ? '%' : '') + '</b></td>' +
      '<td class="r ' + cls(r.chg) + '">' + (r.chg == null ? '--' : sg(r.chg) + fmt(r.chg, isY ? 1 : 2) + u) + '</td>' +
      '<td class="r">' + (r.rv20 == null ? '--' : fmt(r.rv20, isY ? 0 : 1) + vu) + '</td><td class="r mut">' + (r.rv60 == null ? '--' : fmt(r.rv60, isY ? 0 : 1) + vu) + '</td>' +
      '<td class="r">' + (r.garch ? fmt(r.garch.sig20Ann, isY ? 0 : 1) + vu : '--') + '</td><td>' + pbar(r.pct) + '</td><td>' + reg(r.regime) + '</td><td class="r">' + zc(r.z) + '</td>' +
      '<td class="r mut">' + rng + '</td><td>' + GK.spark(isI ? r.spark : r.rvSpark, isI ? up : css('--cyan')) + '</td><td class="mut">' + day(r.lastTs) + (r.stale ? ' <b class="dn">STALE</b>' : '') + '</td></tr>';
  });
  return h + '</tbody>';
}
function renderClass() {
  var info = CLASS_INFO[CLS];
  $('#clsTitle').textContent = info.t; $('#clsChip').textContent = info.chip; $('#clsNote').textContent = info.note;
  $$('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.c === CLS); });
  var s = V && V.classes[CLS];
  if (!s) { $('#volTbl').innerHTML = '<tbody><tr><td class="emptyst">WAREHOUSE WARMING — this class has no snapshot yet. Ingest runs every 10 min (admin → DATABASE → RUN INGEST to speed up).</td></tr></tbody>'; $('#exBox').innerHTML = ''; return; }
  $('#clsSrc').textContent = 'BUILT ' + age(Date.now() - s.builtAt) + ' AGO';
  var order = ['yield', 'index', 'price', 'peg', 'cpi'], h = '';
  order.forEach(function (k) { var rs = s.rows.filter(function (r) { return r.kind === k; }); if (rs.length) h += tableFor(k, rs); });
  $('#volTbl').innerHTML = h;
  renderExtras(s);
}
$('#volTbl').addEventListener('click', function (e) { var tr = e.target.closest('tr[data-id]'); if (tr) loadDetail(tr.dataset.id); });
function setClass(c) { CLS = c; try { localStorage.setItem('git-vol-cls', c); } catch (e) { } renderClass(); }
$('#tabs').addEventListener('click', function (e) { var b = e.target.closest('button[data-c]'); if (b) setClass(b.dataset.c); });

/* ---------------- class extras ---------------- */
function hbar(name, v, max, color, txt, center) {
  var w, left;
  if (center) { var half = Math.min(50, Math.abs(v) / max * 50); left = v >= 0 ? 50 : 50 - half; w = half; }
  else { left = 0; w = Math.max(0, Math.min(100, v / max * 100)); }
  return '<div class="hbar"><span class="n">' + esc(name) + '</span><span class="t">' + (center ? '<s style="left:50%"></s>' : '') + '<i style="left:' + left + '%;width:' + w + '%;background:' + color + '"></i></span><span class="v">' + txt + '</span></div>';
}
function renderExtras(s) {
  var ex = s.extras || {}, h = '', up = css('--up'), dn = css('--dn'), gold = css('--gold'), cyan = css('--cyan');
  var box = $('#exBox');
  if (CLS === 'rates') {
    $('#exTitle').textContent = 'Yield curve · policy'; $('#exSrc').textContent = 'FRED';
    h += '<div class="legend"><span><i style="background:' + gold + '"></i>NOW</span><span><i style="background:' + cyan + '"></i>1M AGO</span><span><i style="background:' + css('--blue') + '"></i>1Y AGO</span></div>';
    h += '<div class="chartbox sm"><canvas id="cvCurve"></canvas><div class="tip" id="tipCurve"></div></div>';
    var sp = ex.spreads || {};
    h += '<table class="tb" style="margin-top:8px"><tbody><tr><td>2s10s</td><td class="r ' + cls(sp.s2s10bp) + '"><b>' + sg(sp.s2s10bp) + fmt(sp.s2s10bp, 0) + ' bp</b></td><td class="mut">10Y − 2Y</td></tr><tr><td>3m10y</td><td class="r ' + cls(sp.s3m10bp) + '"><b>' + sg(sp.s3m10bp) + fmt(sp.s3m10bp, 0) + ' bp</b></td><td class="mut">10Y − 3M (recession signal when negative)</td></tr>';
    var po = ex.policy || {};
    if (po.fed) h += '<tr><td>FED TARGET</td><td class="r"><b>' + fmt(po.fed.lo, 2) + '–' + fmt(po.fed.hi, 2) + '%</b></td><td class="mut">' + esc(po.fed.source) + ' · ' + day(po.fed.asOf) + '</td></tr>';
    if (po.ecb) h += '<tr><td>ECB DEPOSIT</td><td class="r"><b>' + fmt(po.ecb.rate, 2) + '%</b></td><td class="mut">' + esc(po.ecb.source) + ' · ' + day(po.ecb.asOf) + '</td></tr>';
    h += '</tbody></table>';
    box.innerHTML = h;
    var cv = ex.curve || { now: [], m1: [], y1: [], tenors: [] };
    var mk = function (arr) { return (arr || []).map(function (v, i) { return { x: i, y: v == null ? NaN : v }; }); };
    GK.line($('#cvCurve'), $('#tipCurve'), { series: [{ name: 'NOW', pts: mk(cv.now), color: gold, dots: true }, { name: '1M AGO', pts: mk(cv.m1), color: cyan, width: 1.5 }, { name: '1Y AGO', pts: mk(cv.y1), color: css('--blue'), width: 1.5, dash: [4, 3] }],
      xFmt: function (x) { return cv.tenors[Math.round(x)] || ''; }, tipX: function (x) { return (cv.tenors[Math.round(x)] || '') + ' tenor'; }, yFmt: function (v) { return fmt(v, 2) + '%'; } });
    return;
  }
  if (CLS === 'stable') {
    $('#exTitle').textContent = 'Market cap share · depeg now'; $('#exSrc').textContent = 'COINGECKO';
    var mc = ex.mcap || [], tot = ex.totalMcap;
    h += '<div class="secH">TOTAL TRACKED MCAP <b class="gold" style="font-size:13px">' + (tot ? '$' + fmt(tot / 1e9, 1) + 'B' : '--') + '</b></div>';
    mc.slice().sort(function (a, b) { return (b.mcap || 0) - (a.mcap || 0); }).forEach(function (m) { h += hbar(m.id, m.share || 0, 100, gold, fmt(m.share, 1) + '%'); });
    h += '<div class="secH" style="margin-top:10px">30D SUPPLY CHANGE</div>';
    mc.forEach(function (m) { h += hbar(m.id, m.chg30d || 0, 20, (m.chg30d || 0) >= 0 ? up : dn, sg(m.chg30d) + fmt(m.chg30d, 1) + '%', true); });
    h += '<div class="secH" style="margin-top:10px">DEVIATION FROM $1 (BP)</div>';
    s.rows.filter(function (r) { return r.kind === 'peg'; }).forEach(function (r) { var d = (r.extra || {}).devBp || 0; h += hbar(r.id, d, 50, Math.abs(d) > 10 ? dn : cyan, sg(d) + fmt(d, 1), true); });
    box.innerHTML = h + '<div class="note">bars centered on 0. ±50 bp = full width.</div>'; return;
  }
  if (CLS === 'insurance') {
    $('#exTitle').textContent = 'Insurance inflation vs CPI'; $('#exSrc').textContent = 'BLS VIA FRED';
    h += '<div class="secH">CPI ALL ITEMS YOY <b>' + fmt(ex.cpiYoy, 2) + '%</b></div>';
    var SHORT = { INS_AUTO: 'AUTO', INS_HOME: 'HOME / RENTERS', INS_HEALTH: 'HEALTH', INS_PC_PPI: 'P&C INSURER PPI' };
    (ex.vsCpi || []).forEach(function (v) { h += hbar(SHORT[v.id] || v.id, v.yoy || 0, 15, (v.yoy || 0) > (ex.cpiYoy || 0) ? dn : up, sg(v.yoy) + fmt(v.yoy, 1) + '%', true); });
    h += '<div class="secH" style="margin-top:10px">SPREAD VS CPI (PP)</div>';
    (ex.vsCpi || []).forEach(function (v) { h += hbar(SHORT[v.id] || v.id, v.spreadPp || 0, 10, (v.spreadPp || 0) > 0 ? dn : up, sg(v.spreadPp) + fmt(v.spreadPp, 1), true); });
    box.innerHTML = h + '<div class="note">red = insurance prices rising faster than overall CPI. monthly, ~2-week publication lag.</div>'; return;
  }
  if (CLS === 'equity' || CLS === 'commod') {
    $('#exTitle').textContent = 'Implied vs realized (VRP)'; $('#exSrc').textContent = 'CALC';
    var vrp = ex.vrp || {};
    Object.keys(vrp).forEach(function (k) { var v = vrp[k]; if (!v) return;
      h += '<div class="secH" style="margin-top:6px">' + esc(k.toUpperCase()) + '</div>' + hbar('IMPLIED', v.implied, 60, gold, fmt(v.implied, 1)) + hbar('REALIZED 20D', v.realized20, 60, cyan, fmt(v.realized20, 1)) +
        '<div class="note">premium <b class="' + (v.spread >= 0 ? 'up' : 'dn') + '">' + sg(v.spread) + fmt(v.spread, 1) + ' vol pts</b> · negative = realized running hotter than options price</div>'; });
    if (CLS === 'equity') {
      h += '<div class="secH" style="margin-top:10px">SECTOR RV20 (%/YR)</div>';
      s.rows.filter(function (r) { return /^XL/.test(r.id); }).sort(function (a, b) { return (b.rv20 || 0) - (a.rv20 || 0); }).forEach(function (r) { h += hbar(r.label, r.rv20 || 0, 60, r.regime === 'STRESS' ? dn : r.regime === 'ELEVATED' ? css('--amber') : cyan, fmt(r.rv20, 1)); });
    }
    box.innerHTML = h || '<div class="emptyst">NO IMPLIED/REALIZED PAIR YET</div>'; return;
  }
  if (CLS === 'fx') {
    $('#exTitle').textContent = 'FX vol ranking'; $('#exSrc').textContent = 'RV20 %/YR';
    s.rows.slice().sort(function (a, b) { return (b.rv20 || 0) - (a.rv20 || 0); }).forEach(function (r) { h += hbar(r.label, r.rv20 || 0, 20, r.regime === 'STRESS' ? dn : r.regime === 'ELEVATED' ? css('--amber') : cyan, fmt(r.rv20, 1) + '%'); });
    box.innerHTML = h + '<div class="note">USD/CNY is managed (tight band) — low vol is policy, not calm.</div>'; return;
  }
}

/* ---------------- stress + alerts + corr + board ---------------- */
function renderCross() {
  var x = V.cross;
  if (!x) { $('#stressBox').innerHTML = '<div class="emptyst">WARMING</div>'; $('#alertBox').innerHTML = ''; return; }
  var st = x.stress, col = function (r) { return r === 'STRESS' ? css('--dn') : r === 'ELEVATED' ? css('--amber') : r === 'LOW' ? css('--up') : css('--mut'); };
  var h = '<div style="display:flex;align-items:baseline;gap:10px"><b style="font:700 34px var(--mono)">' + (st.score != null ? st.score : '--') + '</b><span class="mut">/ 100</span>' + reg(st.regime) + '</div>';
  h += '<div class="gauge"><i style="width:' + (st.score || 0) + '%;background:' + col(st.regime) + '"></i></div>';
  Object.keys(st.components).forEach(function (k) { var c = st.components[k], p = c.pct;
    h += '<div class="comp" title="' + esc(c.basis) + '"><span class="mut">' + esc(k.toUpperCase()) + '</span><span class="t"><i style="width:' + (p || 0) + '%;background:' + col(p == null ? '' : p < 20 ? 'LOW' : p < 60 ? 'NORMAL' : p < 85 ? 'ELEVATED' : 'STRESS') + '"></i></span><b>' + (p == null ? '--' : p) + '</b></div>'; });
  h += '<div class="note">' + esc(st.note) + '. hover a bar for its basis. 0 = calmest day of the past year, 100 = most volatile.</div>';
  $('#stressBox').innerHTML = h;
  var al = x.alerts || [];
  $('#alertBox').innerHTML = al.length ? al.map(function (a) {
    return '<div class="al" data-id="' + esc(a.id) + '" data-c="' + esc(a.cls) + '"><span>' + zc(a.z) + '</span><span><b>' + esc(a.label) + '</b> <span class="dim">' + esc(a.cls) + '</span></span><span class="r mut">' + (a.chg == null ? '' : sg(a.chg) + fmt(a.chg, 2) + ' ' + esc(a.chgUnit)) + '</span></div>';
  }).join('') : '<div class="emptyst">NO σ-MOVES ABOVE THRESHOLD — LAST OBSERVATION OF EVERY SERIES IS WITHIN ITS GARCH BAND</div>';
  if (x.corr) GK.heat($('#cvCorr'), x.corr.ids, x.corr.m);
  var rows = allRows().filter(function (r) { return r.pct != null && r.kind !== 'peg' && r.kind !== 'cpi'; }).sort(function (a, b) { return b.pct - a.pct; });
  $('#boardBox').innerHTML = rows.map(function (r) { return '<div class="hbar" style="break-inside:avoid;cursor:pointer" data-id="' + esc(r.id) + '" data-c="' + esc(r.cls) + '"><span class="n">' + esc(r.id) + ' <span class="dim">' + esc(r.cls) + '</span></span><span class="t"><i style="left:0;width:' + r.pct + '%;background:' + col(r.regime) + '"></i></span><span class="v">' + r.pct + ' ' + '<span class="dim" style="font-weight:400">' + esc(r.regime[0]) + '</span></span></div>'; }).join('');
}
['#alertBox', '#boardBox'].forEach(function (sel) { $(sel).addEventListener('click', function (e) { var el = e.target.closest('[data-id]'); if (!el) return; setClass(el.dataset.c); loadDetail(el.dataset.id); }); });

/* ---------------- detail ---------------- */
function loadDetail(id) {
  SEL = id; $$('#volTbl tr[data-id]').forEach(function (tr) { tr.classList.toggle('sel', tr.dataset.id === id); });
  $('#detTitle').textContent = id + ' · loading…';
  getJSON('/api/series?id=' + encodeURIComponent(id)).then(function (d) {
    var gold = css('--gold'), cyan = css('--cyan'), blue = css('--blue');
    var P = function (a) { return (a || []).map(function (p) { return { x: p.t, y: p.v }; }); };
    $('#detTitle').textContent = d.label + ' (' + d.id + ')';
    $('#detSrc').textContent = d.source + ' · ' + (d.dataTimestamp || '--');
    var lvl, lname, yf;
    if (d.kind === 'peg') { lvl = P(d.devBp); lname = 'DEVIATION FROM $1 (BP)'; yf = function (v) { return fmt(v, 1) + ' bp'; }; }
    else if (d.kind === 'cpi') { lvl = P(d.yoy); lname = 'YOY %'; yf = function (v) { return fmt(v, 2) + '%'; }; }
    else { lvl = P(d.points); lname = d.kind === 'yield' ? 'YIELD %' : 'LEVEL (' + d.unit + ')'; yf = function (v) { return fmt(v, Math.abs(v) < 20 ? 3 : 2); }; }
    $('#lgLevel').innerHTML = '<span><i style="background:' + gold + '"></i>' + esc(lname) + '</span><span class="dim">' + esc(d.freq.toUpperCase()) + ' · ' + lvl.length + ' obs</span>';
    GK.line($('#cvLevel'), $('#tipLevel'), { series: [{ name: lname, pts: lvl, color: gold }], yFmt: yf, refs: d.kind === 'peg' ? [{ y: 0, label: '$1.00', left: true }] : [] });
    var scale = d.kind === 'peg' ? 1 / Math.sqrt(365) : d.kind === 'cpi' ? 1 / Math.sqrt(12) : 1;
    var vu = d.kind === 'peg' ? 'bp/day' : d.kind === 'cpi' ? '% m/m σ (12m)' : d.volUnit;
    var sc = function (a) { return P(a).map(function (p) { return { x: p.x, y: p.y * scale }; }); };
    var vs = [{ name: (d.kind === 'cpi' ? 'ROLLING 12M σ' : 'REALIZED 20D') + ' (' + vu + ')', pts: sc(d.rv20), color: cyan }];
    if (d.garchAnn && d.garchAnn.length) vs.push({ name: 'GARCH(1,1) CONDITIONAL (' + vu + ')', pts: sc(d.garchAnn), color: blue, width: 1.5 });
    $('#lgVol').innerHTML = vs.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join('');
    GK.line($('#cvVol'), $('#tipVol'), { series: vs, yFmt: function (v) { return fmt(v, Math.abs(v) < 2 ? 3 : Math.abs(v) < 20 ? 2 : 1); }, empty: 'NOT ENOUGH HISTORY FOR VOL YET' });
    var r = findRow(id);
    $('#detNote').innerHTML = r ? ('regime <b>' + esc(r.regime) + '</b>' + (r.pct != null ? ' · ' + r.pct + 'th pctl' : '') + (r.garch ? ' · GARCH α ' + r.garch.alpha + ' β ' + r.garch.beta + ' persistence ' + r.garch.persist + ' (closer to 1 = shocks fade slower)' : '') + (r.exp5d != null ? ' · 5-day 1σ move ±' + fmt(r.exp5d, r.kind === 'yield' ? 0 : dec(r)) + (r.kind === 'yield' ? ' bp' : '') : '')) : '';
  }).catch(function (e) { $('#detTitle').textContent = id + ' · ' + e.message; });
}

/* ---------------- poll ---------------- */
function load() {
  return getJSON('/api/vol').then(function (d) {
    V = d;
    var built = Object.keys(d.ages || {}).length;
    $('#feedTxt').textContent = d.warming ? 'VOL WARMING' : 'VOL ' + built + '/7 SNAPSHOTS';
    $('#statusMid').textContent = d.warming ? 'WAREHOUSE WARMING · FIRST INGEST WITHIN 10 MIN · NOTHING IS SIMULATED ON THIS PAGE' : 'REALIZED + GARCH(1,1) FROM STORED DAILY DATA · OLDEST SNAPSHOT ' + age(Math.max.apply(null, Object.values(d.ages || { a: 0 }))) + ' · NOT FINANCIAL ADVICE';
    renderKpis(); renderClass(); renderCross();
    if (!SEL) { var first = V.classes[CLS] && V.classes[CLS].rows && V.classes[CLS].rows[0]; if (first) loadDetail(first.id); }
  }).catch(function (e) { $('#statusMid').textContent = 'DATA TEMPORARILY UNAVAILABLE · ' + e.message + ' · RETRYING'; });
}
load();
setInterval(function () { if (!document.hidden) load(); }, 120000);

/* theme */
(function () {
  var mode = 'auto'; try { mode = localStorage.getItem('git-theme') || 'auto'; } catch (e) { }
  var isDay = function () { return mode === 'day' || (mode === 'auto' && matchMedia('(prefers-color-scheme: light)').matches); };
  var b = $('#themeBtn');
  var apply = function () { document.body.classList.toggle('day', isDay()); if (b) b.textContent = mode === 'auto' ? 'AUTO' : mode.toUpperCase(); GK.redraw(); if (V) { renderClass(); renderCross(); } };
  if (b) b.addEventListener('click', function () { mode = mode === 'auto' ? 'day' : (mode === 'day' ? 'night' : 'auto'); try { localStorage.setItem('git-theme', mode); } catch (e) { } apply(); });
  apply();
})();
})();
