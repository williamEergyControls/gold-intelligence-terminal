/* SHIPPING DESK
   INIT    /api/page/shipping (KV 15 min; PortWatch daily, Drewry weekly, marine hourly)
   POLL    every 10 min while visible
   EVALUATE transit change vs 28-day average → point color, ships/day → point size
   PUBLISH kpi strip, world map (chokepoints, ports, priced container lanes), tables, news */
(function () {
  'use strict';
  var G = window.GT, $ = function (s) { return document.querySelector(s); };
  var fmt = G.fmt, esc = G.esc, sgn = G.sgn;
  var D = null, LAYER = 'all';
  // indicative sailing paths [lon, lat]; Asia–Europe drawn via Suez, the rate is the same either way
  var SHA = [121.8, 31.2];
  var SUEZ = [SHA, [118, 21], [109, 10], [104.2, 1.3], [95, 6], [80, 6], [60, 13], [45, 12.3], [43.4, 12.6], [38, 20], [33.6, 27.8], [32.6, 29.9], [32.3, 31.3]];
  var LANES = {
    'SHA-LAX': { pts: [SHA, [142, 34], [170, 40], [-170, 41], [-140, 38], [-118.3, 33.7]], at: [-160, 43] },
    'SHA-NYC': { pts: [SHA, [140, 28], [170, 22], [-150, 15], [-110, 10], [-79.6, 8.9], [-78.5, 12], [-74.5, 19.8], [-72, 30], [-74, 40.5]], at: [-130, 16] },
    'SHA-GOA': { pts: SUEZ.concat([[25, 34], [15, 37.6], [11, 40.5], [8.9, 44.4]]), at: [70, 7] },
    'SHA-RTM': { pts: SUEZ.concat([[20, 34.5], [10, 37.6], [-5.6, 35.9], [-10, 38], [-9.6, 43.5], [-5, 48.6], [1.4, 50.6], [4.1, 51.9]]), at: [-14, 46] }
  };
  function pc(v, d) { return v == null ? '–' : sgn(v) + fmt(v, d == null ? 1 : d) + '%'; }
  function tone(v) { return v == null ? 'var(--dim)' : v <= -10 ? 'var(--dn)' : v < -3 ? 'var(--amber)' : v >= 3 ? 'var(--up)' : 'var(--blue)'; }

  function kpis() {
    var w = D.wci, idx = D.indices || [], ch = D.chokepoints || [];
    var tot = 0, prev = 0;
    ch.forEach(function (c) { if (c.avg7 != null && c.prev28 != null) { tot += c.avg7; prev += c.prev28; } });
    var h = '';
    if (w) h += '<div class="kpi"><label>Drewry container index</label><b>$' + fmt(w.composite, 0) + '</b><small class="' + G.cls(w.chgPct) + '">' + pc(w.chgPct, 0) + ' week · per 40 ft · ' + esc(w.asOf) + '</small></div>';
    idx.forEach(function (i) { h += '<div class="kpi"><label>' + esc(i.label) + '</label><b>' + fmt(i.value, 0) + '</b><small>' + esc(i.unit) + ' · ' + esc(i.asOf) + ' · reference</small></div>'; });
    if (prev) { var c = (tot / prev - 1) * 100; h += '<div class="kpi"><label>Chokepoint traffic</label><b>' + fmt(tot, 0) + '</b><small class="' + G.cls(c) + '">ships a day, 7-day average · ' + pc(c) + ' vs 28-day</small></div>'; }
    var hot = ch.filter(function (c) { return c.chgPct != null; }).sort(function (a, b) { return a.chgPct - b.chgPct; })[0];
    if (hot) h += '<div class="kpi"><label>Biggest slowdown</label><b>' + esc(hot.name) + '</b><small class="dn">' + pc(hot.chgPct) + ' vs 28-day</small></div>';
    $('#sh-kpis').innerHTML = h;
  }

  function map() {
    if (!window.WorldMap) return;
    var ch = D.chokepoints || [], ports = D.ports || [], pts = [], routes = [];
    var maxT = Math.max.apply(null, ch.map(function (c) { return c.avg7 || 0; }).concat([1]));
    if (LAYER === 'all' || LAYER === 'ports') ports.forEach(function (p) {
      pts.push({ lon: p.lon, lat: p.lat, r: 3.2, fill: 'var(--dim)', opacity: 0.85,
        html: '<b>' + esc(p.name) + '</b> <span class="m">' + esc(p.country) + '</span><div class="m">' + (p.calls7 != null ? fmt(p.calls7, 0) + ' port calls in 7 days' : 'No recent count') + (p.chgPct != null ? '<br>' + pc(p.chgPct) + ' vs 28-day pace' : '') + '</div>' });
    });
    if (LAYER === 'all' || LAYER === 'choke') ch.forEach(function (c) {
      var r = 4 + 9 * Math.sqrt((c.avg7 || 0) / maxT);
      pts.push({ lon: c.lon, lat: c.lat, r: r, fill: tone(c.chgPct), ring: c.chgPct != null && c.chgPct <= -10, label: c.major ? c.name : null,
        html: '<b>' + esc(c.name) + '</b><div class="m">' + (c.avg7 != null ? fmt(c.avg7, 1) + ' ships a day (7-day avg)' : 'No recent data') +
          (c.chgPct != null ? '<br>' + pc(c.chgPct) + ' vs 28-day average' : '') +
          (c.tanker != null ? '<br>Tankers ' + fmt(c.tanker, 0) + ' · containers ' + fmt(c.container, 0) + ' · dry bulk ' + fmt(c.dryBulk, 0) : '') +
          (c.wave != null ? '<br>Waves ' + fmt(c.wave, 1) + ' m' + (c.current != null ? ' · current ' + fmt(c.current, 1) + ' kn' : '') : '') + '</div>' });
    });
    if ((LAYER === 'all' || LAYER === 'lanes') && D.wci) D.wci.lanes.forEach(function (l) {
      var g = LANES[l.key]; if (!g) return;
      routes.push({ pts: g.pts, at: g.at, color: 'var(--gold)', width: 1.8, label: '$' + fmt(l.usd, 0),
        html: '<b>' + esc(l.from) + ' to ' + esc(l.to) + '</b><div class="m">$' + fmt(l.usd, 0) + ' per 40 ft container' + (l.chgPct != null ? ' · ' + pc(l.chgPct, 0) + ' this week' : '') + '<br>Drewry WCI, ' + esc(l.asOf || D.wci.asOf) + '. Route line is indicative.</div>' });
    });
    WorldMap.draw($('#mapBody'), {
      title: 'Chokepoints, ports and container lanes', points: pts, routes: routes,
      legend: '<span class="sw"><i style="background:var(--up);border-radius:50%"></i>Busier than usual</span><span class="sw"><i style="background:var(--blue);border-radius:50%"></i>Normal</span><span class="sw"><i style="background:var(--amber);border-radius:50%"></i>Slower</span><span class="sw"><i style="background:var(--dn);border-radius:50%"></i>Down 10% or more</span><span class="sw"><i style="background:var(--dim);border-radius:50%"></i>Port</span><span class="sw"><i style="background:var(--gold);height:3px;border-radius:2px"></i>Container lane, $ per 40 ft</span><span>Dot size is ships a day</span>'
    });
  }

  function tables() {
    var ch = (D.chokepoints || []).slice().sort(function (a, b) { return (b.avg7 || 0) - (a.avg7 || 0); });
    $('#chokeSrc').textContent = 'IMF PortWatch' + (D.chokeAsOf ? ', data to ' + D.chokeAsOf : '');
    $('#chokeBody').innerHTML = ch.map(function (c) {
      return '<tr><td>' + esc(c.name) + '</td><td class="r">' + (c.avg7 != null ? fmt(c.avg7, 1) : '–') + '</td><td class="r ' + (c.chgPct == null ? 'dim' : G.cls(c.chgPct)) + '">' + pc(c.chgPct) + '</td>' +
        '<td class="spk">' + MapKit.spark(c.series || [], 110, 26, 'currentColor') + '</td><td class="r mut">' + (c.wave != null ? fmt(c.wave, 1) + ' m' : '–') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="dim">PortWatch data loads with the first daily pull.</td></tr>';
    var w = D.wci;
    $('#wciSrc').textContent = w ? (w.live ? 'Drewry WCI, ' : 'Drewry WCI reference, ') + w.asOf : 'Drewry WCI';
    $('#laneBody').innerHTML = w ? w.lanes.map(function (l) {
      return '<div class="lane"><span>' + esc(l.from) + ' to ' + esc(l.to) + '<small>per 40 ft container</small></span><span class="v">$' + fmt(l.usd, 0) + '</span><span class="r ' + (l.chgPct == null ? 'dim' : G.cls(l.chgPct)) + '">' + pc(l.chgPct, 0) + '</span></div>';
    }).join('') : '<div class="empty">Rates load with the weekly Drewry note.</div>';
    $('#idxNote').textContent = (D.indices || []).map(function (i) { return i.label + ': ' + i.source; }).join(' · ');
    $('#portSrc').textContent = 'IMF PortWatch' + (D.portsAsOf ? ', data to ' + D.portsAsOf : '');
    $('#portBody').innerHTML = (D.ports || []).slice(0, 15).map(function (p) {
      return '<tr><td>' + esc(p.name) + ' <span class="dim">' + esc(p.country) + '</span></td><td class="r">' + (p.calls7 != null ? fmt(p.calls7, 0) : '–') + '</td><td class="r ' + (p.chgPct == null ? 'dim' : G.cls(p.chgPct)) + '">' + pc(p.chgPct) + '</td><td class="r mut">' + (p.import7 != null ? fmt(p.import7 / 1e6, 1) + ' Mt' : '–') + '</td><td class="r mut">' + (p.export7 != null ? fmt(p.export7 / 1e6, 1) + ' Mt' : '–') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="dim">Port data loads with the first daily pull.</td></tr>';
    $('#stockBody').innerHTML = (D.proxies || []).map(function (p) {
      return '<div><span class="n">' + esc(p.name) + '<small>' + esc(p.sym) + ' · ' + esc(p.kind) + '</small></span><span class="v">' + fmt(p.price, 2) + '</span><span class="c ' + G.cls(p.changePct) + '">' + pc(p.changePct, 2) + '</span></div>';
    }).join('') || '<div class="empty">Quotes unavailable right now.</div>';
  }

  function render() {
    if (!D) return;
    kpis(); map(); tables();
    $('#asof').textContent = D.builtAt ? 'Updated ' + G.ago(D.builtAt) : '';
  }
  $('#layers').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-l]'); if (!b) return;
    LAYER = b.dataset.l;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
    if (D) map();
  });
  function load() { G.getJSON('/api/page/shipping').then(function (d) { D = d; render(); }).catch(function () { $('#mapBody').innerHTML = '<div class="empty">Shipping data is unavailable right now. It retries every 10 minutes.</div>'; }); }
  load();
  setInterval(function () { if (!document.hidden) load(); }, 600000);
  NewsFeed.mount($('#nfBody'), { topic: 'shipping', limit: 8 });
})();
