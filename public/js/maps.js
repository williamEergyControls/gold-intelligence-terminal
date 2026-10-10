/* ================================================================
   MAPS — lightweight SVG maps, no library.
   USMap.draw(el, opts)    states from /geo/us-states.json (albers usa, 975×610)
   WorldMap.draw(el, opts) land from /geo/world.json (natural earth 1, 1000×500)
   projections are the d3 formulas (checked against d3-geo to 0.1 px),
   so live lat/lon points (river gauges, ports, straits) land in the right place.
   ================================================================ */
(function () {
  'use strict';
  var R = Math.PI / 180;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var cache = {};
  function getGeo(u) { return cache[u] || (cache[u] = fetch(u).then(function (r) { if (!r.ok) throw new Error('geo ' + r.status); return r.json(); })); }

  /* ---- albers usa (lower 48 branch) ---- */
  var y0 = 29.5 * R, y1 = 45.5 * R, sy0 = Math.sin(y0), n = (sy0 + Math.sin(y1)) / 2, c = 1 + sy0 * (2 * n - sy0), r0 = Math.sqrt(c) / n;
  function cea(l, p) { var r = Math.sqrt(c - 2 * n * Math.sin(p)) / n; return [r * Math.sin(l * n), r0 - r * Math.cos(l * n)]; }
  var C0 = cea(-0.6 * R, 38.7 * R);
  function albers(lon, lat) { var q = cea((lon + 96) * R, lat * R); return [487.5 + 1300 * (q[0] - C0[0]), 305 - 1300 * (q[1] - C0[1])]; }

  /* ---- natural earth 1 ---- */
  function ne(w, lon, lat) {
    var l = lon * R, p = lat * R, p2 = p * p, p4 = p2 * p2;
    var x = l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
    var y = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
    return [w.tx + w.k * x, w.ty - w.k * y];
  }

  /* ---- color ramps ---- */
  function hex(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function ramp(stops) { // stops: [[t, '#hex'], ...] t in 0..1
    var s = stops.map(function (x) { return [x[0], hex(x[1])]; });
    return function (t) {
      t = Math.max(0, Math.min(1, t));
      for (var i = 1; i < s.length; i++) if (t <= s[i][0]) {
        var a = s[i - 1], b = s[i], u = (t - a[0]) / ((b[0] - a[0]) || 1);
        return 'rgb(' + [0, 1, 2].map(function (k) { return Math.round(a[1][k] + (b[1][k] - a[1][k]) * u); }).join(',') + ')';
      }
      var l = s[s.length - 1][1]; return 'rgb(' + l.join(',') + ')';
    };
  }
  function rampCss(stops) { return 'linear-gradient(90deg,' + stops.map(function (x) { return x[1] + ' ' + Math.round(x[0] * 100) + '%'; }).join(',') + ')'; }

  /* ---- shared tooltip ---- */
  function tipper(box) {
    var tip = document.createElement('div'); tip.className = 'maptip'; box.appendChild(tip);
    var html = {};
    function show(ev, key) {
      var h = html[key]; if (!h) { tip.style.display = 'none'; return; }
      tip.innerHTML = h; tip.style.display = 'block';
      var b = box.getBoundingClientRect(), x = ev.clientX - b.left, y = ev.clientY - b.top;
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = Math.max(4, Math.min(b.width - tw - 4, x + 14)) + 'px';
      tip.style.top = Math.max(4, y - th - 12 < 0 ? y + 16 : y - th - 12) + 'px';
    }
    box.addEventListener('mousemove', function (e) { var t = e.target.closest('[data-tip]'); if (t) show(e, t.getAttribute('data-tip')); else tip.style.display = 'none'; });
    box.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
    box.addEventListener('click', function (e) { var t = e.target.closest('[data-tip]'); if (t) show(e, t.getAttribute('data-tip')); });
    return { set: function (k, h) { html[k] = h; } };
  }

  var SMALL = { DC: 1, RI: 1, DE: 1, CT: 1, NJ: 1, MD: 1, MA: 1, VT: 1, NH: 1 };
  function usDraw(el, o) {
    o = o || {};
    return getGeo('/geo/us-states.json').then(function (g) {
      var box = document.createElement('div'); box.className = 'mapbox';
      var s = '<svg viewBox="0 0 ' + g.w + ' ' + g.h + '" role="img" aria-label="' + esc(o.title || 'United States map') + '"><g>';
      var tips = [];
      g.states.forEach(function (st) {
        var v = o.values ? o.values[st.a] : null;
        var fill = v == null ? 'var(--panel2)' : o.color(v, st.a);
        s += '<path class="st" d="' + st.d + '" fill="' + fill + '" data-tip="s' + st.a + '"></path>';
        tips.push(['s' + st.a, o.tip ? o.tip(st.a, st.n, v) : '<b>' + esc(st.n) + '</b>']);
      });
      s += '</g>';
      if (o.labels !== false) {
        s += '<g aria-hidden="true">';
        g.states.forEach(function (st) {
          if (SMALL[st.a]) return;
          var t = o.labelText ? o.labelText(st.a, o.values ? o.values[st.a] : null) : st.a;
          s += '<text class="lbl" x="' + st.c[0] + '" y="' + (st.c[1] + 3) + '" text-anchor="middle">' + esc(t) + '</text>';
        });
        s += '</g>';
      }
      (o.points || []).forEach(function (p, i) {
        if (p.lat == null || p.lon == null) return;
        var xy = albers(p.lon, p.lat);
        s += '<circle class="pt" cx="' + xy[0].toFixed(1) + '" cy="' + xy[1].toFixed(1) + '" r="' + (p.r || 6) + '" fill="' + (p.fill || 'var(--blue)') + '" data-tip="p' + i + '"></circle>';
        tips.push(['p' + i, p.html || '']);
      });
      s += '</svg>';
      box.innerHTML = s;
      el.innerHTML = '';
      el.appendChild(box);
      var tp = tipper(box); tips.forEach(function (t) { tp.set(t[0], t[1]); });
      if (o.legend) { var lg = document.createElement('div'); lg.className = 'legend'; lg.innerHTML = o.legend; el.appendChild(lg); }
      return box;
    });
  }

  function worldDraw(el, o) {
    o = o || {};
    return getGeo('/geo/world.json').then(function (w) {
      var box = document.createElement('div'); box.className = 'mapbox';
      var s = '<svg viewBox="0 0 ' + w.w + ' ' + w.h + '" role="img" aria-label="' + esc(o.title || 'World map') + '">' +
        '<path class="land" d="' + w.land + '"></path><path class="bord" d="' + w.borders + '"></path>';
      var tips = [];
      (o.routes || []).forEach(function (rt, i) {
        // split where the path crosses the antimeridian so the line wraps instead of crossing the map
        var segs = [[]], prev = null;
        rt.pts.forEach(function (ll) {
          if (prev && Math.abs(ll[0] - prev[0]) > 180) {
            var lonA = prev[0] > 0 ? 180 : -180, lonB = -lonA;
            var t = (lonA - prev[0]) / ((ll[0] + (prev[0] > 0 ? 360 : -360)) - prev[0]);
            var latX = prev[1] + (ll[1] - prev[1]) * t;
            segs[segs.length - 1].push(ne(w, lonA - Math.sign(lonA) * 0.01, latX));
            segs.push([ne(w, lonB - Math.sign(lonB) * 0.01, latX)]);
          }
          segs[segs.length - 1].push(ne(w, ll[0], ll[1]));
          prev = ll;
        });
        segs.forEach(function (sg) {
          if (sg.length < 2) return;
          var d = 'M' + sg.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join('L');
          var fl = o.flow !== false && rt.flow !== false;
          s += '<path class="route' + (fl ? ' flow' : '') + '" d="' + d + '" style="stroke:' + (rt.color || 'var(--blue)') + ';stroke-width:' + (rt.width || 1.8) +
            (rt.dash ? ';stroke-dasharray:' + rt.dash + ';animation:none' : '') + (rt.opacity ? ';opacity:' + rt.opacity : '') + '" data-tip="r' + i + '"></path>';
        });
        tips.push(['r' + i, rt.html || esc(rt.label || '')]);
        if (rt.label && rt.at) {
          var lp = ne(w, rt.at[0], rt.at[1]);
          s += '<text class="lbl" x="' + lp[0].toFixed(1) + '" y="' + lp[1].toFixed(1) + '" text-anchor="middle" style="font-size:11px">' + esc(rt.label) + '</text>';
        }
      });
      (o.points || []).forEach(function (p, i) {
        var xy = ne(w, p.lon, p.lat);
        if (p.ring) s += '<circle class="ring" cx="' + xy[0].toFixed(1) + '" cy="' + xy[1].toFixed(1) + '" r="' + ((p.r || 5) + 4) + '" style="stroke:' + (p.fill || 'var(--blue)') + '"></circle>';
        s += '<circle class="pt" cx="' + xy[0].toFixed(1) + '" cy="' + xy[1].toFixed(1) + '" r="' + (p.r || 5) + '" fill="' + (p.fill || 'var(--blue)') + '"' + (p.opacity ? ' fill-opacity="' + p.opacity + '"' : '') + ' data-tip="p' + i + '"></circle>';
        if (p.label) s += '<text class="lbl" x="' + (xy[0] + (p.r || 5) + 4).toFixed(1) + '" y="' + (xy[1] + 3.5).toFixed(1) + '" style="font-size:10.5px">' + esc(p.label) + '</text>';
        tips.push(['p' + i, p.html || '']);
      });
      s += '</svg>';
      box.innerHTML = s;
      el.innerHTML = '';
      el.appendChild(box);
      var tp = tipper(box); tips.forEach(function (t) { tp.set(t[0], t[1]); });
      if (o.legend) { var lg = document.createElement('div'); lg.className = 'legend'; lg.innerHTML = o.legend; el.appendChild(lg); }
      return box;
    });
  }

  function spark(vals, w, h, color) {
    if (!vals || vals.length < 2) return '';
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), rg = (hi - lo) || 1;
    var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + (i * (w - 2) / (vals.length - 1) + 1).toFixed(1) + ',' + (h - 2 - (v - lo) / rg * (h - 4)).toFixed(1); }).join('');
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="display:block;margin-top:6px"><path d="' + d + '" fill="none" stroke="' + (color || 'currentColor') + '" stroke-width="1.6" stroke-linejoin="round"></path></svg>';
  }

  /* ---- energy infrastructure layers (/geo/energy.json, reference data) ----
     layers: { crude, gas, products, refineries, lng } booleans → { routes, points, legend } for WorldMap.draw */
  var EK = { crude: 'var(--amber)', gas: 'var(--blue)', products: 'var(--cyan)', refinery: 'var(--mut)', lng: 'var(--up)', off: 'var(--dn)', plan: 'var(--dim)' };
  var ST = { operating: 'Operating', reduced: 'Reduced flows', offline: 'Offline', construction: 'Under construction', planned: 'Planned' };
  function energyLayers(g, L) {
    var routes = [], points = [];
    (g.pipelines || []).forEach(function (p) {
      if (!L[p.kind]) return;
      var col = p.status === 'offline' ? EK.off : (p.status === 'planned' || p.status === 'construction') ? EK.plan : EK[p.kind];
      var dash = p.status === 'offline' ? '5 4' : (p.status === 'planned' || p.status === 'construction') ? '2 4' : p.status === 'reduced' ? '8 3' : null;
      var html = '<b>' + esc(p.name) + '</b> <span class="m">' + esc(p.kind === 'products' ? 'refined products' : p.kind) + ' pipeline</span><div class="m">' + esc(ST[p.status] || p.status) + ' · ' + esc(p.cap) + '<br>' + esc(p.note || '') + '</div>';
      [p.pts].concat(p.branch ? [p.branch] : []).forEach(function (pts) { routes.push({ pts: pts, color: col, width: p.kind === 'gas' ? 1.7 : 2, dash: dash, flow: false, html: html }); });
    });
    if (L.refineries) (g.refineries || []).forEach(function (r) {
      points.push({ lon: r.lon, lat: r.lat, r: 2.5 + 5 * Math.sqrt(r.kbd / 1400), fill: EK.refinery, opacity: 0.9,
        html: '<b>' + esc(r.name) + '</b> <span class="m">' + esc(r.country) + '</span><div class="m">Refinery · ' + esc(r.owner) + '<br>About ' + r.kbd.toLocaleString() + ' thousand barrels a day' + (r.note ? '<br>' + esc(r.note) : '') + '</div>' });
    });
    if (L.lng) (g.lng || []).forEach(function (x) {
      points.push({ lon: x.lon, lat: x.lat, r: 2.5 + 4 * Math.sqrt(x.mtpa / 77), fill: EK.lng, opacity: 0.9,
        html: '<b>' + esc(x.name) + '</b> <span class="m">' + esc(x.country) + '</span><div class="m">LNG export terminal · about ' + x.mtpa + ' million tonnes a year</div>' });
    });
    var sw = function (c, t, dash) { return '<span class="sw"><i style="background:' + (dash ? 'repeating-linear-gradient(90deg,' + c + ' 0 5px,transparent 5px 9px)' : c) + ';height:3px;border-radius:2px"></i>' + t + '</span>'; };
    var dot = function (c, t) { return '<span class="sw"><i style="background:' + c + ';border-radius:50%"></i>' + t + '</span>'; };
    var lg = (L.crude ? sw(EK.crude, 'Crude pipeline') : '') + (L.gas ? sw(EK.gas, 'Gas pipeline') : '') + (L.products ? sw(EK.products, 'Products pipeline') : '') +
      sw(EK.off, 'Offline', true) + sw(EK.plan, 'Planned or under construction', true) +
      (L.refineries ? dot(EK.refinery, 'Refinery, size = capacity') : '') + (L.lng ? dot(EK.lng, 'LNG export') : '');
    return { routes: routes, points: points, legend: lg };
  }
  var energyGeo = function () { return getGeo('/geo/energy.json'); };

  window.USMap = { draw: usDraw, project: albers };
  window.WorldMap = { draw: worldDraw };
  window.MapKit = { ramp: ramp, rampCss: rampCss, spark: spark, esc: esc, energyLayers: energyLayers, energyGeo: energyGeo };
  // drought ramp shared by water, agri and home: 0% → neutral, then tan → orange → deep red
  window.MapKit.DROUGHT = [[0, '#f3e3b5'], [0.15, '#f6c66b'], [0.4, '#ee8a2b'], [0.7, '#d0451b'], [1, '#7a1a08']];
})();
