/* ================================================================
   INSIGHT STRIP — model + volatility cards at the top of every desk.
   POLL    /api/ml/strip?page=<page> every 120 s (server memo 60 s, no upstream calls)
   PUBLISH a responsive row of equal cards (auto-fit grid, wraps on small screens):
           gold 5-day model · cross-asset stress · page focus series · page extras · top σ alert
   mount   after .pagehead inside <main>, else at the top of <main>
   ================================================================ */
(function () {
  'use strict';
  var tok = null; try { tok = localStorage.getItem('git-token'); } catch (e) { }
  if (!tok) return;
  var page = (window.GT && GT.page) || (document.body.getAttribute('data-page')) || 'home';
  if (page === 'login' || page === 'admin' || page === 'diagnostics' || page === 'search') return;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n, d) { if (n == null || !isFinite(n)) return '–'; return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
  var sg = function (v) { return v > 0 ? '+' : ''; };
  var REG = { STRESS: 'Stress', ELEVATED: 'Elevated', NORMAL: 'Normal', LOW: 'Calm' };
  function reg(r) { return REG[r] || (r && r !== '—' ? String(r).charAt(0) + String(r).slice(1).toLowerCase() : 'n/a'); }
  function regCls(r) { return r === 'STRESS' ? 'dn' : r === 'ELEVATED' ? 'gold' : r === 'LOW' ? 'up' : ''; }

  var main = document.querySelector('main');
  if (!main) return;
  var bar = document.createElement('div');
  bar.id = 'mlstrip'; bar.className = 'loading'; bar.setAttribute('aria-label', 'Model and volatility summary');
  bar.innerHTML = '<span class="ms-c"></span><span class="ms-c"></span><span class="ms-c"></span><span class="ms-c"></span>';
  var head = main.querySelector('.pagehead');
  if (head && head.parentNode === main) main.insertBefore(bar, head.nextSibling); else main.insertBefore(bar, main.firstChild);

  function cell(href, k, b, d, bcls, title) {
    return '<a class="ms-c" href="' + href + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="ms-k">' + esc(k) + '</span><b class="' + (bcls || '') + '">' + b + '</b><span class="ms-d">' + d + '</span></a>';
  }
  function render(d) {
    var h = '';
    if (d.ml) {
      var hit = d.ml.hit != null ? 'hit rate ' + Math.round(d.ml.hit * 100) + '% (' + d.ml.graded + ')' : 'hit rate pending';
      h += cell('/ai.html', 'Gold 5-day model', esc(String(d.ml.dir).charAt(0) + String(d.ml.dir).slice(1).toLowerCase()) + ' · ' + Math.round(d.ml.p * 100) + '%', reg(d.ml.regime) + ' regime · ' + hit, d.ml.p >= 0.5 ? 'up' : 'dn', d.ml.model);
    } else h += cell('/ai.html', 'Gold 5-day model', 'Warming up', 'first prediction after the hourly run', 'dim');
    if (d.stress && d.stress.score != null) h += cell('/vol.html', 'Cross-asset stress', d.stress.score + ' / 100', reg(d.stress.regime) + ' · vol percentile composite', regCls(d.stress.regime));
    (d.extras || []).forEach(function (x) { h += cell(x.href || '#', x.k, esc(x.b), esc(x.d), x.cls === 'mut' ? '' : x.cls, x.title); });
    (d.focus || []).forEach(function (f) {
      var b, dd;
      if (f.kind === 'peg') { b = sg(f.devBp) + fmt(f.devBp, 1) + ' bp'; dd = 'peg deviation · ' + reg(f.regime); }
      else if (f.kind === 'index') { b = fmt(f.last, 1); dd = (f.pct != null ? f.pct + 'th pctl · ' : '') + reg(f.regime); }
      else {
        var y = f.kind === 'yield';
        var dg = Math.abs(f.last) < 20 ? 3 : Math.abs(f.last) < 500 ? 2 : 0;
        b = y ? fmt(f.last, 2) + '%' : fmt(f.last, dg);
        dd = 'RV ' + fmt(f.rv20, y ? 0 : 1) + (y ? ' bp' : '%') + (f.exp5d != null ? ' · 5d ±' + fmt(f.exp5d, y ? 0 : dg) + (y ? ' bp' : '') : '') + ' · ' + reg(f.regime);
      }
      if (f.z != null && Math.abs(f.z) >= 2) dd += ' · <b class="dn">' + sg(f.z) + fmt(f.z, 1) + 'σ</b>';
      h += cell('/vol.html', f.label.replace(/\s*\(.*\)$/, ''), b, dd, regCls(f.regime), f.label + ' · ' + f.source + (f.stale ? ' · stale' : ''));
    });
    if (d.alerts && d.alerts.length) {
      var a = d.alerts[0];
      h += cell('/vol.html', 'Largest move', esc(a.label.replace(/\s*\(.*\)$/, '')), sg(a.z) + fmt(a.z, 1) + 'σ' + (d.alerts.length > 1 ? ' · ' + (d.alerts.length - 1) + ' more' : ''), 'dn');
    }
    if ((!d.focus || !d.focus.length) && !(d.extras || []).length) h += '<span class="ms-c"><span class="ms-k">Volatility</span><b class="dim">Warming up</b><span class="ms-d">first ingest within 10 min</span></span>';
    bar.className = '';
    bar.innerHTML = h;
  }
  function load() {
    fetch('/api/ml/strip?page=' + encodeURIComponent(page), { headers: { 'x-session': tok } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) render(d); else bar.remove(); })
      .catch(function () { });
  }
  load();
  setInterval(function () { if (!document.hidden) load(); }, 120000);
})();
