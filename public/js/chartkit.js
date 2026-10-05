/* ================================================================
   GIT CHART KIT — shared canvas charts (vol desk, stable desk, strip)
   - line(): multi-series, one y-axis, crosshair + tooltip with every series
   - heat(): correlation matrix, diverging blue ↔ red, value printed in cell
   - spark(): inline SVG sparkline
   colors come from terminal.css tokens so day/night both work.
   ================================================================ */
(function () {
'use strict';
function css(n) { return getComputedStyle(document.body).getPropertyValue(n).trim(); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmt(n, d) { if (n == null || !isFinite(n)) return '--'; d = d == null ? 2 : d; return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
var FONT = '"Roboto Flex", Roboto, system-ui, sans-serif';
var REG = {};
function setup(cv) {
  var r = cv.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return null;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
  return { ctx: ctx, W: r.width, H: r.height };
}
var dateFmt = function (x) { var d = new Date(x); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + (d.getUTCFullYear() !== new Date().getUTCFullYear() ? '/' + String(d.getUTCFullYear()).slice(2) : ''); };

/* spec: { series:[{name, pts:[{x,y}], color, width, dash, dots}], refs:[{y,label,color,left}],
           yFmt, xFmt, yMin, yMax, empty, unit } */
function line(cv, tip, spec) {
  if (!cv) return;
  REG[cv.id] = { cv: cv, tip: tip, spec: spec, hover: null };
  draw(cv.id);
}
function draw(id) {
  var c = REG[id]; if (!c) return;
  var S = setup(c.cv); if (!S) return;
  var ctx = S.ctx, W = S.W, H = S.H, sp = c.spec;
  var grid = css('--grid'), dim = css('--dim'), mut = css('--mut');
  var all = []; sp.series.forEach(function (s) { s.pts.forEach(function (p) { if (isFinite(p.y)) all.push(p); }); });
  if (!all.length) { ctx.fillStyle = dim; ctx.font = '13px ' + FONT; ctx.textAlign = 'center'; ctx.fillText(sp.empty || 'No data yet', W / 2, H / 2); c.geo = null; return; }
  var xs = all.map(function (p) { return p.x; }), ys = all.map(function (p) { return p.y; });
  (sp.refs || []).forEach(function (r) { ys.push(r.y); });
  var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs); if (x1 === x0) { x0 -= 1; x1 += 1; }
  var y0 = sp.yMin != null ? sp.yMin : Math.min.apply(null, ys), y1 = sp.yMax != null ? sp.yMax : Math.max.apply(null, ys);
  var pad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.02 || 1; if (sp.yMin == null) y0 -= pad; if (sp.yMax == null) y1 += pad;
  var L = 58, R = 10, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
  var X = function (x) { return L + (x - x0) / (x1 - x0) * pw; }, Y = function (y) { return T + (1 - (y - y0) / (y1 - y0)) * ph; };
  ctx.font = '11px ' + FONT; ctx.lineWidth = 1;
  for (var g = 0; g <= 4; g++) {
    var yy = T + ph * g / 4, val = y1 - (y1 - y0) * g / 4;
    ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - R, yy); ctx.stroke();
    ctx.fillStyle = dim; ctx.textAlign = 'right'; ctx.fillText(sp.yFmt ? sp.yFmt(val) : fmt(val, 2), L - 5, yy + 3);
  }
  ctx.textAlign = 'center';
  for (var k = 0; k <= 4; k++) { var xv = x0 + (x1 - x0) * k / 4; ctx.fillStyle = dim; ctx.fillText((sp.xFmt || dateFmt)(xv), Math.min(W - R - 22, Math.max(L + 22, X(xv))), H - 6); }
  (sp.refs || []).forEach(function (r) {
    ctx.strokeStyle = r.color || mut; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(L, Y(r.y)); ctx.lineTo(W - R, Y(r.y)); ctx.stroke(); ctx.setLineDash([]);
    if (r.label) { ctx.fillStyle = r.color || mut; ctx.textAlign = r.left ? 'left' : 'right'; ctx.fillText(r.label, r.left ? L + 4 : W - R - 2, Y(r.y) - 3); }
  });
  sp.series.forEach(function (s) {
    var pts = s.pts.filter(function (p) { return isFinite(p.y); });
    if (pts.length > 1 && s.fill) {
      var gr = ctx.createLinearGradient(0, T, 0, T + ph); gr.addColorStop(0, s.color); gr.addColorStop(1, 'transparent');
      ctx.save(); ctx.globalAlpha = 0.14; ctx.fillStyle = gr; ctx.beginPath();
      pts.forEach(function (p, i) { if (i) ctx.lineTo(X(p.x), Y(p.y)); else ctx.moveTo(X(p.x), Y(p.y)); });
      ctx.lineTo(X(pts[pts.length - 1].x), T + ph); ctx.lineTo(X(pts[0].x), T + ph); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    if (pts.length > 1) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.lineJoin = 'round'; if (s.dash) ctx.setLineDash(s.dash);
      ctx.beginPath(); pts.forEach(function (p, i) { if (i) ctx.lineTo(X(p.x), Y(p.y)); else ctx.moveTo(X(p.x), Y(p.y)); }); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1;
    }
    if (s.dots || pts.length === 1) pts.forEach(function (p) { ctx.fillStyle = p.c || s.color; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 4, 0, Math.PI * 2); ctx.fill(); });
  });
  c.geo = { X: X, Y: Y, T: T, ph: ph, x0: x0, x1: x1, L: L, pw: pw };
  if (c.hover != null) {
    var hx = X(c.hover);
    ctx.strokeStyle = mut; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(hx, T); ctx.lineTo(hx, T + ph); ctx.stroke(); ctx.setLineDash([]);
    sp.series.forEach(function (s) { var p = nearest(s.pts, c.hover); if (p && isFinite(p.y)) { ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 5, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; } });
  }
  if (!c.cv._gk) {
    c.cv._gk = true;
    c.cv.addEventListener('mousemove', function (ev) {
      var cc = REG[id]; if (!cc || !cc.geo) return;
      var rc = cc.cv.getBoundingClientRect(), mx = ev.clientX - rc.left;
      var xv = cc.geo.x0 + (mx - cc.geo.L) / cc.geo.pw * (cc.geo.x1 - cc.geo.x0);
      var ref = nearest(cc.spec.series[0].pts.length ? cc.spec.series[0].pts : [].concat.apply([], cc.spec.series.map(function (s) { return s.pts; })), xv);
      if (!ref) return;
      cc.hover = ref.x; draw(id);
      var tp = cc.tip; if (!tp) return;
      var h = '<span class="k">' + esc((cc.spec.tipX || function (x) { return new Date(x).toISOString().slice(0, 10); })(ref.x)) + '</span>';
      cc.spec.series.forEach(function (s) { var p = nearest(s.pts, ref.x); if (p) h += '<br><i style="display:inline-block;width:8px;height:2px;background:' + s.color + ';vertical-align:3px;margin-right:5px"></i>' + esc(s.name) + ' <b>' + esc(cc.spec.yFmt ? cc.spec.yFmt(p.y) : fmt(p.y)) + '</b>'; });
      tp.innerHTML = h; tp.style.display = 'block';
      var tx = cc.geo.X(ref.x) + 12; if (tx + tp.offsetWidth > rc.width - 4) tx = cc.geo.X(ref.x) - tp.offsetWidth - 12;
      tp.style.left = Math.max(2, tx) + 'px'; tp.style.top = '8px';
    });
    c.cv.addEventListener('mouseleave', function () { var cc = REG[id]; if (!cc) return; cc.hover = null; draw(id); if (cc.tip) cc.tip.style.display = 'none'; });
  }
}
function nearest(pts, x) { var b = null, bd = Infinity; for (var i = 0; i < pts.length; i++) { var d = Math.abs(pts[i].x - x); if (d < bd) { bd = d; b = pts[i]; } } return b; }

/* correlation heatmap: labels[], m[i][j] in [-1,1] or null */
function heat(cv, labels, m) {
  if (!cv) return;
  REG[cv.id] = { cv: cv, heat: { labels: labels, m: m } };
  drawHeat(cv.id);
}
function drawHeat(id) {
  var c = REG[id]; if (!c || !c.heat) return;
  var S = setup(c.cv); if (!S) return;
  var ctx = S.ctx, W = S.W, H = S.H, lab = c.heat.labels, m = c.heat.m, n = lab.length;
  if (!n) return;
  var L = 64, T = 20, cw = (W - L - 4) / n, ch = (H - T - 4) / n;
  var neg = css('--blue'), pos = css('--dn'), mid = css('--panel3'), txt = css('--txt'), dim = css('--dim');
  ctx.font = '11px ' + FONT; ctx.textAlign = 'center';
  for (var j = 0; j < n; j++) { ctx.fillStyle = dim; ctx.fillText(lab[j], L + cw * j + cw / 2, T - 6); }
  for (var i = 0; i < n; i++) {
    ctx.fillStyle = dim; ctx.textAlign = 'right'; ctx.fillText(lab[i], L - 5, T + ch * i + ch / 2 + 3); ctx.textAlign = 'center';
    for (var k = 0; k < n; k++) {
      var v = m[i][k], x = L + cw * k, y = T + ch * i;
      ctx.fillStyle = mid; ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
      if (v != null && isFinite(v)) {
        ctx.globalAlpha = Math.min(1, Math.abs(v)) * 0.85; ctx.fillStyle = v >= 0 ? pos : neg; ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2); ctx.globalAlpha = 1;
        ctx.fillStyle = Math.abs(v) > 0.55 ? '#fff' : txt; ctx.fillText(i === k ? '1' : v.toFixed(2), x + cw / 2, y + ch / 2 + 3);
      } else { ctx.fillStyle = dim; ctx.fillText('·', x + cw / 2, y + ch / 2 + 3); }
    }
  }
}
function spark(vals, color, w, h) {
  w = w || 90; h = h || 18;
  var a = (vals || []).filter(function (v) { return isFinite(v); });
  if (a.length < 2) return '<span class="dim">--</span>';
  var lo = Math.min.apply(null, a), hi = Math.max.apply(null, a), rg = hi - lo || 1;
  var d = a.map(function (v, i) { return (i ? 'L' : 'M') + (1 + i / (a.length - 1) * (w - 4)).toFixed(1) + ' ' + (h - 2 - (v - lo) / rg * (h - 4)).toFixed(1); }).join(' ');
  var lx = (w - 3).toFixed(1), ly = (h - 2 - (a[a.length - 1] - lo) / rg * (h - 4)).toFixed(1);
  return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="display:block"><path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5"/><circle cx="' + lx + '" cy="' + ly + '" r="2" fill="' + color + '"/></svg>';
}
function redraw() { Object.keys(REG).forEach(function (k) { if (REG[k].heat) drawHeat(k); else draw(k); }); }
var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(redraw, 150); });
window.addEventListener('themechange', redraw);
window.GK = { css: css, esc: esc, fmt: fmt, line: line, heat: heat, spark: spark, redraw: redraw, dateFmt: dateFmt };
})();
