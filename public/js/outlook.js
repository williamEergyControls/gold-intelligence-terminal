/* OUTLOOK
   INIT     /api/outlook (latest stored outlook + score history + graded calls)
   POLL     outlook every 15 min (it is rebuilt ~4x a day), ledger every 60 s
   PUBLISH  two scores, the read, factor tables, flips, street-missing list,
            long-range cards, forecast ledger (predicted vs actual, error vs naive) */
(function () {
  'use strict';
  var G = window.GT, $ = function (s) { return document.querySelector(s); };
  var esc = G.esc, fmt = G.fmt, sgn = G.sgn;
  var O = null, HIST = [], H = '1d';
  try { H = localStorage.getItem('git-led-h') || '1d'; } catch (e) { }
  var HZ = [['1m', '1 min'], ['30m', '30 min'], ['1d', '1 day'], ['1w', '1 week'], ['30d', '30 days']];
  var ARROW = {
    up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>',
    down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/></svg>',
    flat: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h10"/></svg>'
  };
  function col(sc) { return sc >= 6.8 ? 'var(--up)' : sc >= 4.5 ? 'var(--gold)' : 'var(--dn)'; }
  function dots(sc, c) {
    var h = '<div class="dots10" style="color:' + c + '">';
    for (var i = 1; i <= 10; i++) h += '<i class="' + (sc >= i - 0.5 ? 'on' : '') + '"></i>';
    return h + '</div>';
  }
  function trend(key) {
    if (HIST.length < 2) return 'First reading. The trend shows after a few days.';
    var now = HIST[HIST.length - 1], then = null;
    for (var i = HIST.length - 1; i >= 0; i--) { if (Date.parse(now.day) - Date.parse(HIST[i].day) >= 28 * 864e5) { then = HIST[i]; break; } }
    then = then || HIST[0];
    var d = now[key] - then[key];
    return (Math.abs(d) < 0.15 ? 'Unchanged' : (d > 0 ? 'Up ' : 'Down ') + Math.abs(d).toFixed(1)) + ' since ' + new Date(then.day).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function histChart(id, key) {
    if (!window.GK) return;
    var c = G.css(key === 'econ' ? '--blue' : '--gold');
    GK.line(document.getElementById(id), null, { series: [{ name: key === 'econ' ? 'Economy' : 'Gold score', color: c, width: 2, pts: HIST.map(function (h) { return { x: Date.parse(h.day), y: h[key] }; }) }],
      yMin: 0, yMax: 10, yFmt: function (v) { return fmt(v, 0); }, empty: 'Score history builds one point a day' });
  }

  function hero() {
    var e = O.econ, g = O.gold, ec = col(e.score), gc2 = col(g.score);
    $('#eCov').textContent = e.coverage;
    $('#gCov').textContent = g.coverage;
    $('#eBody').innerHTML =
      '<div class="score"><div class="big" style="color:' + ec + '">' + fmt(e.score, 1) + '<small>/ 10</small></div>' +
      '<div class="lab"><span class="ph">' + esc(e.phase) + '</span><span class="tr">' + esc(trend('econ')) + '</span></div></div>' +
      dots(e.score, ec) + '<div class="dots10-l"><span>Contraction</span><span>Expansion</span></div>' +
      (HIST.length >= 3 ? '<div class="hist"><canvas id="cvE" aria-label="Economy score history"></canvas></div>' : '<div class="hist-e">Score history draws once there are three daily readings.</div>');
    var od = g.odds;
    $('#gBody').innerHTML =
      '<div class="score"><div class="big" style="color:' + gc2 + '">' + fmt(g.score, 1) + '<small>/ 10</small></div>' +
      '<div class="lab"><span class="ph">' + esc(g.stance) + '</span><span class="tr">' + esc(trend('gold')) + (g.price ? ' · gold $' + fmt(g.price, 0) : '') + '</span></div></div>' +
      dots(g.score, gc2) + '<div class="dots10-l"><span>Trim or wait</span><span>Accumulate</span></div>' +
      '<p class="note">' + esc(g.stanceNote) + '</p>' +
      (od ? '<div class="odds">On days that scored like today, gold was higher 3 months later <b>' + Math.round(od.up * 100) + '%</b> of the time (median <b class="' + G.cls(od.median) + '">' + sgn(od.median) + fmt(od.median * 100, 1) + '%</b>, ' + od.n + ' days).<small>' + esc(od.note) + '</small></div>'
          : '<div class="odds">Historical odds appear once the warehouse holds 15 months of gold, real-yield and dollar history.</div>') +
      (HIST.length >= 3 ? '<div class="hist"><canvas id="cvG" aria-label="Gold score history"></canvas></div>' : '');
    if (HIST.length >= 3) { histChart('cvE', 'econ'); histChart('cvG', 'gold'); }
    $('#read').textContent = O.narrative.text;
    $('#readEng').textContent = O.narrative.engine === 'template' ? 'Summary' : 'AI summary';
    $('#built').textContent = 'Built ' + G.ago(O.ts) + ' · rebuilt about every 6 hours';
  }
  function factors(el, fs) {
    $(el).innerHTML = fs.map(function (f) {
      var cls = f.s == null ? '' : f.pts > 0.05 ? ' p' : f.pts < -0.05 ? ' n2' : '';
      return '<div class="fx' + (f.s == null ? ' off' : '') + '"><span class="n">' + esc(f.label) + '</span>' +
        '<span class="e' + cls + '" title="Contribution in weighted points">' + (f.s == null ? 'n/a' : sgn(f.pts) + fmt(f.pts, 1)) + '</span>' +
        '<span class="rd">' + esc(f.reading) + '</span><span class="ms keepcase">' + esc(f.source) + (f.asOf ? ' · ' + esc(f.asOf) : '') + '</span></div>';
    }).join('');
  }
  function lists() {
    $('#flip').innerHTML = O.gold.flips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    $('#miss').innerHTML = O.missing.length ? O.missing.map(function (m) { return '<li><b><i class="t ' + m.tone + '"></i>' + esc(m.title) + '</b><span>' + esc(m.detail) + '</span></li>'; }).join('')
      : '<li><span>Nothing at an unusual reading right now. That is information too: no slow signal is shouting.</span></li>';
    $('#longs').innerHTML = O.outlooks.map(function (o) {
      return '<div class="lc ' + o.dir + '"><h4>' + esc(o.title) + '</h4><div class="call"><span class="arr">' + ARROW[o.dir] + '</span>' + esc(o.call) + '</div>' +
        '<div class="meta">' + esc(o.conf) + ' · ' + esc(o.horizon) + '</div><ul>' + o.why.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
    }).join('');
    var I = O.inputs || {};
    var names = { cot: 'CFTC positioning', insiders: 'SEC Form 4 insiders', crowd: 'Your news and YouTube', shipping: 'Shipping (PortWatch)', drought: 'Drought map' };
    $('#inputs').innerHTML = Object.keys(names).map(function (k) { return '<div><span class="n">' + names[k] + '</span><span class="v ' + (/unavailable|off|thin/.test(I[k] || '') ? 'dim' : '') + '">' + esc(I[k] || '–') + '</span><span></span></div>'; }).join('') +
      (O.ml ? '<div><span class="n">Short-term model (5 days)<small>Context only, not in the score</small></span><span class="v ' + (O.ml.p >= 0.5 ? 'up' : 'dn') + '">' + (O.ml.p >= 0.5 ? 'Up ' : 'Down ') + Math.round(O.ml.p * 100) + '%</span><span></span></div>' : '');
  }
  function card(R) {
    var el = $('#card');
    if (!R.graded || !R.graded.length) {
      el.innerHTML = '<div class="empty"><b>No graded calls yet.</b> Every outlook is stored with the gold price that day. The first call gets graded on ' + esc(R.firstGrade || 'its 91st day') + ', then this table shows how often each stance was right.</div>';
      return;
    }
    el.innerHTML = '<table class="tb"><thead><tr><th>Stance</th><th class="r">Calls</th><th class="r">Gold higher after 91 days</th><th class="r">Average move</th></tr></thead><tbody>' +
      R.graded.map(function (g) { return '<tr><td>' + esc(g.stance) + '</td><td class="r">' + g.n + '</td><td class="r">' + Math.round(g.up * 100) + '%</td><td class="r ' + G.cls(g.avg) + '">' + sgn(g.avg) + fmt(g.avg * 100, 1) + '%</td></tr>'; }).join('') + '</tbody></table>';
  }

  /* ---------- forecast ledger ---------- */
  $('#hz').innerHTML = HZ.map(function (h) { return '<button type="button" data-h="' + h[0] + '"' + (h[0] === H ? ' class="on"' : '') + '>' + h[1] + '</button>'; }).join('');
  $('#hz').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-h]'); if (!b) return;
    H = b.dataset.h; try { localStorage.setItem('git-led-h', H); } catch (er) { }
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
    loadLedger();
  });
  function pc(x, d) { return x == null ? '–' : fmt(x, d == null ? 2 : d) + '%'; }
  function ledger(L) {
    var l30 = L.last30, t = L.today || {}, op = L.open;
    var skill = l30.mapeNaive && l30.mapeBlend != null ? (1 - l30.mapeBlend / l30.mapeNaive) * 100 : null;
    var k = '';
    k += '<div class="kpi"><label>Latest forecast</label><b>' + (op ? '$' + fmt(op.blend, 2) : '–') + '</b><small>' + (op ? 'for ' + new Date(op.target).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ', from $' + fmt(op.base, 2) : 'Market closed or warming up') + '</small></div>';
    k += '<div class="kpi"><label>Average error, 30 days</label><b>' + pc(l30.mapeBlend, H === '1m' ? 3 : 2) + '</b><small>Naive guess: ' + pc(l30.mapeNaive, H === '1m' ? 3 : 2) + ' · ' + (l30.n || 0) + ' graded</small></div>';
    k += '<div class="kpi"><label>Skill vs naive</label><b class="' + (skill == null ? '' : G.cls(skill)) + '">' + (skill == null ? '–' : sgn(skill) + fmt(skill, 1) + '%') + '</b><small>Above 0 means it beats "price stays put"</small></div>';
    k += '<div class="kpi"><label>Within ' + L.band + '%</label><b>' + (l30.hitBand == null ? '–' : Math.round(l30.hitBand * 100) + '%') + '</b><small>Within 5%: ' + (l30.hit5 == null ? '–' : Math.round(l30.hit5 * 100) + '%') + '</small></div>';
    k += '<div class="kpi"><label>Last 24 hours</label><b>' + pc(t.mape_blend, H === '1m' ? 3 : 2) + '</b><small>' + (t.n || 0) + ' graded · naive ' + pc(t.mape_naive, H === '1m' ? 3 : 2) + '</small></div>';
    $('#lk').innerHTML = k;
    var w = L.weights || {}, ws = (w.naive || 0) + (w.drift || 0) + (w.revert || 0) || 1;
    $('#wts').innerHTML = '<span class="tmeta" style="font-size:13px;color:var(--dim)">Blend weights, relearned nightly from each model\'s error:</span>' +
      [['naive', 'Stays put'], ['drift', 'Momentum'], ['revert', 'Back to the mean']].map(function (m) { return '<span class="chip plain">' + m[1] + ' ' + Math.round((w[m[0]] || 0) / ws * 100) + '%</span>'; }).join('');
    var gold = G.css('--gold'), blue = G.css('--blue'), dim = G.css('--dim');
    var series = [{ name: 'Gold spot', color: gold, width: 1.6, pts: (L.ticks || []).map(function (x) { return { x: x.ts, y: x.price }; }) }];
    var P = (L.pairs || []).filter(function (p) { return p.actual > 0; });
    series.push({ name: 'Forecast (at target time)', color: blue, noLine: true, dots: true, r: 3, pts: P.map(function (p) { return { x: p.target, y: p.blend }; }) });
    if (op) series.push({ name: 'Open forecast', color: dim, noLine: true, dots: true, r: 5, pts: [{ x: op.target, y: op.blend }] });
    GK.line(document.getElementById('cvLed'), document.getElementById('tipLed'), { series: series, yFmt: function (v) { return '$' + fmt(v, 0); },
      xFmt: function (x) { var d = new Date(x); return H === '1m' || H === '30m' ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : (d.getMonth() + 1) + '/' + d.getDate(); },
      empty: 'The ledger fills as minute ticks arrive (market hours only)',
      tipX: function (x) { return new Date(x).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } });
    $('#lg').innerHTML = '<span class="sw"><i style="background:var(--gold)"></i>Gold spot</span><span class="sw"><i style="background:var(--blue);border-radius:50%"></i>Forecast, plotted at its target time</span>';
    $('#honest').textContent = 'How to read this: "naive" assumes the price will not move. Short-horizon gold is close to a random walk, so a model that beats naive by even a few percent is doing real work. '
      + 'A 5% band is easy at 1 minute and hard at 30 days, so each horizon also shows a tighter band (' + L.band + '% here). Forecasts made while the market is closed are voided, never guessed.';
  }
  function loadLedger() { G.getJSON('/api/forecast?h=' + H).then(ledger).catch(function () { $('#lk').innerHTML = '<div class="empty">The ledger is unavailable right now.</div>'; }); }

  function load() {
    G.getJSON('/api/outlook').then(function (R) {
      HIST = R.history || [];
      O = R.outlook;
      if (!O) { $('#eBody').innerHTML = '<div class="empty">The first outlook builds within the hour, once the warehouse has data.</div>'; return; }
      hero(); factors('#gF', O.gold.factors); factors('#eF', O.econ.factors); lists(); card(R);
    }).catch(function () { $('#eBody').innerHTML = '<div class="empty">The outlook is unavailable right now. It retries in a few minutes.</div>'; });
  }
  load(); loadLedger();
  setInterval(function () { if (!document.hidden) load(); }, 900000);
  setInterval(function () { if (!document.hidden) loadLedger(); }, 60000);
})();
