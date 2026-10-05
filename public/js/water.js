/* WATER DESK
   INIT   /api/page/agri (NQH2O + USGS gauges) and /api/drought (weekly USDM by state)
   POLL   page every 5 min (gauges are 15 min upstream), drought on load
   PUBLISH hero, drought choropleth with gauges plotted, gauge table, worst states */
(function () {
  'use strict';
  var G = window.GT, $ = function (s) { return document.querySelector(s); };
  var fmt = G.fmt, esc = G.esc, sgn = G.sgn;
  var P = null, DR = null;

  function hero() {
    var w = P && P.water ? P.water.nqH2o : null;
    if (w) {
      $('#wPx').textContent = '$' + fmt(w.value, 0);
      var ch = w.value - w.prior, el = $('#wChg');
      el.className = 'bigchg ' + G.cls(ch);
      el.textContent = sgn(ch) + fmt(ch, 0) + ' (' + sgn(ch) + fmt(w.prior ? ch / w.prior * 100 : 0, 1) + '%) vs prior print';
    } else { $('#wPx').textContent = '–'; $('#wChg').textContent = 'Index pending the first FRED pull'; }
    var kv = '<div><label>Prior print</label>' + (w ? '$' + fmt(w.prior, 0) : '–') + '</div><div><label>As of</label>' + (w ? esc(w.asOf) : '–') + '</div>';
    if (DR && DR.conus) {
      var dd = DR.conus.prevDrought != null ? DR.conus.drought - DR.conus.prevDrought : null;
      kv += '<div><label>Lower 48 in drought</label>' + fmt(DR.conus.drought, 1) + '%' + (dd != null ? ' <span class="' + (dd > 0 ? 'dn' : 'up') + '" style="font-size:13px">' + sgn(dd) + fmt(dd, 1) + '</span>' : '') + '</div>';
      kv += '<div><label>Extreme or exceptional</label>' + fmt(DR.conus.d3d4, 1) + '%</div>';
    }
    $('#wKv').innerHTML = kv;
  }

  function gauges() {
    var L = (P && P.water && P.water.levels) || [];
    $('#gBody').innerHTML = L.map(function (l) {
      var c = l.chg24;
      return '<tr><td>' + esc(l.name) + '<div class="dim" style="font-size:12px">' + (l.kind === 'reservoir' ? 'Reservoir' : 'River') + ' · USGS ' + esc(l.site) + '</div></td>' +
        '<td class="r">' + (l.gageFt != null ? fmt(l.gageFt, 2) + ' ft' : l.elevFt != null ? fmt(l.elevFt, 1) + ' ft elev' : '–') + '</td>' +
        '<td class="r">' + (l.flowCfs != null ? fmt(l.flowCfs, 0) + ' cfs' : '–') + '</td>' +
        '<td class="r ' + (c == null ? 'dim' : G.cls(c)) + '">' + (c == null ? '–' : sgn(c) + fmt(c, 2)) + '</td>' +
        '<td class="r dim">' + (l.ts ? G.ago(l.ts) : '–') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="dim">Gauges load with the first 15-minute pull.</td></tr>';
  }

  function map() {
    if (!window.USMap) return;
    var el = $('#mapBody');
    if (!DR) { el.innerHTML = '<div class="empty">The drought map loads after the first weekly pull.</div>'; return; }
    var r = MapKit.ramp(MapKit.DROUGHT), vals = {};
    Object.keys(DR.states).forEach(function (k) { vals[k] = DR.states[k].drought; });
    $('#mapSrc').textContent = 'U.S. Drought Monitor, map of ' + DR.mapDate + ' · USGS gauges';
    var pts = ((P && P.water && P.water.levels) || []).filter(function (l) { return l.lat != null && l.lon != null; }).map(function (l) {
      var c = l.chg24;
      return { lat: l.lat, lon: l.lon, r: 6, fill: c == null ? 'var(--blue)' : c >= 0 ? 'var(--blue)' : 'var(--amber)',
        html: '<b>' + esc(l.name) + '</b><div class="m">' + (l.gageFt != null ? fmt(l.gageFt, 2) + ' ft stage' : '') + (l.flowCfs != null ? ' · ' + fmt(l.flowCfs, 0) + ' cfs' : '') + (c != null ? '<br>' + sgn(c) + fmt(c, 2) + ' ft in 24 h' : '') + '</div>' };
    });
    USMap.draw(el, {
      title: 'Share of each state in drought, with river gauges', values: vals, points: pts,
      color: function (v) { return v < 0.5 ? 'var(--panel2)' : r(v / 100); },
      tip: function (a, n, v) { var s = DR.states[a]; return '<b>' + esc(n) + '</b><div class="m">' + (s ? fmt(s.drought, 1) + '% in drought<br>' + fmt(s.d3 + s.d4, 1) + '% extreme or exceptional' + (s.prevDrought != null ? '<br>' + sgn(s.drought - s.prevDrought) + fmt(s.drought - s.prevDrought, 1) + ' pts vs last week' : '') : 'No data') + '</div>'; },
      legend: '<span>0%</span><span class="ramp" style="background:' + MapKit.rampCss(MapKit.DROUGHT) + '"></span><span>100% of state in drought</span><span class="sw"><i style="background:var(--blue);border-radius:50%"></i>Gauge rising</span><span class="sw"><i style="background:var(--amber);border-radius:50%"></i>Gauge falling</span>'
    });
    var worst = Object.keys(DR.states).map(function (k) { return [k, DR.states[k]]; }).sort(function (a, b) { return b[1].drought - a[1].drought; }).slice(0, 8);
    $('#worst').innerHTML = worst.map(function (w) {
      var d = w[1].prevDrought != null ? w[1].drought - w[1].prevDrought : null;
      return '<div><span class="n">' + esc(w[0]) + '<small>' + fmt(w[1].d3 + w[1].d4, 1) + '% extreme or exceptional</small></span><span class="v">' + fmt(w[1].drought, 1) + '%</span><span class="c ' + (d == null ? 'dim' : d > 0 ? 'dn' : 'up') + '">' + (d == null ? '–' : sgn(d) + fmt(d, 1) + ' pts') + '</span></div>';
    }).join('');
  }

  function render() { hero(); gauges(); map(); $('#asof').textContent = P && P.builtAt ? 'Updated ' + G.ago(P.builtAt) : ''; }
  function loadPage() { return G.getJSON('/api/page/agri').then(function (d) { P = d; }).catch(function () { }); }
  function loadDrought() { return G.getJSON('/api/drought').then(function (d) { DR = d && d.states ? d : null; }).catch(function () { DR = null; }); }
  Promise.all([loadPage(), loadDrought()]).then(render);
  setInterval(function () { if (!document.hidden) loadPage().then(function () { hero(); gauges(); }); }, 300000);
  NewsFeed.mount($('#nfBody'), { topic: 'water', limit: 8, filters: false });
  Cal.mount($('#calBody'), { scope: 'water', compact: true });
})();
