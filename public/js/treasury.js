/* TREASURY DESK
   INIT     /api/page/treasury (shared cache 15 min; fiscal block 12 h)
   EVALUATE curve shape → plain-language read (inverted, re-steepened, bear/bull steepener)
   PUBLISH  kpis · curve now/1m/1y · spreads · real vs breakeven · debt · average rate · TGA */
(function () {
  'use strict';
  var G = window.GT, esc = G.esc, fmt = G.fmt, $ = function (s) { return document.getElementById(s); };
  var D = null;
  function v(p, d) { return p && p.v != null ? fmt(p.v, d == null ? 2 : d) : '–'; }
  function bp(x) { return x == null ? '–' : (x >= 0 ? '+' : '') + Math.round(x * 100) + ' bp'; }
  function pts(a) { return (a || []).filter(function (p) { return p && p.v != null && isFinite(p.v); }).map(function (p) { return { x: p.t, y: p.v }; }); }
  function line(id, tip, series, o) { o = o || {}; GK.line($(id), $(tip), Object.assign({ series: series, yFmt: o.yFmt || function (x) { return fmt(x, 2); } }, o)); }

  function kpis() {
    var k = D.kpi;
    var kp = function (label, val, sub, cls) { return '<div class="kpi"><label>' + esc(label) + '</label><b' + (cls ? ' class="' + cls + '"' : '') + '>' + val + '</b><small>' + sub + '</small></div>'; };
    $('kpis').innerHTML =
      kp('10-year', v(k.y10) + '%', bp(k.chg10_1m) + ' in a month') +
      kp('2-year', v(k.y2) + '%', bp(k.chg2_1m) + ' in a month') +
      kp('3-month', v(k.y3m) + '%', 'tracks the Fed') +
      kp('10Y minus 2Y', k.s2s10 ? bp(k.s2s10.v) : '–', k.s2s10 && k.s2s10.v < 0 ? 'inverted' : 'positive slope', k.s2s10 ? G.cls(k.s2s10.v) : '') +
      kp('10Y minus 3M', k.s3m10 ? bp(k.s3m10.v) : '–', k.s3m10 && k.s3m10.v < 0 ? 'inverted' : 'positive slope', k.s3m10 ? G.cls(k.s3m10.v) : '') +
      kp('Real 10Y (TIPS)', v(k.real10) + '%', bp(k.chgReal_1m) + ' in a month') +
      kp('10Y breakeven', v(k.be10) + '%', 'inflation the market prices') +
      kp('Fed target', k.fedLo && k.fedHi ? fmt(k.fedLo.v, 2) + '–' + fmt(k.fedHi.v, 2) + '%' : '–', 'overnight band') +
      kp('MOVE', v(k.move, 0), 'Treasury implied vol');
  }

  function curve() {
    var C = D.curve, X = function (y) { return Math.log(y * 12); };
    var mk = function (arr) { return (arr || []).filter(function (p) { return p.v != null; }).map(function (p) { return { x: X(p.yrs), y: p.v, l: p.label }; }); };
    var ticks = (C.now || []).map(function (p) { return { x: X(p.yrs), label: p.label }; });
    var lab = {}; ticks.forEach(function (t) { lab[t.x.toFixed(4)] = t.label; });
    GK.line($('cvCurve'), $('tpCurve'), {
      series: [{ name: 'Now', pts: mk(C.now), color: GK.css('--gold'), width: 2.6, dots: true, r: 3 },
        { name: 'About a month ago', pts: mk(C.m1), color: GK.css('--blue'), width: 1.6 },
        { name: 'About a year ago', pts: mk(C.y1), color: GK.css('--dim'), width: 1.6, dash: [4, 3] }],
      xTicks: ticks, tipX: function (x) { return (lab[x.toFixed(4)] || '') + ' maturity'; }, yFmt: function (x) { return fmt(x, 2) + '%'; }, empty: 'The curve fills after the first FRED pulls'
    });
  }

  function read() {
    var C = D.curve, k = D.kpi, S = D.spreads;
    var get = function (arr, l) { var p = (arr || []).filter(function (x) { return x.label === l; })[0]; return p && p.v != null ? p.v : null; };
    var n3 = get(C.now, '3M'), n2 = get(C.now, '2Y'), n10 = get(C.now, '10Y'), n30 = get(C.now, '30Y');
    var m3 = get(C.m1, '3M'), m10 = get(C.m1, '10Y'), y3 = get(C.y1, '3M'), y10 = get(C.y1, '10Y');
    if (n10 == null) { $('read').innerHTML = '<p>The read appears once the curve has data.</p>'; return; }
    var h = '';
    var sh = n3 != null ? n10 - n3 : null;
    h += '<h3>Shape</h3><p>' + (sh == null ? '' : sh < 0 ? 'The curve is <b>inverted</b>: 3-month bills pay ' + bp(-sh).replace('+', '') + ' more than the 10-year. Markets expect the Fed to cut.' :
      sh < 0.5 ? 'The curve is <b>flat</b>: the 10-year pays only ' + bp(sh).replace('+', '') + ' more than bills.' : 'The curve slopes <b>up normally</b>: the 10-year pays ' + bp(sh).replace('+', '') + ' over bills.') +
      (n30 != null && n2 != null ? ' From 2 to 30 years it ' + (n30 > n2 ? 'rises ' + bp(n30 - n2).replace('+', '') : 'falls ' + bp(n2 - n30).replace('+', '')) + '.' : '') + '</p>';
    var st = S.streak3m10;
    if (st) h += '<h3>Inversion clock</h3><p>' + (st.inverted ? 'Inverted for <b>' + st.days + ' days</b> in a row.' :
      'Positive for <b>' + st.days + ' days</b> since ' + new Date(st.since).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + '.') +
      ' Over the last two years it was inverted on ' + st.invertedDays2y + ' of ' + st.n + ' trading days.' +
      (!st.inverted && st.invertedDays2y > 60 && st.days < 365 ? ' A re-steepening within a year of a long inversion is the classic late-cycle pattern.' : '') + '</p>';
    if (m10 != null && m3 != null && n3 != null) {
      var d10 = n10 - m10, d3 = n3 - m3;
      // name the move by the leg that did most of it
      var kind = Math.abs(d10) < 0.05 && Math.abs(d3) < 0.05 ? 'Little changed in a month.' :
        d10 - d3 > 0.05 ? (Math.abs(d3) > Math.abs(d10) && d3 < 0 ? '<b>Bull steepening</b>: short yields fell faster than long ones (markets pricing cuts).' : '<b>Bear steepening</b>: long yields rose faster than short ones (inflation or supply worries, term premium).') :
        d3 - d10 > 0.05 ? (Math.abs(d3) >= Math.abs(d10) && d3 > 0 ? '<b>Bear flattening</b>: short yields rose faster (a more hawkish Fed).' : '<b>Bull flattening</b>: long yields fell faster (growth worries, flight to safety).') : 'Moved in parallel.';
      h += '<h3>Last month</h3><p>10-year ' + bp(d10) + ', 3-month ' + bp(d3) + '. ' + kind + '</p>';
    }
    if (y10 != null && y3 != null && n3 != null) h += '<h3>Last year</h3><p>10-year ' + bp(n10 - y10) + ', 3-month ' + bp(n3 - y3) + '.</p>';
    if (k.real10) h += '<h3>For gold</h3><p>The real 10-year yield is <b>' + fmt(k.real10.v, 2) + '%</b>' + (k.chgReal_1m != null ? ', ' + bp(k.chgReal_1m) + ' in a month' : '') + '. ' +
      (k.real10.v > 1.5 ? 'That is a high bar for a metal that pays no interest; when gold rises anyway, buyers who do not care about yield (central banks) are setting the price.' : k.real10.v < 0.5 ? 'Low real yields make holding gold cheap.' : 'A middling opportunity cost for gold.') + '</p>';
    $('read').innerHTML = h;
  }

  function spreads() {
    var S = D.spreads;
    line('cvSpr', 'tpSpr', [{ name: '10Y − 2Y', pts: pts(S.s2s10), color: GK.css('--gold') }, { name: '10Y − 3M', pts: pts(S.s3m10), color: GK.css('--blue') }],
      { refs: [{ y: 0, label: '0', color: GK.css('--mut') }], yFmt: function (x) { return fmt(x, 2); } });
    var a = S.streak2s10;
    $('sprNote').textContent = a ? (a.inverted ? '10Y−2Y inverted for ' + a.days + ' days.' : '10Y−2Y positive for ' + a.days + ' days.') : '';
  }
  function real() {
    var R = D.real;
    line('cvReal', 'tpReal', [{ name: 'Nominal 10Y', pts: pts(R.y10), color: GK.css('--gold') }, { name: 'Real 10Y', pts: pts(R.tips10), color: GK.css('--up') }, { name: 'Breakeven', pts: pts(R.be10), color: GK.css('--amber') }],
      { yFmt: function (x) { return fmt(x, 2) + '%'; } });
  }
  function fiscal() {
    var F = D.fiscal;
    ['cvDebt', 'cvInt', 'cvTga'].forEach(function (id) { $(id).parentNode.style.display = F ? '' : 'none'; });
    if (!F) {
      ['debtKpi', 'intKpi'].forEach(function (id) { $(id).innerHTML = '<div style="grid-column:1/-1">Treasury Fiscal Data did not answer. The desk retries every 12 hours; the curve above is unaffected.</div>'; });
      $('tgaNote').textContent = 'The cash balance loads with the next Fiscal Data pull.';
      return;
    }
    var L = F.last, Y = F.yearAgo;
    $('debtKpi').innerHTML = L ? '<div><b>$' + fmt(L.total, 2) + 'T</b>total, ' + esc(new Date(L.t).toISOString().slice(0, 10)) + '</div>' +
      '<div><b>$' + fmt(L.pub, 2) + 'T</b>held by the public</div>' +
      (Y ? '<div><b>+$' + fmt(L.total - Y.total, 2) + 'T</b>in a year</div>' : '') +
      (F.perDayBn != null ? '<div><b>$' + fmt(F.perDayBn, 1) + 'B</b>added per day, 1-year average</div>' : '') : '';
    line('cvDebt', 'tpDebt', [{ name: 'Total', pts: (F.debt || []).map(function (r) { return { x: r.t, y: r.total }; }), color: GK.css('--gold'), fill: true },
      { name: 'Held by the public', pts: (F.debt || []).map(function (r) { return { x: r.t, y: r.pub }; }), color: GK.css('--blue') }], { yFmt: function (x) { return '$' + fmt(x, 1) + 'T'; } });
    var R = F.rates || {};
    var tot = R['Total Interest-bearing Debt'] || [], lastR = tot[tot.length - 1], yr = tot.length > 12 ? tot[tot.length - 13] : null;
    $('intKpi').innerHTML = (lastR ? '<div><b>' + fmt(lastR.v, 3) + '%</b>average rate, all debt</div>' : '') +
      (yr && lastR ? '<div><b>' + bp(lastR.v - yr.v) + '</b>vs a year ago</div>' : '') +
      (F.interestEstTn != null ? '<div><b>≈ $' + fmt(F.interestEstTn, 2) + 'T</b>a year at that rate (estimate)</div>' : '') +
      (R['Treasury Bills'] && R['Treasury Bills'].length ? '<div><b>' + fmt(R['Treasury Bills'][R['Treasury Bills'].length - 1].v, 2) + '%</b>on bills</div>' : '');
    line('cvInt', 'tpInt', [
      { name: 'All interest-bearing', pts: pts(R['Total Interest-bearing Debt']), color: GK.css('--gold'), width: 2.4 },
      { name: 'Bills', pts: pts(R['Treasury Bills']), color: GK.css('--blue') },
      { name: 'Notes', pts: pts(R['Treasury Notes']), color: GK.css('--up') },
      { name: 'Bonds', pts: pts(R['Treasury Bonds']), color: GK.css('--amber') }], { yFmt: function (x) { return fmt(x, 2) + '%'; } });
    var T = F.tga || [];
    line('cvTga', 'tpTga', [{ name: 'TGA balance', pts: T.map(function (p) { return { x: p.t, y: p.v }; }), color: GK.css('--blue'), fill: true }], { yFmt: function (x) { return '$' + fmt(x, 0) + 'B'; } });
    if (T.length > 25) {
      var a = T[T.length - 1], b = T[T.length - 22];
      $('tgaNote').textContent = 'Balance $' + fmt(a.v, 0) + 'B on ' + new Date(a.t).toISOString().slice(0, 10) + ', ' + (a.v >= b.v ? 'up' : 'down') + ' $' + fmt(Math.abs(a.v - b.v), 0) + 'B in about a month. ' +
        (a.v - b.v > 100 ? 'A fast refill drains reserves from the banking system.' : b.v - a.v > 100 ? 'Spending it down adds liquidity back to markets.' : 'Little net effect on liquidity.');
    }
  }

  function render() {
    kpis(); curve(); read(); spreads(); real(); fiscal();
    $('asof').textContent = D.curve.asOf ? 'Curve as of ' + new Date(D.curve.asOf).toISOString().slice(0, 10) + (D.stale ? ' · last known' : '') : '';
  }
  function load() { G.getJSON('/api/page/treasury').then(function (d) { D = d; render(); }).catch(function () { $('kpis').innerHTML = '<div class="empty">Treasury data is unavailable right now. It retries every 15 minutes.</div>'; }); }
  load();
  setInterval(function () { if (!document.hidden) load(); }, 900000);
})();
