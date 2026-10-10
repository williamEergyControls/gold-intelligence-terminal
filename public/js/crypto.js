/* CRYPTO: BITCOIN vs GOLD + STABLECOIN SUPPLY
   INIT     /api/markets/btc (shared cache 30 min, all from the D1 warehouse)
   PUBLISH  kpis · index-100 chart · rolling 60-day correlations · stablecoin supply · plain read */
(function () {
  'use strict';
  var G = window.GT, esc = G.esc, fmt = G.fmt, $ = function (s) { return document.getElementById(s); };
  function pc(v) { return v == null ? '–' : (v >= 0 ? '+' : '') + fmt(v, 1) + '%'; }
  function big(v) { return v == null ? '–' : v >= 1e12 ? '$' + fmt(v / 1e12, 2) + 'T' : '$' + fmt(v / 1e9, 0) + 'B'; }
  function P(a) { return (a || []).map(function (p) { return { x: p.t, y: p.v }; }); }
  function word(c) { return c == null ? 'no read' : c >= 0.5 ? 'strongly with' : c >= 0.2 ? 'loosely with' : c > -0.2 ? 'independently of' : c > -0.5 ? 'loosely against' : 'strongly against'; }
  function render(d) {
    if (!d.ready) { $('cKpi').innerHTML = '<div class="empty">' + esc(d.note || 'Bitcoin history is still loading.') + '</div>'; return; }
    var k = d.kpi;
    var kp = function (l, v, s, c) { return '<div class="kpi"><label>' + l + '</label><b' + (c ? ' class="' + c + '"' : '') + '>' + v + '</b><small>' + s + '</small></div>'; };
    $('cKpi').innerHTML =
      kp('Bitcoin', k.btc ? '$' + fmt(k.btc.v, 0) : '–', pc(k.btc30) + ' in 30 days · ' + pc(k.btc365) + ' in a year') +
      kp('Bitcoin vs gold value', k.btcGoldCapPct != null ? fmt(k.btcGoldCapPct, 1) + '%' : '–', big(k.btcCap) + ' vs ' + big(k.goldCap) + ' of gold') +
      kp('Volatility, 60 days', k.volBtc != null ? fmt(k.volBtc, 0) + '%' : '–', 'Bitcoin, yearly · gold ' + (k.volGold != null ? fmt(k.volGold, 0) + '%' : '–')) +
      kp('Correlation with gold', k.corrGold != null ? fmt(k.corrGold, 2) : '–', word(k.corrGold) + ' gold', k.corrGold != null ? G.cls(k.corrGold) : '') +
      kp('Correlation with S&amp;P', k.corrSpx != null ? fmt(k.corrSpx, 2) : '–', word(k.corrSpx) + ' stocks', k.corrSpx != null ? G.cls(k.corrSpx) : '') +
      kp('Stablecoin supply', k.supply ? big(k.supply.v) : '–', pc(k.supply30) + ' in 30 days · ' + pc(k.supply365) + ' in a year');
    GK.line($('cvNorm'), $('tpNorm'), { series: [{ name: 'Bitcoin', pts: P(d.norm.btc), color: GK.css('--cyan') }, { name: 'Gold', pts: P(d.norm.gold), color: GK.css('--gold'), width: 2.4 }, { name: 'S&P 500', pts: P(d.norm.spx), color: GK.css('--blue') }],
      refs: [{ y: 100, color: GK.css('--mut') }], yFmt: function (x) { return fmt(x, 0); } });
    var C = d.corr;
    GK.line($('cvCorr'), $('tpCorr'), { series: [{ name: 'with gold', pts: P(C.gold), color: GK.css('--gold'), width: 2.4 }, { name: 'with S&P 500', pts: P(C.spx), color: GK.css('--blue') }, { name: 'with the dollar', pts: P(C.dxy), color: GK.css('--dn') }, { name: 'with stablecoin supply', pts: P(C.supply), color: GK.css('--up'), dash: [4, 3] }],
      refs: [{ y: 0, color: GK.css('--mut') }], yMin: -1, yMax: 1, yFmt: function (x) { return fmt(x, 1); } });
    $('corrNote').textContent = 'Over the last ' + d.window + ' trading days Bitcoin moved ' + word(k.corrSpx) + ' the S&P 500, ' + word(k.corrGold) + ' gold and ' + word(k.corrDxy) + ' the dollar.' +
      (k.corrSpx != null && k.corrGold != null ? (k.corrSpx >= 0.3 && k.corrSpx > k.corrGold + 0.2 ? ' Right now it trades more like a risk asset than a hedge.' : k.corrGold >= 0.3 && k.corrGold > k.corrSpx + 0.2 ? ' Right now it trades more like a hedge than a risk asset.' : ' None of these links is strong right now; Bitcoin is trading on its own story.') : '');
    GK.line($('cvSup'), $('tpSup'), { series: [{ name: 'Supply', pts: P(d.supply), color: GK.css('--up'), fill: true }], yFmt: function (x) { return '$' + fmt(x, 0) + 'B'; } });
    $('supNote').textContent = k.supply ? 'Total of the six tracked stablecoins: ' + big(k.supply.v) + ', ' + pc(k.supply30) + ' in 30 days. ' + (k.supply30 > 2 ? 'Fresh money is coming into crypto.' : k.supply30 < -1 ? 'Money is leaving crypto.' : 'Supply is roughly flat.') : '';
  }
  G.getJSON('/api/markets/btc').then(render).catch(function () { $('cKpi').innerHTML = '<div class="empty">Bitcoin data is unavailable right now.</div>'; });
})();
