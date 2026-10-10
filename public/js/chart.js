/* CHART BUILDER (Pro)
   INIT     catalog /api/charts/series · state from ?s=<share> or ?ids=A,B&t=index&r=1y
   POLL     /api/charts/data?ids=…&range=… on every change (server caches per series)
   EVALUATE transform: level · index 100 · z-score · % change (yields: change in points) · rolling correlation
            stats per series + correlation matrix of daily changes on common days
   PUBLISH  chart · stats · heatmap · save / share link / CSV */
(function () {
  'use strict';
  if (window.GT && GT.locked) return; // free account: shell shows the Pro card
  var G = window.GT, esc = G.esc, fmt = G.fmt, $ = function (s) { return document.getElementById(s); };
  var CLS = { commod: 'Commodities', rates: 'Treasury rates', aux: 'Macro, curve and other', fx: 'Currencies', equity: 'Stocks and ETFs', stable: 'Stablecoins', insurance: 'Insurance and CPI' };
  var PAL = ['--gold', '--blue', '--up', '--amber', '--dn', '--cyan'];
  var CAT = [], BY = {}, ST = { sel: [], t: 'index', r: '1y', win: 60, id: null, share: null }, DATA = null;
  var POINTY = { yield: 1, rate: 1 };
  var OPEN = { commod: 1 };

  function color(i) { return GK.css(PAL[i % PAL.length]); }
  function msg(t) { $('msg').textContent = t || ''; }
  function catalog() {
    var q = $('find').value.trim().toLowerCase(), groups = {};
    CAT.forEach(function (s) {
      if (q && (s.label + ' ' + s.id).toLowerCase().indexOf(q) < 0) return;
      (groups[s.cls] = groups[s.cls] || []).push(s);
    });
    var on = {}; ST.sel.forEach(function (s) { on[s.id] = 1; });
    // groups fold so the card stays short: open when searching, when it holds a picked series, or when the user opened it
    $('cat').innerHTML = Object.keys(CLS).filter(function (k) { return groups[k]; }).map(function (k) {
      var picked = groups[k].filter(function (s) { return on[s.id]; }).length;
      var open = q || picked || OPEN[k];
      return '<details data-g="' + k + '"' + (open ? ' open' : '') + '><summary><span>' + CLS[k] + '</span><span class="dim">' + (picked ? picked + ' picked · ' : '') + groups[k].length + '</span></summary>' + groups[k].map(function (s) {
        return '<button type="button" data-id="' + esc(s.id) + '"' + (on[s.id] ? ' class="on"' : '') + '>' + esc(s.label) + '<span>' + esc(s.unit) + '</span></button>';
      }).join('') + '</details>';
    }).join('') || '<div class="empty">No series match.</div>';
  }
  function chips() {
    $('sel').innerHTML = ST.sel.length ? ST.sel.map(function (s, i) {
      return '<span><i style="background:' + color(i) + '"></i>' + esc((BY[s.id] || {}).label || s.id) + '<button type="button" data-rm="' + esc(s.id) + '" aria-label="Remove">×</button></span>';
    }).join('') : '<span class="dim" style="background:none;padding-left:0">Pick up to 6 series from the list.</span>';
  }

  /* ---------- math ---------- */
  function changes(id, pts) { var k = (BY[id] || {}).kind, o = []; for (var i = 1; i < pts.length; i++) { var a = pts[i - 1][1], b = pts[i][1]; o.push([pts[i][0], POINTY[k] || k === 'cpi' ? b - a : (a > 0 && b > 0 ? Math.log(b / a) : null)]); } return o; }
  function corr(a, b) { var n = a.length; if (n < 10) return null; var sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0; for (var i = 0; i < n; i++) { sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i]; } var c = sab / n - sa / n * sb / n, va = saa / n - Math.pow(sa / n, 2), vb = sbb / n - Math.pow(sb / n, 2); return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : null; }
  function common(ca, cb) { var m = {}; cb.forEach(function (p) { if (p[1] != null) m[p[0]] = p[1]; }); var A = [], B = [], T = []; ca.forEach(function (p) { if (p[1] != null && m[p[0]] != null) { A.push(p[1]); B.push(m[p[0]]); T.push(p[0]); } }); return { a: A, b: B, t: T }; }
  function transform(id, pts) {
    var k = (BY[id] || {}).kind;
    if (!pts.length) return [];
    if (ST.t === 'level') return pts.map(function (p) { return { x: p[0], y: p[1] }; });
    var v0 = pts[0][1];
    if (ST.t === 'z') { var m = 0; pts.forEach(function (p) { m += p[1]; }); m /= pts.length; var sd = 0; pts.forEach(function (p) { sd += Math.pow(p[1] - m, 2); }); sd = Math.sqrt(sd / Math.max(1, pts.length - 1)) || 1; return pts.map(function (p) { return { x: p[0], y: (p[1] - m) / sd }; }); }
    if (POINTY[k] || v0 <= 0) return pts.map(function (p) { return { x: p[0], y: ST.t === 'index' ? 100 + (p[1] - v0) : p[1] - v0 }; });
    return pts.map(function (p) { return { x: p[0], y: ST.t === 'index' ? 100 * p[1] / v0 : 100 * (p[1] / v0 - 1) }; });
  }

  function draw() {
    if (!DATA) { GK.line($('cv'), $('tp'), { series: [], empty: 'Pick a series to start' }); return; }
    var series = [], what = '';
    if (ST.t === 'corr') {
      if (ST.sel.length < 2) { GK.line($('cv'), $('tp'), { series: [], empty: 'Rolling correlation needs two or more series' }); $('what').textContent = 'The first series is compared with each of the others.'; return; }
      var base = changes(ST.sel[0].id, DATA.data[ST.sel[0].id] || []);
      ST.sel.slice(1).forEach(function (s, j) {
        var c = common(base, changes(s.id, DATA.data[s.id] || [])), out = [];
        for (var i = ST.win; i <= c.a.length; i++) { var r = corr(c.a.slice(i - ST.win, i), c.b.slice(i - ST.win, i)); if (r != null) out.push({ x: c.t[i - 1], y: r }); }
        series.push({ name: (BY[ST.sel[0].id] || {}).label + ' vs ' + (BY[s.id] || {}).label, pts: out, color: color(j + 1) });
      });
      GK.line($('cv'), $('tp'), { series: series, refs: [{ y: 0, color: GK.css('--mut') }], yMin: -1, yMax: 1, yFmt: function (x) { return fmt(x, 2); }, empty: 'Not enough common days for this window' });
      what = ST.win + '-day correlation of daily changes, ' + (BY[ST.sel[0].id] || {}).label + ' against each other series. +1 moves together, −1 opposite, 0 unrelated.';
    } else {
      ST.sel.forEach(function (s, i) { series.push({ name: (BY[s.id] || {}).label || s.id, pts: transform(s.id, DATA.data[s.id] || []), color: color(i), width: i ? 1.8 : 2.4 }); });
      var anyPt = ST.sel.some(function (s) { return POINTY[(BY[s.id] || {}).kind]; });
      var yf = ST.t === 'pct' ? function (x) { return (x >= 0 ? '+' : '') + fmt(x, 1) + (anyPt ? '' : '%'); } : ST.t === 'z' ? function (x) { return fmt(x, 1) + 'σ'; } : function (x) { return fmt(x, Math.abs(x) < 10 ? 2 : 0); };
      GK.line($('cv'), $('tp'), { series: series, refs: ST.t === 'index' ? [{ y: 100, color: GK.css('--mut') }] : ST.t === 'pct' || ST.t === 'z' ? [{ y: 0, color: GK.css('--mut') }] : [], yFmt: yf, empty: 'No stored data in this range' });
      what = ST.t === 'index' ? 'Every line starts at 100, so you compare moves, not price levels.' : ST.t === 'z' ? 'Each line in standard deviations from its own average over the range: 0 is normal, ±2 is unusual.' : ST.t === 'pct' ? 'Change since the start of the range.' : 'Raw levels on one axis; mixed units can hide small series. Try Index or Z-score.';
      if (anyPt && ST.t !== 'level' && ST.t !== 'z') what += ' Yields and rates show the change in percentage points (index: 100 + change).';
    }
    $('what').textContent = what;
    stats();
  }
  function stats() {
    var rows = ST.sel.map(function (s, i) {
      var p = DATA.data[s.id] || [], b = BY[s.id] || {};
      if (p.length < 2) return '<tr><td><i class="dotc" style="background:' + color(i) + '"></i>' + esc(b.label || s.id) + '</td><td colspan="5" class="dim">No data in range</td></tr>';
      var a = p[0][1], z = p[p.length - 1][1], lo = Infinity, hi = -Infinity; p.forEach(function (x) { lo = Math.min(lo, x[1]); hi = Math.max(hi, x[1]); });
      var ch = changes(s.id, p).map(function (x) { return x[1]; }).filter(function (x) { return x != null; });
      var m = ch.reduce(function (q, x) { return q + x; }, 0) / ch.length, sd = Math.sqrt(ch.reduce(function (q, x) { return q + Math.pow(x - m, 2); }, 0) / Math.max(1, ch.length - 1));
      var ann = b.freq === 'monthly' ? 12 : 252, pt = POINTY[b.kind];
      return '<tr><td><i class="dotc" style="background:' + color(i) + '"></i>' + esc(b.label || s.id) + '</td><td class="r">' + fmt(z, Math.abs(z) < 10 ? 3 : 2) + '</td>' +
        '<td class="r ' + G.cls(z - a) + '">' + (pt ? (z - a >= 0 ? '+' : '') + fmt(z - a, 2) + ' pts' : (a > 0 ? (z >= a ? '+' : '') + fmt(100 * (z / a - 1), 1) + '%' : '–')) + '</td>' +
        '<td class="r mut">' + fmt(lo, 2) + '</td><td class="r mut">' + fmt(hi, 2) + '</td><td class="r mut">' + (pt ? fmt(sd * Math.sqrt(ann) * 100, 0) + ' bp' : fmt(sd * Math.sqrt(ann) * 100, 1) + '%') + '</td></tr>';
    }).join('');
    $('stats').innerHTML = '<thead><tr><th>Series</th><th class="r">Last</th><th class="r">Change</th><th class="r">Low</th><th class="r">High</th><th class="r">Vol, yearly</th></tr></thead><tbody>' + rows + '</tbody>';
    var labs = ST.sel.map(function (s) { return s.id.length > 7 ? s.id.slice(0, 7) : s.id; });
    var ch = ST.sel.map(function (s) { return changes(s.id, DATA.data[s.id] || []); });
    var M = ch.map(function (a, i) { return ch.map(function (b, j) { if (i === j) return 1; var c = common(a, b); return corr(c.a, c.b); }); });
    $('heat').parentNode.style.display = ST.sel.length >= 2 ? '' : 'none';
    if (ST.sel.length >= 2) GK.heat($('heat'), labs, M);
  }

  function url() {
    var q = ST.share ? '?s=' + ST.share : (ST.sel.length ? '?ids=' + ST.sel.map(function (s) { return s.id; }).join(',') + '&t=' + ST.t + '&r=' + ST.r : '');
    try { history.replaceState(null, '', '/chart.html' + q); } catch (e) { }
  }
  function load() {
    $('winL').classList.toggle('hide', ST.t !== 'corr');
    chips(); catalog(); url();
    if (!ST.sel.length) { DATA = null; draw(); $('stats').innerHTML = ''; return; }
    msg('Loading…');
    G.getJSON('/api/charts/data?ids=' + ST.sel.map(function (s) { return s.id; }).join(',') + '&range=' + ST.r).then(function (d) { DATA = d; msg(''); draw(); })
      .catch(function (e) { msg('Could not load the data (' + e.message + ').'); });
  }
  function setT(t) { ST.t = t; Array.prototype.forEach.call(document.querySelectorAll('#tf button'), function (b) { b.classList.toggle('on', b.dataset.t === t); }); }
  function setR(r) { ST.r = r; Array.prototype.forEach.call(document.querySelectorAll('#rg button'), function (b) { b.classList.toggle('on', b.dataset.r === r); }); }
  function apply(spec, name) {
    ST.sel = (spec.series || []).filter(function (s) { return BY[s.id]; }).slice(0, 6);
    setT(spec.transform || 'index'); setR(spec.range || '1y'); ST.win = spec.win || 60; $('win').value = String(ST.win);
    if (name != null) { $('name').value = name; $('ctitle').textContent = name || 'Your chart'; }
    load();
  }

  $('cat').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-id]'); if (!b) return;
    var id = b.dataset.id, i = ST.sel.findIndex(function (s) { return s.id === id; });
    if (i >= 0) ST.sel.splice(i, 1); else { if (ST.sel.length >= 6) { msg('Six series at most.'); return; } ST.sel.push({ id: id }); }
    ST.share = null; load();
  });
  $('sel').addEventListener('click', function (e) { var b = e.target.closest('[data-rm]'); if (!b) return; ST.sel = ST.sel.filter(function (s) { return s.id !== b.dataset.rm; }); ST.share = null; load(); });
  $('find').addEventListener('input', catalog);
  $('cat').addEventListener('toggle', function (e) { var d = e.target; if (d.dataset && d.dataset.g && !$('find').value) OPEN[d.dataset.g] = d.open; }, true);
  $('tf').addEventListener('click', function (e) { var b = e.target.closest('button[data-t]'); if (!b) return; setT(b.dataset.t); ST.share = null; $('winL').classList.toggle('hide', ST.t !== 'corr'); url(); draw(); });
  $('rg').addEventListener('click', function (e) { var b = e.target.closest('button[data-r]'); if (!b) return; setR(b.dataset.r); ST.share = null; load(); });
  $('win').addEventListener('change', function () { ST.win = +this.value; draw(); });

  function spec() { return { series: ST.sel.map(function (s) { return { id: s.id }; }), transform: ST.t, range: ST.r, win: ST.win }; }
  function post(u, b) { return fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(function (r) { return r.json(); }); }
  function save() {
    if (!ST.sel.length) { msg('Pick a series first.'); return Promise.reject(); }
    return post('/api/charts', { id: ST.id, name: $('name').value, spec: spec() }).then(function (r) {
      if (!r.ok) { msg(r.error || 'Save failed.'); throw new Error('save'); }
      ST.id = r.id; ST.share = r.share; msg('Saved.'); url(); saved(); return r;
    });
  }
  $('save').addEventListener('click', function () { save().catch(function () { }); });
  $('share').addEventListener('click', function () {
    save().then(function (r) {
      var link = location.origin + '/chart.html?s=' + r.share;
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { msg('Saved. Share link copied: ' + link); }, function () { msg('Saved. Share link: ' + link); });
    }).catch(function () { });
  });
  $('csv').addEventListener('click', function () {
    if (!DATA || !ST.sel.length) { msg('Nothing to export yet.'); return; }
    var dates = {}; ST.sel.forEach(function (s) { (DATA.data[s.id] || []).forEach(function (p) { (dates[p[0]] = dates[p[0]] || {})[s.id] = p[1]; }); });
    var head = ['date'].concat(ST.sel.map(function (s) { return s.id; }));
    var lines = [head.join(',')].concat(Object.keys(dates).map(Number).sort(function (a, b) { return a - b; }).map(function (t) { return [new Date(t).toISOString().slice(0, 10)].concat(ST.sel.map(function (s) { var v = dates[t][s.id]; return v == null ? '' : v; })).join(','); }));
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = ($('name').value || 'chart').replace(/[^\w-]+/g, '_') + '.csv'; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  var SAVED = [];
  function saved() {
    G.getJSON('/api/charts').then(function (d) {
      SAVED = d.charts || [];
      $('saved').innerHTML = SAVED.length ? SAVED.map(function (c) {
        return '<div><span><a data-open="' + c.id + '">' + esc(c.name) + '</a><small>' + esc(c.spec.series.map(function (s) { return s.id; }).join(', ')) + ' · ' + esc(c.spec.transform) + ' · ' + esc(c.spec.range) + ' · ' + G.ago(c.updated) + '</small></span><button class="btn ghost sm" data-del="' + c.id + '" type="button">Delete</button></div>';
      }).join('') : '<div class="empty">Saved charts appear here. They are private until you share the link.</div>';
    }).catch(function () { $('saved').innerHTML = '<div class="empty">Could not load saved charts.</div>'; });
  }
  $('saved').addEventListener('click', function (e) {
    var o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]');
    if (o) { var c = SAVED.filter(function (x) { return x.id === +o.dataset.open; })[0]; if (c) { ST.id = c.id; ST.share = c.share; apply(c.spec, c.name); } }
    if (d && confirm('Delete this chart? Its share link stops working.')) post('/api/charts/delete', { id: +d.dataset.del }).then(function () { if (ST.id === +d.dataset.del) { ST.id = null; ST.share = null; } saved(); });
  });

  G.getJSON('/api/charts/series').then(function (d) {
    CAT = d.series || []; CAT.forEach(function (s) { BY[s.id] = s; });
    $('catN').textContent = CAT.length + ' series with data';
    var q = new URLSearchParams(location.search);
    if (q.get('s')) {
      G.getJSON('/api/charts/shared?s=' + encodeURIComponent(q.get('s'))).then(function (c) { ST.share = q.get('s'); apply(c.spec, c.name); msg('Shared chart. Saving makes your own copy.'); })
        .catch(function () { msg('That share link is no longer valid.'); apply({ series: [{ id: 'GOLD' }, { id: 'DXY' }] }); });
    } else if (q.get('ids')) apply({ series: q.get('ids').split(',').map(function (id) { return { id: id.toUpperCase() }; }), transform: q.get('t'), range: q.get('r') });
    else apply({ series: [{ id: 'GOLD' }, { id: 'TIPS10Y' }, { id: 'DXY' }], transform: 'z', range: '2y' }, '');
    saved();
  }).catch(function () { $('cat').innerHTML = '<div class="empty">The series list is unavailable right now.</div>'; });
})();
