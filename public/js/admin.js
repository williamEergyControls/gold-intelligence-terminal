/* ================================================================
   ADMIN CONSOLE — client
   cycle: INIT (token + role gate) → POLL (/api/admin/* per tab)
          → EVALUATE (status, ages, accuracy) → PUBLISH (tables + canvas)
   API tab live-probes every 120s while visible (server throttles 20s).
   ================================================================ */
(function () {
'use strict';
var $ = function (s) { return document.querySelector(s); };
var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var fmt = function (n, d) { if (n == null || !isFinite(n)) return '--'; d = d == null ? 2 : d; return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
var pct = function (v, d) { return v == null || !isFinite(v) ? '--' : (v * 100).toFixed(d == null ? 1 : d) + '%'; };
function age(ms) {
  if (ms == null || !isFinite(ms)) return '--';
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 172800) return (s / 3600).toFixed(1) + 'h';
  return Math.round(s / 86400) + 'd';
}
function ago(ts) { return ts ? age(Date.now() - ts) + ' ago' : '--'; }
function bytes(b) {
  if (b == null || !isFinite(b)) return '--';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(2) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function dt(ts) { if (!ts) return '--'; var d = new Date(ts); return d.toISOString().slice(0, 10) + ' ' + d.toTimeString().slice(0, 5); }
function css(n) { return getComputedStyle(document.body).getPropertyValue(n).trim(); }
var CHARTS = {}; // declared before the theme block — apply() redraws charts on load
function setText(sel, t) { var e = $(sel); if (e) e.textContent = t; }

/* ---------- INIT: token + fetch wrapper ---------- */
var TOKEN = '';
try { TOKEN = localStorage.getItem('git-token') || ''; } catch (e) { }
if (!TOKEN) { location.replace('/login.html'); return; }

function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'x-session': TOKEN }, opts.headers || {});
  return fetch(path, opts).then(function (r) {
    if (r.status === 401) { try { localStorage.removeItem('git-token'); } catch (e) { } location.replace('/login.html'); throw new Error('UNAUTHORIZED'); }
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (r.status === 403) { forbidden(d); throw new Error('FORBIDDEN'); }
      if (!r.ok) throw new Error((d && (d.error || d.detail)) || ('HTTP ' + r.status));
      return d;
    });
  });
}
function post(path, body) { return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); }

var shownForbidden = false;
function forbidden(d) {
  if (shownForbidden) return; shownForbidden = true;
  var name = '';
  try { name = localStorage.getItem('git-name') || 'YOUR_NAME'; } catch (e) { }
  var div = document.createElement('div');
  div.className = 'fbd';
  div.innerHTML = 'FORBIDDEN — ADMIN ROLE REQUIRED<br><span style="color:var(--mut);font-size:11px">signed in as <b>' + esc(name) + '</b> · role <b>' + esc((d && d.role) || 'operator') + '</b></span>' +
    '<pre>-- run once in Cloudflare → D1 → gold-terminal → Console:\nUPDATE users SET role = \'admin\' WHERE name = \'' + esc(name).replace(/'/g, "''") + '\';\n\n-- then reload this page (role is read on every request).</pre>' +
    '<a href="/" style="color:var(--cyan);font-size:11px">BACK TO HOME</a>';
  document.body.appendChild(div);
}

/* ---------- clock + theme ---------- */
setInterval(function () { setText('#clock', new Date().toLocaleTimeString('en-GB')); }, 1000);
setText('#clock', new Date().toLocaleTimeString('en-GB'));
(function () {
  var mode = 'auto';
  try { mode = localStorage.getItem('git-theme') || 'auto'; } catch (e) { }
  var isDay = function () { return mode === 'day' || (mode === 'auto' && matchMedia('(prefers-color-scheme: light)').matches); };
  var b = $('#themeBtn');
  var apply = function () { document.body.classList.toggle('day', isDay()); if (b) b.textContent = mode === 'auto' ? 'AUTO' : mode.toUpperCase(); redrawAll(); };
  if (b) b.addEventListener('click', function () { mode = mode === 'auto' ? 'day' : (mode === 'day' ? 'night' : 'auto'); try { localStorage.setItem('git-theme', mode); } catch (e) { } apply(); });
  apply();
})();

/* ---------- tabs ---------- */
var TAB = 'apis';
try { TAB = localStorage.getItem('git-admin-tab') || 'apis'; } catch (e) { }
function showTab(t) {
  TAB = t;
  try { localStorage.setItem('git-admin-tab', t); } catch (e) { }
  $$('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.t === t); });
  $$('.sec').forEach(function (s) { s.classList.toggle('on', s.id === 's-' + t); });
  if (t === 'ml') { if (!ML) loadML(); else redrawAll(); }
  if (t === 'db' && !DB) loadDB();
  if (t === 'users' && !USERS) loadUsers();
}
$$('#tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.t); }); });

/* =================================================================
   CANVAS CHART KIT — thin lines, recessive grid, hover tooltip
   ================================================================= */
function setupCanvas(cv) {
  var r = cv.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return null;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  return { ctx: ctx, W: r.width, H: r.height };
}
/* spec: { series:[{pts:[{x,y,c?,meta?}], color, width, dots, dash}], yMin, yMax, refs:[{y,color,label}],
           xFmt(x), yFmt(y), tip(pt) -> html, empty:'text' } */
function lineChart(id, tipId, spec) {
  CHARTS[id] = { tipId: tipId, spec: spec };
  drawChart(id);
}
function drawChart(id) {
  var c = CHARTS[id]; if (!c) return;
  var cv = document.getElementById(id); if (!cv) return;
  var S = setupCanvas(cv); if (!S) return;
  var ctx = S.ctx, W = S.W, H = S.H, spec = c.spec;
  var grid = css('--grid'), mut = css('--mut'), dim = css('--dim');
  var all = []; spec.series.forEach(function (s) { all = all.concat(s.pts); });
  if (!all.length) {
    ctx.fillStyle = dim; ctx.font = '10px "IBM Plex Mono", Consolas, monospace'; ctx.textAlign = 'center';
    ctx.fillText(spec.empty || 'NO DATA YET', W / 2, H / 2); c.geo = null; return;
  }
  var xs = all.map(function (p) { return p.x; }), ys = all.map(function (p) { return p.y; });
  (spec.refs || []).forEach(function (r) { ys.push(r.y); });
  var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
  if (x1 === x0) { x0 -= 1; x1 += 1; }
  var y0 = spec.yMin != null ? spec.yMin : Math.min.apply(null, ys), y1 = spec.yMax != null ? spec.yMax : Math.max.apply(null, ys);
  if (spec.yMin == null || spec.yMax == null) { var pad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.01 || 1; if (spec.yMin == null) y0 -= pad; if (spec.yMax == null) y1 += pad; }
  var L = 52, R = 10, T = 8, B = 20, pw = W - L - R, ph = H - T - B;
  var X = function (x) { return L + (x - x0) / (x1 - x0) * pw; };
  var Y = function (y) { return T + (1 - (y - y0) / (y1 - y0)) * ph; };
  ctx.font = '8.5px "IBM Plex Mono", Consolas, monospace'; ctx.lineWidth = 1;
  for (var g = 0; g <= 4; g++) {
    var yy = T + ph * g / 4, val = y1 - (y1 - y0) * g / 4;
    ctx.strokeStyle = grid; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - R, yy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = dim; ctx.textAlign = 'right'; ctx.fillText(spec.yFmt ? spec.yFmt(val) : fmt(val, 2), L - 5, yy + 3);
  }
  ctx.textAlign = 'center'; ctx.fillStyle = dim;
  for (var k = 0; k <= 3; k++) { var xv = x0 + (x1 - x0) * k / 3; ctx.fillText(spec.xFmt ? spec.xFmt(xv) : String(Math.round(xv)), Math.min(W - R - 20, Math.max(L + 20, X(xv))), H - 5); }
  (spec.refs || []).forEach(function (r) {
    ctx.strokeStyle = r.color || mut; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(L, Y(r.y)); ctx.lineTo(W - R, Y(r.y)); ctx.stroke(); ctx.setLineDash([]);
    if (r.label) { ctx.fillStyle = r.color || mut; ctx.textAlign = r.left ? 'left' : 'right'; ctx.fillText(r.label, r.left ? L + 4 : W - R - 2, Y(r.y) - 3); }
  });
  spec.series.forEach(function (s) {
    if (s.pts.length > 1 && s.width !== 0) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.lineJoin = 'round';
      if (s.dash) ctx.setLineDash(s.dash);
      ctx.beginPath(); s.pts.forEach(function (p, i) { if (i) ctx.lineTo(X(p.x), Y(p.y)); else ctx.moveTo(X(p.x), Y(p.y)); }); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1;
    }
    if (s.dots) s.pts.forEach(function (p) {
      ctx.fillStyle = css('--panel3'); ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = p.c || s.color; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 4, 0, Math.PI * 2); ctx.fill();
    });
  });
  c.geo = { X: X, Y: Y, L: L, R: R, T: T, ph: ph, W: W, H: H, all: all };
  if (c.hover) {
    var hp = c.hover;
    ctx.strokeStyle = mut; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(X(hp.x), T); ctx.lineTo(X(hp.x), T + ph); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = css('--txt'); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(hp.x), Y(hp.y), 6, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
  }
  if (!cv._wired) {
    cv._wired = true;
    cv.addEventListener('mousemove', function (ev) {
      var ch = CHARTS[id]; if (!ch || !ch.geo) return;
      var rc = cv.getBoundingClientRect(), mx = ev.clientX - rc.left, my = ev.clientY - rc.top;
      var best = null, bd = 1e9;
      ch.geo.all.forEach(function (p) { var dx = ch.geo.X(p.x) - mx, dy = (ch.geo.Y(p.y) - my) * 0.25, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = p; } });
      if (!best) return;
      ch.hover = best; drawChart(id);
      var tip = document.getElementById(ch.tipId); if (!tip) return;
      tip.innerHTML = ch.spec.tip ? ch.spec.tip(best) : esc(fmt(best.y));
      tip.style.display = 'block';
      var tx = ch.geo.X(best.x) + 12, ty = ch.geo.Y(best.y) - 10;
      if (tx + tip.offsetWidth > rc.width - 4) tx = ch.geo.X(best.x) - tip.offsetWidth - 12;
      tip.style.left = Math.max(2, tx) + 'px'; tip.style.top = Math.max(2, Math.min(rc.height - tip.offsetHeight - 2, ty)) + 'px';
    });
    cv.addEventListener('mouseleave', function () { var ch = CHARTS[id]; if (!ch) return; ch.hover = null; drawChart(id); var tip = document.getElementById(ch.tipId); if (tip) tip.style.display = 'none'; });
  }
}
function sparkSVG(pts, okColor, badColor) {
  // inline svg sparkline of latency, failed probes marked as red ticks on the baseline
  if (!pts || !pts.length) return '<span class="dim">--</span>';
  var W = 120, H = 22, lat = pts.map(function (p) { return p.latency_ms == null ? 0 : p.latency_ms; });
  var mx = Math.max.apply(null, lat.concat([1]));
  var t0 = pts[0].ts, t1 = pts[pts.length - 1].ts; if (t1 === t0) t1 = t0 + 1;
  var X = function (t) { return 1 + (t - t0) / (t1 - t0) * (W - 2); };
  var Y = function (v) { return H - 2 - v / mx * (H - 4); };
  var ok = pts.filter(function (p) { return p.ok; });
  var d = ok.map(function (p, i) { return (i ? 'L' : 'M') + X(p.ts).toFixed(1) + ' ' + Y(p.latency_ms || 0).toFixed(1); }).join(' ');
  var bad = pts.filter(function (p) { return !p.ok; }).map(function (p) { return '<rect x="' + (X(p.ts) - 1).toFixed(1) + '" y="' + (H - 6) + '" width="2" height="6" fill="' + badColor + '"/>'; }).join('');
  var last = ok.length ? '<circle cx="' + X(ok[ok.length - 1].ts).toFixed(1) + '" cy="' + Y(ok[ok.length - 1].latency_ms || 0).toFixed(1) + '" r="2" fill="' + okColor + '"/>' : '';
  return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><path d="' + d + '" fill="none" stroke="' + okColor + '" stroke-width="1.5"/>' + bad + last + '</svg>';
}
var rzT; window.addEventListener('resize', function () { clearTimeout(rzT); rzT = setTimeout(redrawAll, 150); });
function redrawAll() { Object.keys(CHARTS).forEach(drawChart); }

/* =================================================================
   API LIVE
   ================================================================= */
var APIS = null, probing = false;
function stCell(p) {
  if (!p) return '<span class="st na">NO DATA</span>';
  if (p.skipped) return '<span class="st skip">SKIPPED</span>';
  return p.ok ? '<span class="st ok">ONLINE</span>' : '<span class="st bad">OFFLINE</span>';
}
function keyCell(p) {
  if (!p || !p.key) return '<span class="dim">NO KEY</span>';
  return p.keyState === 'resolved' ? '<span class="up">' + esc(p.key) + ' ✓</span>' : '<span class="dn">' + esc(p.key) + ' ✗</span>';
}
function renderApis() {
  var d = APIS; if (!d) return;
  var probes = d.probes;
  // no live run yet → paint from last stored probe rows
  if (!probes) {
    probes = Object.keys(d.last || {}).map(function (k) { var r = d.last[k]; return { provider: k, label: k, ok: !!r.ok, skipped: false, http: r.http, latencyMs: r.latency_ms, sample: r.sample, dataTs: null, detail: r.detail, key: null, keyState: 'none', usedBy: '', ts: r.ts, stored: true }; });
  }
  var up = css('--up'), dn = css('--dn');
  var rows = probes.map(function (p) {
    var h = (d.history || {})[p.provider] || [];
    var upt = h.length ? h.filter(function (x) { return x.ok; }).length / h.length : null;
        return '<tr>' +
      '<td>' + stCell(p) + '</td>' +
      '<td><b>' + esc(p.provider.toUpperCase()) + '</b><div class="dim" style="font-size:9px">' + esc(p.label) + '</div></td>' +
      '<td>' + keyCell(p) + '</td>' +
      '<td class="r">' + (p.http != null ? esc(p.http) : '--') + '</td>' +
      '<td class="r">' + (p.latencyMs != null ? p.latencyMs + 'ms' : '--') + '</td>' +
      '<td class="samp">' + esc(p.sample || '--') + '</td>' +
      '<td class="mut">' + esc(p.dataTs ? String(p.dataTs).replace('T', ' ').slice(0, 19) : '--') + '</td>' +
      '<td class="r ' + (upt == null ? 'dim' : upt >= 0.95 ? 'up' : upt >= 0.7 ? 'gold' : 'dn') + '">' + (upt == null ? '--' : pct(upt, 0)) + ' <span class="dim">(' + h.length + ')</span></td>' +
      '<td>' + sparkSVG(h, up, dn) + '</td>' +
      '<td class="mut">' + (p.stored ? 'stored · ' + ago(p.ts) : (p.skipped ? '--' : 'live · ' + ago(p.ts))) + '</td>' +
      '<td class="wrap">' + esc(p.detail || p.usedBy || '') + '</td>' +
      '</tr>';
  }).join('');
  $('#apiTbl').innerHTML = '<thead><tr><th>STATUS</th><th>PROVIDER</th><th>KEY</th><th class="r">HTTP</th><th class="r">LATENCY</th><th>SAMPLE VALUE</th><th>DATA TIMESTAMP</th><th class="r">24H UPTIME</th><th>24H LATENCY · FAILS</th><th>RESULT</th><th>DETAIL / USED BY</th></tr></thead><tbody>' + (rows || '<tr><td colspan="11" class="emptyst">NO PROBES YET — PRESS RUN LIVE PROBE</td></tr>') + '</tbody>';

  // secrets
  var sec = d.secrets || [];
  $('#secTbl').innerHTML = '<thead><tr><th>SECRET</th><th>BINDING</th><th>RESOLVED</th><th>ERROR</th></tr></thead><tbody>' + sec.map(function (s) {
    return '<tr><td><b>' + esc(s.name) + '</b></td><td class="' + (s.binding === 'none' ? 'dim' : 'mut') + '">' + esc(s.binding.toUpperCase()) + '</td><td>' + (s.resolved ? '<span class="st ok">YES</span>' : (s.binding === 'none' ? '<span class="st na">UNBOUND</span>' : '<span class="st bad">NO</span>')) + '</td><td class="wrap">' + esc(s.error || '') + '</td></tr>';
  }).join('') + '</tbody>';

  // cron-persisted provider_health
  var ph = d.providerHealth || [];
  var ie = d.isolateErrors || {};
  $('#phTbl').innerHTML = '<thead><tr><th>PROVIDER</th><th>STATUS</th><th>LAST OK</th><th>LAST FAIL</th><th class="r">LAT</th><th>LAST ERROR (THIS ISOLATE)</th></tr></thead><tbody>' + (ph.map(function (h) {
    var s = String(h.status || '').toLowerCase();
    var cls = s === 'online' ? 'ok' : s === 'degraded' || s === 'idle' ? 'skip' : 'bad';
    return '<tr><td><b>' + esc(String(h.provider).toUpperCase()) + '</b></td><td><span class="st ' + cls + '">' + esc(s.toUpperCase() || '--') + '</span></td><td class="mut">' + ago(h.last_success) + '</td><td class="mut">' + ago(h.last_failure) + '</td><td class="r">' + (h.latency_ms != null ? h.latency_ms + 'ms' : '--') + '</td><td class="wrap">' + esc(ie[h.provider] || '') + '</td></tr>';
  }).join('') || '<tr><td colspan="6" class="emptyst">EMPTY — CRON HAS NOT PERSISTED YET</td></tr>') + '</tbody>';

  // KPIs
  var live = (d.probes || []).filter(function (p) { return !p.skipped; });
  var on = live.filter(function (p) { return p.ok; }).length;
  setText('#kApis', live.length ? on + ' / ' + live.length : '--');
  var kA = $('#kApis'); if (kA) kA.className = live.length && on === live.length ? 'up' : (live.length ? 'dn' : '');
  setText('#kApisS', d.probes ? 'live probe ' + ago(d.ts) + (d.throttled ? ' (cached)' : '') : 'showing stored probes');
  var sb = sec.filter(function (s) { return s.binding !== 'none'; });
  var sr = sb.filter(function (s) { return s.resolved; }).length;
  setText('#kSec', sb.length ? sr + ' / ' + sb.length : '--');
  var kS = $('#kSec'); if (kS) kS.className = sb.length && sr === sb.length ? 'up' : 'dn';
  setText('#kSecS', sb.map(function (s) { return s.name.replace('_API_KEY', '').replace('_KEY', ''); }).join(' · '));
  setText('#probeMeta', d.probes ? ('last live run ' + new Date(d.ts).toLocaleTimeString('en-GB') + (d.forced ? ' · FORCED' : '') + (d.throttled ? ' · throttled (server reused last run)' : '')) : 'stored results — live run in progress…');
  setText('#liveTxt', d.probes ? ('PROBE ' + on + '/' + live.length) : 'PROBE --');
  var ld = $('#liveDot'); if (ld) ld.classList.toggle('bad', !!d.probes && on < live.length);
}
function loadApis(run, force) {
  if (probing) return Promise.resolve();
  probing = true;
  var bp = $('#bProbe'), bf = $('#bForce');
  if (run) { if (bp) bp.disabled = true; if (bf) bf.disabled = true; setText('#probeMeta', force ? 'forcing quota probes…' : 'probing upstream APIs…'); }
  var q = '/api/admin/apis' + (run ? '?run=1' + (force ? '&force=1' : '') : '');
  return api(q).then(function (d) {
    if (force && d.throttled) setText('#statusMid', 'FORCED PROBE THROTTLED — 1 PER 5 MIN TO PROTECT QUOTA');
    if (!d.probes && APIS && APIS.probes) d.probes = APIS.probes;
    APIS = d; renderApis();
  }).catch(function (e) {
    if (e.message !== 'FORBIDDEN') $('#apiTbl').innerHTML = '<tbody><tr><td class="err">API ERROR: ' + esc(e.message) + '</td></tr></tbody>';
  }).then(function () { probing = false; if (bp) bp.disabled = false; if (bf) bf.disabled = false; });
}
$('#bProbe').addEventListener('click', function () { loadApis(true, false); });
$('#bForce').addEventListener('click', function () {
  if (!confirm('Spend 1 request each on metals.dev, GoldAPI.io (both ~100/month) and Workers AI?')) return;
  loadApis(true, true);
});
setInterval(function () {
  var a = $('#autoProbe');
  if (document.hidden || TAB !== 'apis' || !a || !a.checked) return;
  loadApis(true, false);
}, 120000);

/* =================================================================
   ML ENGINE
   ================================================================= */
var ML = null;
function kpi(label, val, sub, cls) { return '<div class="kpi"><label>' + esc(label) + '</label><b class="' + (cls || '') + '">' + val + '</b><small>' + esc(sub || '') + '</small></div>'; }
function renderML() {
  var d = ML; if (!d) return;
  var s = d.snap, st = d.stats, active = (d.models || []).filter(function (m) { return m.active; })[0] || (d.models || [])[0];
  var met = active && active.metrics;
  var k = '';
  k += kpi('SIGNAL', s ? esc(s.direction) : 'WARMING', s ? 'p(up) ' + fmt(s.p, 3) + ' · prior ' + fmt(s.p0, 3) : 'no ml:snap in KV', s ? (s.p >= 0.5 ? 'up' : 'dn') : 'dim');
  k += kpi('FINAL SCORE', s && s.final ? pct(s.final.score, 0) : '--', s && s.final ? 'agreement ' + s.final.agreeing + '/' + (s.agents || []).length : '');
  k += kpi('REGIME', s && s.regime ? esc(s.regime.state) : '--', s && s.regime ? 'p ' + s.regime.probs.map(function (x) { return x.toFixed(2); }).join(' / ') : '');
  k += kpi('LIVE HIT RATE', st.graded ? pct(st.accuracy) : 'PENDING', st.graded + ' graded · ' + st.pending + ' pending', st.graded ? (st.accuracy > (st.baselineAlwaysUp || 0.5) ? 'up' : 'dn') : 'dim');
  k += kpi('ALWAYS-UP BASELINE', st.baselineAlwaysUp == null ? '--' : pct(st.baselineAlwaysUp), 'model must beat this');
  k += kpi('WALK-FWD LR / GBS', met ? pct(met.lrAcc, 1) + ' / ' + pct(met.gbsAcc, 1) : '--', met ? met.walkForwardN + ' test rows · ' + met.samples + ' samples' : 'no model');
  k += kpi('MODEL AGE', active ? age(Date.now() - active.trainedAt) : '--', active ? '#' + active.id + ' ' + (active.active ? 'ACTIVE' : 'inactive') + ' · ' + bytes(active.weightsBytes) : 'retrain needed', active && Date.now() - active.trainedAt > 7 * 864e5 ? 'dn' : '');
  k += kpi('LAST CRON RUN', d.cron.lastRun ? ago(d.cron.lastRun) : 'NEVER', 'next predict ≤6h after');
  $('#mlKpis').innerHTML = k;
  setText('#mlMeta', 'loaded ' + new Date(d.ts).toLocaleTimeString('en-GB') + ' · ' + d.cron.cadence);

  // top KPI strip
  setText('#kSig', s ? s.direction + ' ' + pct(s.p, 0) : 'WARMING');
  var kg = $('#kSig'); if (kg) kg.className = s ? (s.p >= 0.5 ? 'up' : 'dn') : 'dim';
  setText('#kSigS', s ? 'regime ' + (s.regime && s.regime.state) + ' · ' + ago(s.ts) : 'no snapshot');
  setText('#kAcc', st.graded ? pct(st.accuracy) : 'PENDING');
  setText('#kAccS', st.graded + ' graded vs base ' + (st.baselineAlwaysUp == null ? '--' : pct(st.baselineAlwaysUp)));
  setText('#kMod', active ? '#' + active.id : 'NONE');
  setText('#kModS', active ? 'trained ' + ago(active.trainedAt) : 'run RETRAIN');

  var upC = css('--up'), dnC = css('--dn'), dimC = css('--dim'), gold = css('--gold'), mut = css('--mut'), cyan = css('--cyan');
  var dFmt = function (x) { var t = new Date(x); return (t.getMonth() + 1) + '/' + t.getDate(); };

  // P(up) history
  var pts = (d.predictions || []).map(function (r) { return { x: r.ts, y: r.p_up, c: r.correct == null ? dimC : (r.correct ? upC : dnC), meta: r }; });
  lineChart('cvPred', 'tipPred', {
    series: [{ pts: pts, color: mut, width: 1, dots: true }], yMin: Math.min(0.3, Math.min.apply(null, pts.map(function (p) { return p.y; }).concat([0.5])) - 0.03), yMax: Math.max(0.7, Math.max.apply(null, pts.map(function (p) { return p.y; }).concat([0.5])) + 0.03),
    refs: [{ y: 0.5, color: mut, label: '0.50' }], xFmt: dFmt, yFmt: function (v) { return v.toFixed(2); },
    empty: 'NO PREDICTIONS YET — PRESS PREDICT NOW',
    tip: function (p) { var r = p.meta; return '<span class="k">' + esc(dt(r.ts)) + '</span><br>P(UP) <b>' + fmt(r.p_up, 3) + '</b> · ' + esc(r.direction) + '<br>REGIME ' + esc(r.regime || '--') + '<br>' + (r.correct == null ? '<span class="k">PENDING (needs 5 trading days)</span>' : ('5D MOVE <b class="' + (r.realized_ret >= 0 ? 'up' : 'dn') + '">' + (r.realized_ret >= 0 ? '+' : '') + fmt(r.realized_ret, 2) + '%</b> · ' + (r.correct ? '<b class="up">HIT</b>' : '<b class="dn">MISS</b>'))); },
  });

  // rolling accuracy
  var refs = [{ y: 0.5, color: mut, label: '50%', left: true }];
  if (st.baselineAlwaysUp != null) refs.push({ y: st.baselineAlwaysUp, color: cyan, label: 'ALWAYS-UP ' + pct(st.baselineAlwaysUp, 0) });
  lineChart('cvRoll', 'tipRoll', {
    series: [{ pts: (d.rolling || []).map(function (r) { return { x: r.ts, y: r.acc }; }), color: gold, width: 2 }],
    yMin: 0, yMax: 1, refs: refs, xFmt: dFmt, yFmt: function (v) { return Math.round(v * 100) + '%'; },
    empty: 'NEEDS ≥5 GRADED PREDICTIONS',
    tip: function (p) { return '<span class="k">' + esc(dt(p.x)) + '</span><br>ROLLING HIT RATE <b>' + pct(p.y, 0) + '</b>'; },
  });

  // gold snapshots
  lineChart('cvGold', 'tipGold', {
    series: [{ pts: (d.goldSnapshots || []).map(function (r) { return { x: r.ts, y: r.price, meta: r }; }), color: gold, width: 2 }],
    xFmt: dFmt, yFmt: function (v) { return fmt(v, 0); }, empty: 'NO SNAPSHOTS — CRON WRITES EVERY 5 MIN (LIVE SOURCES ONLY)',
    tip: function (p) { return '<span class="k">' + esc(dt(p.x)) + '</span><br>XAU <b>$' + fmt(p.y, 2) + '</b><br><span class="k">' + esc(p.meta.source) + '</span>'; },
  });

  // agents
  var ag = (s && s.agents) || [];
  $('#agentBars').innerHTML = ag.length ? ag.map(function (a) {
    var v = a.p, left = Math.min(v, 0.5) * 100, w = Math.abs(v - 0.5) * 100;
    return '<div class="hbar" title="' + esc(a.note) + '"><span class="n">' + esc(a.name) + '</span><span class="t"><s></s><i style="left:' + left + '%;width:' + w + '%;background:' + (v >= 0.5 ? upC : dnC) + '"></i></span><span class="v ' + (v >= 0.5 ? 'up' : 'dn') + '">' + Math.round(v * 100) + '</span></div>';
  }).join('') + '<div class="note">bar grows right of center = votes UP, left = DOWN. hover a row for the agent\'s input reading.</div>' : '<div class="emptyst">NO AGENT SNAPSHOT</div>';

  // regime
  if (s && s.regime) {
    var pr = s.regime.probs, cols = [upC, css('--amber'), dnC], lbl = ['BULL', 'NEUTRAL', 'RISK-OFF'];
    $('#regimeBox').innerHTML = '<div style="font:700 18px var(--mono)" class="' + (s.regime.state === 'BULL' ? 'up' : s.regime.state === 'RISKOFF' ? 'dn' : 'gold') + '">' + esc(s.regime.state) + '</div>' +
      '<div class="stack">' + pr.map(function (x, i) { return '<i style="width:' + (x * 100) + '%;background:' + cols[i] + '" title="' + lbl[i] + ' ' + pct(x, 0) + '"></i>'; }).join('') + '</div>' +
      pr.map(function (x, i) { return '<div class="hbar"><span class="n">' + lbl[i] + '</span><span class="t"><i style="left:0;width:' + (x * 100) + '%;background:' + cols[i] + '"></i></span><span class="v">' + pct(x, 0) + '</span></div>'; }).join('') +
      '<div class="note">forward-filtered over the last 60 sessions on (20d return, vol ratio, 60d drawdown). fixed parameters — a regime label, not a forecast.</div>';
  } else $('#regimeBox').innerHTML = '<div class="emptyst">NO REGIME</div>';

  // bayes
  var rounds = (s && s.rounds) || [];
  var bp = rounds.length ? [{ x: 0, y: s.p0, meta: { evidence: 'agent consensus prior', lr: null } }].concat(rounds.map(function (r) { return { x: r.round, y: r.pAfter, meta: r }; })) : [];
  lineChart('cvBayes', 'tipBayes', {
    series: [{ pts: bp.map(function (p) { p.c = p.y >= 0.5 ? upC : dnC; return p; }), color: gold, width: 2, dots: true }],
    refs: [{ y: 0.5, color: mut }], xFmt: function (x) { return 'R' + Math.round(x); }, yFmt: function (v) { return v.toFixed(2); },
    empty: 'NO ROUNDS (model has no LR table)',
    tip: function (p) { return 'R' + p.x + ' · <b>' + fmt(p.y, 3) + '</b><br><span class="k">' + esc(p.meta.evidence) + (p.meta.lr != null ? ' · LR ' + fmt(p.meta.lr, 2) : '') + '</span>'; },
  });

  // calibration
  var cal = d.calibration || [];
  $('#calibBox').innerHTML = '<table class="tb"><thead><tr><th>P(UP) BUCKET</th><th class="r">N</th><th class="r">MEAN P</th><th class="r">REALIZED UP</th><th></th></tr></thead><tbody>' + cal.map(function (c) {
    var gap = c.upRate != null && c.meanP != null ? c.upRate - c.meanP : null;
    return '<tr><td>' + esc(c.bucket) + '</td><td class="r">' + c.n + '</td><td class="r">' + (c.meanP == null ? '--' : pct(c.meanP, 0)) + '</td><td class="r"><b>' + (c.upRate == null ? '--' : pct(c.upRate, 0)) + '</b></td><td class="' + (gap == null ? 'dim' : Math.abs(gap) < 0.1 ? 'up' : 'gold') + '">' + (gap == null ? '' : (gap >= 0 ? '+' : '') + Math.round(gap * 100) + 'pp') + '</td></tr>';
  }).join('') + '</tbody></table><div class="note">well calibrated = realized up-rate ≈ mean P in each bucket. needs ~30+ graded rows before it means anything.</div>';

  // models
  $('#modelTbl').innerHTML = '<thead><tr><th>ID</th><th>TRAINED</th><th>STATE</th><th class="r">SAMPLES</th><th class="r">WF N</th><th class="r">LR ACC</th><th class="r">GBS ACC</th><th class="r">WEIGHTS</th></tr></thead><tbody>' + ((d.models || []).map(function (m) {
    var x = m.metrics || {};
    return '<tr' + (m.active ? ' class="hl"' : '') + '><td>#' + m.id + '</td><td class="mut">' + esc(dt(m.trainedAt)) + '</td><td>' + (m.active ? '<span class="st ok">ACTIVE</span>' : '<span class="st na">OLD</span>') + '</td><td class="r">' + (x.samples ?? '--') + '</td><td class="r">' + (x.walkForwardN ?? '--') + '</td><td class="r">' + pct(x.lrAcc) + '</td><td class="r">' + pct(x.gbsAcc) + '</td><td class="r mut">' + bytes(m.weightsBytes) + '</td></tr>';
  }).join('') || '<tr><td colspan="8" class="emptyst">NO MODELS — PRESS RETRAIN MODEL</td></tr>') + '</tbody>';

  // splits + bars
  var split = function (title, o) { return Object.keys(o).map(function (k2) { var v = o[k2]; return '<tr><td class="mut">' + title + '</td><td><b>' + esc(k2) + '</b></td><td class="r">' + v.n + '</td><td class="r">' + v.hits + '</td><td class="r ' + (v.hits / v.n >= 0.5 ? 'up' : 'dn') + '">' + pct(v.hits / v.n, 0) + '</td></tr>'; }).join(''); };
  var sp = split('REGIME', st.byRegime || {}) + split('CALL', st.byDirection || {});
  $('#splitTbl').innerHTML = '<thead><tr><th>SPLIT</th><th>VALUE</th><th class="r">GRADED</th><th class="r">HITS</th><th class="r">HIT RATE</th></tr></thead><tbody>' + (sp || '<tr><td colspan="5" class="emptyst">NO GRADED PREDICTIONS YET</td></tr>') + '</tbody>';
  $('#barsTbl').innerHTML = '<thead><tr><th>SYMBOL</th><th class="r">DAYS</th><th>FIRST</th><th>LAST</th></tr></thead><tbody>' + ((d.bars || []).map(function (b) { return '<tr><td><b>' + esc(b.symbol) + '</b></td><td class="r">' + b.n + '</td><td class="mut">' + esc(b.first) + '</td><td class="mut">' + esc(b.last) + '</td></tr>'; }).join('') || '<tr><td colspan="4" class="emptyst">EMPTY — WRITTEN ON EACH PREDICT RUN</td></tr>') + '</tbody>';
}
function loadML() {
  setText('#mlMeta', 'loading…');
  return api('/api/admin/ml').then(function (d) { ML = d; renderML(); }).catch(function (e) { if (e.message !== 'FORBIDDEN') setText('#mlMeta', 'ML ERROR: ' + e.message); });
}
function mlAction(btn, path, label, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  var b = $(btn); b.disabled = true; var t = b.textContent; b.textContent = label + '…';
  post(path).then(function (r) {
    setText('#statusMid', label + ' OK' + (r && r.metrics ? ' · LR ' + pct(r.metrics.lrAcc) + ' / GBS ' + pct(r.metrics.gbsAcc) : ''));
    return loadML();
  }).catch(function (e) { setText('#statusMid', label + ' FAILED: ' + e.message); })
    .then(function () { b.disabled = false; b.textContent = t; });
}
$('#bPredict').addEventListener('click', function () { mlAction('#bPredict', '/api/admin/ml/predict', 'PREDICT'); });
$('#bGrade').addEventListener('click', function () { mlAction('#bGrade', '/api/admin/ml/grade', 'GRADE'); });
$('#bTrain').addEventListener('click', function () { mlAction('#bTrain', '/api/admin/ml/train', 'RETRAIN', 'Retrain on 2y of Yahoo/FRED data? CPU heavy — on Workers Free it may hit the CPU limit.'); });
setInterval(function () { if (!document.hidden && TAB === 'ml') loadML(); }, 300000);

/* =================================================================
   DATABASE + KV
   ================================================================= */
var DB = null;
function renderDB(d, kv) {
  var used = d.sizeBytes, fr = used != null ? used / d.limits.freeBytes : null, pr = used != null ? used / d.limits.paidBytes : null;
  $('#dbSize').innerHTML = '<div style="font:700 24px var(--mono)">' + bytes(used) + '</div>' +
    '<div class="secH" style="margin-top:8px">VS WORKERS FREE LIMIT (500 MB / DB)</div><div class="gauge"><i style="width:' + Math.min(100, (fr || 0) * 100) + '%;background:' + (fr > 0.8 ? css('--dn') : fr > 0.5 ? css('--amber') : css('--up')) + '"></i></div><div class="tmeta">' + (fr == null ? '--' : pct(fr, 2)) + ' used</div>' +
    '<div class="secH" style="margin-top:8px">VS WORKERS PAID LIMIT (10 GB / DB)</div><div class="gauge"><i style="width:' + Math.min(100, (pr || 0) * 100) + '%"></i></div><div class="tmeta">' + (pr == null ? '--' : pct(pr, 3)) + ' used</div>' +
    '<div class="note">' + d.tables.length + ' tables · ' + d.indexes.length + ' indexes · read ' + new Date(d.ts).toLocaleTimeString('en-GB') + '</div>';
  var g = d.growth24h;
  $('#dbGrowth').innerHTML = '<table class="tb"><thead><tr><th>TABLE</th><th class="r">ROWS LAST 24H</th><th>RETENTION</th></tr></thead><tbody>' +
    '<tr><td>price_snapshots</td><td class="r">' + g.price_snapshots + '</td><td class="mut">' + esc(d.retention.price_snapshots) + '</td></tr>' +
    '<tr><td>api_probes</td><td class="r">' + g.api_probes + '</td><td class="mut">' + esc(d.retention.api_probes) + '</td></tr>' +
    '<tr><td>predictions</td><td class="r">' + g.predictions + '</td><td class="mut">kept (graded history)</td></tr>' +
    '<tr><td>sessions</td><td class="r">' + g.sessions + '</td><td class="mut">' + esc(d.retention.sessions) + '</td></tr>' +
    '</tbody></table><div class="note">expired sessions waiting for prune: <b>' + d.expiredSessions + '</b> · oldest snapshot: ' + (d.oldestSnapshot ? esc(dt(d.oldestSnapshot)) : '--') + ' · prune runs daily in the hourly cron.</div>';
  var maxB = Math.max.apply(null, d.tables.map(function (t) { return t.approxBytes || 0; }).concat([1]));
  $('#tblTbl').innerHTML = '<thead><tr><th>TABLE</th><th class="r">ROWS</th><th class="r">≈ PAYLOAD</th><th style="width:40%">SHARE</th></tr></thead><tbody>' + d.tables.map(function (t) {
    return '<tr><td><b>' + esc(t.name) + '</b></td><td class="r">' + Number(t.rows).toLocaleString('en-US') + '</td><td class="r">' + bytes(t.approxBytes) + '</td><td><div class="gauge" style="margin:0"><i style="width:' + ((t.approxBytes || 0) / maxB * 100) + '%"></i></div></td></tr>';
  }).join('') + '</tbody>';
  if (kv) {
    $('#kvTbl').innerHTML = '<thead><tr><th>KEY</th><th>PRESENT</th><th class="r">AGE</th><th class="r">LOGICAL TTL</th><th>STATE</th></tr></thead><tbody>' + kv.keys.map(function (k) {
      var fresh = k.present && k.ttl && k.ageMs != null ? k.ageMs < k.ttl * 1000 : null;
      return '<tr><td><b>' + esc(k.key) + '</b></td><td>' + (k.present ? '<span class="st ok">YES</span>' : '<span class="st na">NO</span>') + '</td><td class="r">' + age(k.ageMs) + '</td><td class="r mut">' + (k.ttl ? k.ttl + 's' : '--') + '</td><td class="' + (fresh == null ? 'dim' : fresh ? 'up' : 'gold') + '">' + (fresh == null ? (k.present ? 'no ttl (raw KV)' : (k.error ? esc(k.error) : '--')) : fresh ? 'FRESH' : 'STALE (fallback)') + '</td></tr>';
    }).join('') + '</tbody>';
    setText('#kvNote', kv.note);
  }
  setText('#kDb', bytes(used));
  setText('#kDbS', (fr == null ? '--' : pct(fr, 2)) + ' of 500 MB free tier');
  setText('#dbMeta', 'read ' + new Date(d.ts).toLocaleTimeString('en-GB'));
}
function renderWarehouse(w) {
  if (!w) return;
  var total = w.units.reduce(function (s, u) { return s + u.series.length; }, 0);
  var okU = w.units.filter(function (u) { return u.okAt; }).length, errU = w.units.filter(function (u) { return u.error; }).length;
  $('#whKpis').innerHTML = kpi('POINTS STORED', Number(w.totalPoints).toLocaleString('en-US'), w.seriesWithData + ' / ' + total + ' series have data') +
    kpi('UNITS OK', okU + ' / ' + w.units.length, errU + ' with last error', errU ? 'gold' : 'up') +
    kpi('DUE NOW', String(w.units.filter(function (u) { return u.due; }).length), 'budget ' + w.budget + ' calls / cycle') +
    kpi('BACKFILL PENDING', String(w.units.filter(function (u) { return u.backfill; }).length), 'never fetched OK yet') +
    kpi('VOL SNAPSHOTS', String(Object.keys(w.snapshots).length) + ' / 7', Object.keys(w.snapshots).map(function (k) { return k + ' ' + age(w.snapshots[k].ageMs); }).join(' · '));
  setText('#whSrc', 'read ' + new Date(w.ts).toLocaleTimeString('en-GB'));
  $('#whTbl').innerHTML = '<thead><tr><th>STATUS</th><th>UNIT</th><th>SOURCE</th><th class="r">EVERY</th><th>SERIES · POINTS · RANGE</th><th>LAST OK</th><th class="r">FAILS</th><th>LAST ERROR</th></tr></thead><tbody>' + w.units.map(function (u) {
    var st = u.backfill && !u.fetchedAt ? '<span class="st na">QUEUED</span>' : u.error ? '<span class="st bad">ERROR</span>' : u.due ? '<span class="st skip">DUE</span>' : '<span class="st ok">OK</span>';
    var ser = u.series.map(function (s) { return '<b>' + esc(s.id) + '</b> <span class="dim">' + s.points + (s.firstTs ? ' · ' + esc(dt(s.firstTs).slice(0, 10)) + '→' + esc(dt(s.lastTs).slice(0, 10)) : '') + '</span>'; }).join('<br>');
    return '<tr><td>' + st + '</td><td><b>' + esc(u.key) + '</b></td><td class="mut">' + esc(u.source) + '</td><td class="r mut">' + u.cadenceMin + 'm</td><td style="white-space:normal">' + ser + '</td><td class="mut">' + ago(u.okAt) + '</td><td class="r ' + (u.fails ? 'dn' : 'dim') + '">' + u.fails + '</td><td class="wrap">' + esc(u.error || '') + '</td></tr>';
  }).join('') + '</tbody>';
}
function loadDB() {
  setText('#dbMeta', 'loading…');
  return Promise.all([api('/api/admin/db'), api('/api/admin/kv').catch(function () { return null; }), api('/api/admin/storage').catch(function () { return null; })])
    .then(function (r) { DB = r[0]; renderDB(r[0], r[1]); renderWarehouse(r[2]); })
    .catch(function (e) { if (e.message !== 'FORBIDDEN') setText('#dbMeta', 'DB ERROR: ' + e.message); });
}
$('#bDb').addEventListener('click', loadDB);
$('#bIngest').addEventListener('click', function () {
  var b = $('#bIngest'); b.disabled = true; b.textContent = 'INGESTING…';
  post('/api/admin/storage/ingest').then(function (r) {
    var bad = r.ran.filter(function (x) { return !x.ok; });
    setText('#statusMid', 'INGEST: ' + r.ran.length + ' units · ' + r.rows + ' rows · ' + bad.length + ' failed · vol built ' + (r.volBuilt || []).join(',') + ' · ' + r.due + ' were due');
    return loadDB();
  }).catch(function (e) { setText('#statusMid', 'INGEST FAILED: ' + e.message); })
    .then(function () { b.disabled = false; b.textContent = 'RUN INGEST NOW'; });
});
$('#bRebuild').addEventListener('click', function () {
  // one class per request keeps each call inside the Workers CPU limit
  var b = $('#bRebuild'); b.disabled = true;
  var CL = ['rates', 'fx', 'stable', 'insurance', 'equity', 'commod'], done = [], failed = [];
  CL.reduce(function (p, c) {
    return p.then(function () { b.textContent = 'REBUILDING ' + c.toUpperCase() + '…'; return post('/api/admin/storage/rebuild', { cls: c }).then(function () { done.push(c); }).catch(function (e) { failed.push(c + ': ' + e.message); }); });
  }, Promise.resolve()).then(function () {
    setText('#statusMid', 'VOL REBUILT: ' + done.join(', ') + (failed.length ? ' · FAILED ' + failed.join(' | ') : ''));
    b.disabled = false; b.textContent = 'REBUILD VOL SNAPSHOTS'; return loadDB();
  });
});
$('#bPrune').addEventListener('click', function () {
  if (!confirm('Delete price_snapshots > 90d, api_probes > 14d and expired sessions?')) return;
  post('/api/admin/db/prune').then(function (r) { setText('#statusMid', 'PRUNED: ' + JSON.stringify(r.deleted)); return loadDB(); })
    .catch(function (e) { setText('#statusMid', 'PRUNE FAILED: ' + e.message); });
});

/* =================================================================
   USERS
   ================================================================= */
var USERS = null;
function renderUsers() {
  var d = USERS; if (!d) return;
  var admins = d.users.filter(function (u) { return u.role === 'admin'; }).length;
  $('#usrTbl').innerHTML = '<thead><tr><th>ID</th><th>OPERATOR</th><th>ROLE</th><th>CREATED</th><th>LAST LOGIN</th><th class="r">ACTIVE SESSIONS</th><th class="r">FAILED</th><th>LOCK</th><th>ACTIONS</th></tr></thead><tbody>' + d.users.map(function (u) {
    var me = d.me && d.me.id === u.id;
    var locked = u.locked_until && u.locked_until > Date.now();
    return '<tr' + (me ? ' class="hl"' : '') + '><td>' + u.id + '</td><td><b>' + esc(u.name) + '</b>' + (me ? ' <span class="gold">(YOU)</span>' : '') + '</td>' +
      '<td>' + (u.role === 'admin' ? '<span class="st skip">ADMIN</span>' : '<span class="st na">OPERATOR</span>') + '</td>' +
      '<td class="mut">' + esc(dt(u.created_at)) + '</td><td class="mut">' + ago(u.last_login) + '</td><td class="r">' + u.active_sessions + '</td><td class="r ' + (u.login_attempts ? 'dn' : 'dim') + '">' + (u.login_attempts || 0) + '</td>' +
      '<td>' + (locked ? '<span class="st bad">' + age(u.locked_until - Date.now()) + '</span>' : '<span class="dim">--</span>') + '</td>' +
      '<td>' + (u.role === 'admin'
        ? '<button class="abtn sm warn" data-act="role" data-id="' + u.id + '" data-role="operator"' + (admins <= 1 ? ' disabled title="last admin"' : '') + '>DEMOTE</button>'
        : '<button class="abtn sm" data-act="role" data-id="' + u.id + '" data-role="admin">PROMOTE</button>') +
      ' <button class="abtn sm" data-act="unlock" data-id="' + u.id + '"' + (locked || u.login_attempts ? '' : ' disabled') + '>UNLOCK</button>' +
      ' <button class="abtn sm warn" data-act="revoke" data-id="' + u.id + '"' + (me || !u.active_sessions ? ' disabled' : '') + '>REVOKE</button></td></tr>';
  }).join('') + '</tbody>';
  setText('#kUsr', d.users.length + ' / ' + admins);
  setText('#kUsrS', d.users.reduce(function (s, u) { return s + (u.active_sessions || 0); }, 0) + ' active sessions');
  setText('#usrMeta', 'read ' + new Date(d.ts).toLocaleTimeString('en-GB'));
}
function loadUsers() {
  return api('/api/admin/users').then(function (d) { USERS = d; renderUsers(); }).catch(function (e) { if (e.message !== 'FORBIDDEN') setText('#usrMeta', 'USERS ERROR: ' + e.message); });
}
$('#bUsers').addEventListener('click', loadUsers);
$('#usrTbl').addEventListener('click', function (ev) {
  var b = ev.target.closest('button[data-act]'); if (!b || b.disabled) return;
  var id = Number(b.dataset.id), act = b.dataset.act, p;
  if (act === 'role') { if (!confirm('Set user #' + id + ' role to ' + b.dataset.role.toUpperCase() + '?')) return; p = post('/api/admin/users/role', { id: id, role: b.dataset.role }); }
  else if (act === 'unlock') p = post('/api/admin/users/unlock', { id: id });
  else { if (!confirm('Sign user #' + id + ' out of every device?')) return; p = post('/api/admin/users/revoke', { id: id }); }
  p.then(function (r) { setText('#statusMid', act.toUpperCase() + (r.ok === false ? ' FAILED: ' + (r.error || '') : ' OK')); return loadUsers(); })
    .catch(function (e) { setText('#statusMid', act.toUpperCase() + ' FAILED: ' + e.message); });
});

/* =================================================================
   BOOT — role gate, then paint stored probes, then a live run
   ================================================================= */
api('/api/auth/me').then(function (me) {
  if (!me.valid) { location.replace('/login.html'); return; }
  try { localStorage.setItem('git-role', me.role || 'operator'); localStorage.setItem('git-name', me.name || ''); } catch (e) { }
  setText('#opbadge', String(me.name || 'ADMIN').toUpperCase() + ' · ' + String(me.role || '').toUpperCase());
  if (me.role !== 'admin') { forbidden(me); return; }
  showTab(TAB);
  loadApis(false, false).then(function () { return loadApis(true, false); });
  // header KPIs for the other tabs (cheap reads)
  if (TAB !== 'ml') loadML();
  if (TAB !== 'db') loadDB();
  if (TAB !== 'users') loadUsers();
}).catch(function (e) { setText('#statusMid', 'AUTH ERROR: ' + e.message); });
})();
