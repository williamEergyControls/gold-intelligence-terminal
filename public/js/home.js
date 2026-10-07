/* HOME
   INIT bootstrap 1D → POLL bootstrap 60 s, quote 20 s → PUBLISH gold, rates, alerts, watchlist, basket, drought map
   news, ideas and calendar come from their own modules */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var G = window.GT, fmt = G.fmt, sgn = G.sgn, cls = G.cls, esc = G.esc, css = G.css;
  var NAME = ''; try { NAME = localStorage.getItem('git-name') || ''; } catch (e) { }
  var B = null;
  var hr = new Date().getHours();
  $('#hello').textContent = (hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening') + (NAME ? ', ' + NAME : '');

  /* ---- basket ---- */
  var P = { name: NAME, wf: 15, we: 10, wi: 10, wh: 30, wg: 10 };
  try { Object.assign(P, JSON.parse(localStorage.getItem('git-profile') || '{}')); } catch (e) { }
  function saveP() { try { localStorage.setItem('git-profile', JSON.stringify(P)); } catch (e) { } }
  var op = $('#opname'); op.value = P.name || ''; op.addEventListener('input', function () { P.name = op.value.slice(0, 24); saveP(); });
  ['wf', 'we', 'wi', 'wh', 'wg'].forEach(function (id) {
    var el = $('#' + id), lb = el.nextElementSibling;
    el.value = P[id]; lb.textContent = P[id] + '%';
    el.addEventListener('input', function () { P[id] = +el.value; lb.textContent = P[id] + '%'; saveP(); calc(); });
  });
  function calc() {
    if (!B) return;
    var c = (B.macro && B.macro.components) || {}, d = (B.series && B.series.dailyCloses) || [];
    var n = Math.min(252, d.length - 2);
    var goldYoY = (d.length > 60 && n > 0) ? (d[d.length - 1] / d[d.length - 1 - n] - 1) * 100 : 0;
    var rest = Math.max(0, 100 - P.wf - P.we - P.wi - P.wh - P.wg);
    var cpi = c.cpi != null ? c.cpi : null;
    if (cpi == null) { $('#riVal').textContent = '–'; return; }
    var real = (P.wf * (c.food != null ? c.food : cpi) + P.we * (c.energy != null ? c.energy : cpi) + P.wi * (c.autoins != null ? c.autoins : cpi) + P.wh * (c.housing != null ? c.housing : cpi) + P.wg * goldYoY + rest * cpi) / 100;
    var gap = real - cpi;
    $('#riVal').textContent = fmt(real, 1) + '%';
    $('#riFed').textContent = fmt(cpi, 1) + '%';
    var rg = $('#riGap'); rg.textContent = sgn(gap) + fmt(gap, 1) + ' pts'; rg.className = gap > 0 ? 'dn' : 'up';
  }

  /* ---- gold ---- */
  function renderGold() {
    if (!B || !B.gold) return;
    var g = B.gold, p = g.changePct == null ? 0 : g.changePct;
    $('#px').textContent = '$' + fmt(g.price);
    var bc = $('#pxc'); bc.className = 'bigchg ' + cls(p); bc.textContent = sgn(g.change) + fmt(g.change) + ' (' + sgn(p) + fmt(p) + '%) today';
    var gc = $('#gchip'); var st = g.delay === 'stale' ? ['Last known' + (g.ageMs ? ', ' + G.ago(Date.now() - g.ageMs) : ''), 'evt'] : g.delay === 'daily' ? ['Daily close', 'month'] : ['Near live', 'near'];
    gc.textContent = st[0]; gc.className = 'chip ' + st[1];
    var m = B.ml;
    $('#mlLine').innerHTML = m && m.p != null
      ? '5-day model: <b class="' + (m.p >= 0.5 ? 'up' : 'dn') + '">' + (m.p >= 0.5 ? 'bullish' : 'bearish') + ' ' + Math.round(m.p * 100) + '%</b><br>' + esc(G.sc(m.regime && m.regime.state || '')) + ' regime, ' + (m.final ? m.final.agreeing : '–') + ' of 10 agents agree'
      : 'Model warming up';
    G.feed(B.mode === 'live', B.mode === 'live' ? 'Live' : 'Last known prices');
    $('#asof').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var d = ((B.series && B.series.dailyCloses) || []).slice(-90);
    if (d.length > 2 && window.GK) {
      var t0 = Date.now() - (d.length - 1) * 864e5 * 1.4;
      GK.line($('#cvGold'), null, { series: [{ name: 'Gold', pts: d.map(function (v, i) { return { x: t0 + i * 864e5 * 1.4, y: v }; }), color: css('--gold'), width: 2, fill: true }], yFmt: function (v) { return fmt(v, 0); }, xFmt: function () { return ''; } });
    }
  }
  function renderRates() {
    if (!B || !B.macro) return;
    var keys = ['US10Y', 'REAL10Y', 'BREAKEV', 'SOFR', 'EFFR'], rows = B.macro.rows || [];
    var h = keys.map(function (k) {
      var r = rows.find(function (x) { return x.key === k; }); if (!r) return '';
      var d = (r.value - r.prior) * 100;
      return '<div><span class="n">' + esc(G.sc(r.label)) + '</span><span class="v">' + fmt(r.value, 2) + '%</span><span class="c ' + (d > 0 ? 'dn' : d < 0 ? 'up' : 'mut') + '">' + sgn(d) + fmt(d, 1) + ' bp</span></div>';
    }).join('');
    if (B.dxy) { var dp = B.dxy.changePct || 0; h += '<div><span class="n">US dollar index</span><span class="v">' + fmt(B.dxy.price, 2) + '</span><span class="c ' + (dp >= 0 ? 'dn' : 'up') + '">' + sgn(dp) + fmt(dp, 2) + '%</span></div>'; }
    $('#ratesBody').innerHTML = h || '<div class="empty">Rates loading</div>';
  }
  function renderAlerts() {
    if (!B || !B.alerts) return;
    var list = B.alerts;
    $('#alCount').textContent = list.length + ' active';
    $('#alList').innerHTML = list.map(function (a) { return '<div class="al ' + a.se + '"><span class="g"></span><time>' + esc(a.t) + '</time><p>' + esc(G.sc(a.txt)) + '</p></div>'; }).join('') || '<div class="empty">No alerts right now.</div>';
  }
  function renderHealth() {
    if (!B || !B.health) return;
    $('#hBody').innerHTML = B.health.map(function (h) { return '<span class="' + (h.status === 'online' ? 'on' : h.status === 'degraded' ? 'deg' : '') + '" title="' + esc(h.status) + '"><i></i>' + esc(h.name) + '</span>'; }).join('');
  }
  function renderTape() {
    if (!B || !B.tape) return;
    $('#tapeA').innerHTML = B.tape.map(function (t) {
      var ch = t.changePct == null ? 0 : t.changePct, dg = t.price > 500 ? 1 : (t.price > 20 ? 2 : 3);
      return '<span class="tg"><span class="k">' + esc(t.symbol) + '</span><span class="v">' + fmt(t.price, dg) + '</span><span class="c ' + cls(ch) + '">' + sgn(ch) + fmt(ch, 2) + '%</span></span>';
    }).join('');
  }

  /* ---- watchlist ---- */
  function W() { try { return JSON.parse(localStorage.getItem('git-watch') || '[]'); } catch (e) { return []; } }
  function renderWatch() {
    var list = W(), wl = $('#watchList');
    if (!list.length) { wl.innerHTML = '<div class="empty">Add tickers you follow, for example NEM, GLD, SPY.</div>'; return; }
    G.getJSON('/api/watch?syms=' + encodeURIComponent(list.join(','))).then(function (r) {
      wl.innerHTML = (r.quotes || []).map(function (q) {
        var ch = q.changePct || 0;
        return '<div class="watchrow"><b>' + esc(q.symbol) + '</b><span class="mut" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(q.name || '') + '</span><span>' + fmt(q.price, 2) + '</span><span class="r ' + cls(ch) + '">' + sgn(ch) + fmt(ch, 2) + '%</span><button class="del" data-s="' + esc(q.symbol) + '" aria-label="Remove ' + esc(q.symbol) + '">×</button></div>';
      }).join('');
    }).catch(function () { wl.innerHTML = '<div class="empty">Quotes unavailable right now.</div>'; });
  }
  $('#watchList').addEventListener('click', function (e) {
    var d = e.target.closest('.del'); if (!d) return;
    localStorage.setItem('git-watch', JSON.stringify(W().filter(function (s) { return s !== d.dataset.s; }))); renderWatch();
  });
  function add() {
    var v = ($('#addsym').value || '').trim().toUpperCase(), list = W();
    if (v && list.indexOf(v) < 0 && list.length < 12) list.push(v);
    $('#addsym').value = ''; localStorage.setItem('git-watch', JSON.stringify(list)); renderWatch();
  }
  $('#addgo').addEventListener('click', add);
  $('#addsym').addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });

  /* ---- analyst ---- */
  var busy = false;
  $('#runA').addEventListener('click', function () {
    if (busy || !B) return; busy = true;
    var btn = this, out = $('#aOut');
    btn.disabled = true; btn.textContent = 'Thinking…'; out.classList.remove('hide'); out.innerHTML = '<span class="hint">Asking the analyst…</span>';
    fetch('/api/ai/analyst', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: { operator: P.name || 'operator', realInflation: parseFloat($('#riVal').textContent) || null } }) })
      .then(function (r) { return r.json(); })
      .then(function (ai) { out.innerHTML = '<div class="eng">' + esc(ai.engine) + '</div><div class="ln">' + esc(ai.text) + '</div>'; })
      .catch(function (e) { out.textContent = 'The analyst is unavailable: ' + e.message; })
      .then(function () { btn.disabled = false; btn.textContent = 'Ask again'; busy = false; });
  });

  /* ---- drought map ---- */
  function drawMap() {
    if (!window.USMap) return;
    G.getJSON('/api/drought').then(function (d) {
      var r = MapKit.ramp(MapKit.DROUGHT), vals = {};
      Object.keys(d.states).forEach(function (k) { vals[k] = d.states[k].drought; });
      $('#mapSrc').textContent = 'U.S. Drought Monitor, map of ' + d.mapDate + (d.conus ? ' · ' + d.conus.drought + '% of the lower 48 in drought' : '');
      USMap.draw($('#mapBody'), {
        title: 'Share of each state in drought', values: vals,
        color: function (v) { return v < 0.5 ? 'var(--panel2)' : r(v / 100); },
        tip: function (a, n, v) { var s = d.states[a]; return '<b>' + n + '</b><div class="m">' + (s ? fmt(s.drought, 1) + '% in drought (D1–D4)<br>' + fmt(s.d3 + s.d4, 1) + '% extreme or exceptional' + (s.prevDrought != null ? '<br>' + sgn(s.drought - s.prevDrought) + fmt(s.drought - s.prevDrought, 1) + ' pts vs last week' : '') : 'No data') + '</div>'; },
        legend: '<span>0%</span><span class="ramp" style="background:' + MapKit.rampCss(MapKit.DROUGHT) + '"></span><span>100% of state area in drought</span>'
      });
    }).catch(function () { $('#mapBody').innerHTML = '<div class="empty">Drought map loads after the first weekly pull.</div>'; });
  }

  function renderAll() { renderTape(); renderGold(); renderRates(); renderAlerts(); renderHealth(); calc(); }
  window.addEventListener('themechange', function () { renderGold(); drawMap(); });

  if (window.Ideas) Ideas.mount($('#ideasBody'), { limit: 6 });
  if (window.NewsFeed) NewsFeed.mount($('#newsBody'), { topic: 'all', limit: 6, more: true, onLoad: function (d) { $('#srcCount').textContent = d.sources ? d.sources + ' sources' + (d.favorites ? ', ' + d.favorites + ' yours' : '') : ''; } });
  if (window.Cal) Cal.mount($('#calBody'), { scope: 'all', compact: true, limit: 6 });
  renderWatch(); drawMap();

  (function init(wait) {
    G.getJSON('/api/bootstrap?tf=1D').then(function (b) { B = b; renderAll(); })
      .catch(function (e) { $('#status .mid').textContent = 'Data temporarily unavailable (' + e.message + '). Retrying.'; setTimeout(function () { init(Math.min(wait * 2, 30000)); }, wait); });
  })(4000);
  setInterval(function () { if (!document.hidden && B) G.getJSON('/api/bootstrap?tf=1D').then(function (b) { B = b; renderAll(); }).catch(function () { }); }, 60000);
  setInterval(function () {
    if (document.hidden || !B) return;
    G.getJSON('/api/quote').then(function (q) { if (isFinite(q.gold) && B.gold.prevClose) { B.gold.price = q.gold; B.gold.change = q.gold - B.gold.prevClose; B.gold.changePct = (q.gold / B.gold.prevClose - 1) * 100; } renderGold(); }).catch(function () { });
  }, 20000);
})();
