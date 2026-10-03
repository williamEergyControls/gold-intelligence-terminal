/* ================================================================
   ML STRIP — the same model/vol band on every page.
   POLL /api/ml/strip?page=<page> every 120 s (server memo 60 s, all inputs
   precomputed) → PUBLISH a one-line band under the header/tape:
     gold 5-day ML signal · cross-asset stress · page focus series
     (RV20, GARCH 20d, 5-day 1σ range, regime, σ-move) · top σ alert
   ================================================================ */
(function () {
  'use strict';
  var tok = null; try { tok = localStorage.getItem('git-token'); } catch (e) { }
  if (!tok) return;
  var path = location.pathname.replace(/\.html$/, '').replace(/^\//, '') || 'home';
  var page = path === 'index' ? 'home' : path.split('/')[0];
  if (page === 'login' || page === 'admin' || page === 'diagnostics') return;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n, d) { if (n == null || !isFinite(n)) return '--'; return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
  var sg = function (v) { return v > 0 ? '+' : ''; };

  var bar = document.createElement('div');
  bar.id = 'mlstrip';
  bar.innerHTML = '<span class="ms-k">ML · VOL</span><span class="ms-d">loading…</span>';
  var anchor = document.getElementById('tape') || document.getElementById('top');
  if (!anchor || !anchor.parentNode) return;
  anchor.parentNode.insertBefore(bar, anchor.nextSibling);

  function regCls(r) { return r === 'STRESS' ? 'dn' : r === 'ELEVATED' ? 'gold' : r === 'LOW' ? 'up' : 'mut'; }
  function cell(href, k, b, d, bcls, title) {
    return '<a class="ms-c" href="' + href + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="ms-k">' + esc(k) + '</span><b class="' + (bcls || '') + '">' + b + '</b><span class="ms-d">' + d + '</span></a>';
  }
  function render(d) {
    var h = '';
    if (d.ml) {
      var hit = d.ml.hit != null ? 'hit ' + Math.round(d.ml.hit * 100) + '% (' + d.ml.graded + ')' : 'hit rate pending';
      h += cell('/ai.html', 'ML · GOLD 5D', esc(d.ml.dir) + ' ' + Math.round(d.ml.p * 100) + '%', 'HMM ' + esc(d.ml.regime || '--') + ' · ' + hit, d.ml.p >= 0.5 ? 'up' : 'dn', d.ml.model);
    } else h += cell('/ai.html', 'ML · GOLD 5D', 'WARMING', 'first prediction after the hourly cron', 'dim');
    if (d.stress && d.stress.score != null) h += cell('/vol.html', 'STRESS', d.stress.score + '/100', esc(d.stress.regime), regCls(d.stress.regime), 'cross-asset vol percentile composite (CALC)');
    (d.focus || []).forEach(function (f) {
      var b, dd;
      if (f.kind === 'peg') { b = sg(f.devBp) + fmt(f.devBp, 1) + ' bp'; dd = 'depeg · ' + esc(f.regime); }
      else if (f.kind === 'index') { b = fmt(f.last, 1); dd = (f.pct != null ? f.pct + 'th pctl · ' : '') + esc(f.regime); }
      else {
        var y = f.kind === 'yield';
        b = 'RV ' + fmt(f.rv20, y ? 0 : 1) + (y ? 'bp' : '%');
        dd = 'GARCH ' + fmt(f.garch20, y ? 0 : 1) + (f.exp5d != null ? ' · 5D ±' + fmt(f.exp5d, y ? 0 : (Math.abs(f.last) < 20 ? 4 : Math.abs(f.last) < 500 ? 2 : 0)) + (y ? 'bp' : '') : '') + ' · ' + esc(f.regime);
      }
      if (f.z != null && Math.abs(f.z) >= 2) dd += ' · <b class="dn">' + sg(f.z) + fmt(f.z, 1) + 'σ</b>';
      h += cell('/vol.html', f.id, b, dd, regCls(f.regime), f.label + ' · ' + f.source + (f.stale ? ' · STALE' : ''));
    });
    if (d.alerts && d.alerts.length) {
      var a = d.alerts[0];
      h += cell('/vol.html', 'σ ALERT', esc(a.label), sg(a.z) + fmt(a.z, 1) + 'σ' + (d.alerts.length > 1 ? ' · +' + (d.alerts.length - 1) + ' more' : ''), 'dn');
    }
    if (!d.focus || !d.focus.length) h += '<span class="ms-c"><span class="ms-k">VOL</span><span class="ms-d">warehouse warming — first ingest within 10 min</span></span>';
    bar.innerHTML = h;
  }
  function load() {
    fetch('/api/ml/strip?page=' + encodeURIComponent(page), { headers: { 'x-session': tok } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) render(d); })
      .catch(function () { });
  }
  load();
  setInterval(function () { if (!document.hidden) load(); }, 120000);
})();
