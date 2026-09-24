(function () {
'use strict';
var $ = function (s) { return document.querySelector(s); };
var fmt = function (n, d) { if (n == null || isNaN(n)) return '--'; d = d == null ? 2 : d; return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
var sgn = function (n) { return n > 0 ? '+' : ''; };
var cls = function (v) { return (v == null ? 0 : v) >= 0 ? 'up' : 'dn'; };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var safeUrl = function (u) { try { var x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : '#'; } catch (e) { return '#'; } };

var TOKEN = localStorage.getItem('git-token') || '';
var NAME = localStorage.getItem('git-name') || '';
if (!TOKEN) { location.replace('/login.html'); return; }

var _origFetch = window.fetch;
window.fetch = function (url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  if (TOKEN) opts.headers['x-session'] = TOKEN;
  return _origFetch(url, opts);
};

fetch('/api/auth/me').then(function (r) { return r.json(); }).then(function (d) {
  if (!d.valid) { localStorage.removeItem('git-token'); localStorage.removeItem('git-name'); location.replace('/login.html'); return; }
  localStorage.setItem('git-role', d.role || 'operator');
  if (d.role === 'admin') {
    var nav = document.querySelector('.gochips');
    if (nav && !document.querySelector('a[href="/diagnostics.html"]')) {
      var a = document.createElement('a');
      a.href = '/diagnostics.html'; a.className = 'gchip'; a.style.textDecoration = 'none'; a.textContent = 'DIAG';
      nav.appendChild(a);
    }
  }
}).catch(function () { });

async function getJSON(u) { var r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

var B = null;

setInterval(function () { var c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);
var clk = $('#clock'); if (clk) clk.textContent = new Date().toLocaleTimeString('en-GB');

var badge = $('#opbadge');
if (badge) badge.textContent = (NAME || 'OPERATOR').toUpperCase();
var lo = $('#logout');
if (lo) lo.addEventListener('click', async function () {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) }); } catch (e) { }
  localStorage.removeItem('git-token'); localStorage.removeItem('git-name'); localStorage.removeItem('git-role');
  location.href = '/login.html';
});

var DEF = { name: NAME, wf: 15, we: 10, wi: 10, wh: 30, wg: 10 };
var P = Object.assign({}, DEF, (function () { try { return JSON.parse(localStorage.getItem('git-profile') || '{}'); } catch (e) { return {}; } })());
function saveP() { localStorage.setItem('git-profile', JSON.stringify(P)); }
var op = $('#opname');
if (op) { op.value = P.name || ''; op.addEventListener('input', function () { P.name = op.value.slice(0, 24); saveP(); }); }
['wf', 'we', 'wi', 'wh', 'wg'].forEach(function (id) {
  var el = $('#' + id); if (!el) return;
  el.value = P[id];
  var lb = el.nextElementSibling; if (lb) lb.textContent = P[id] + '%';
  el.addEventListener('input', function () {
    P[id] = +el.value;
    if (lb) lb.textContent = P[id] + '%';
    saveP(); calc();
  });
});

function calc() {
  if (!B) return;
  var c = (B.macro && B.macro.components) || {};
  var d = (B.series && B.series.dailyCloses) || [];
  var n = Math.min(252, d.length - 2);
  var goldYoY = (d.length > 60 && n > 0) ? (d[d.length - 1] / d[d.length - 1 - n] - 1) * 100 : 0;
  var rest = Math.max(0, 100 - P.wf - P.we - P.wi - P.wh - P.wg);
  var real = (P.wf * (c.food != null ? c.food : 2.7) + P.we * (c.energy != null ? c.energy : -1.9) + P.wi * (c.autoins != null ? c.autoins : 11.8) + P.wh * (c.housing != null ? c.housing : 4.2) + P.wg * goldYoY + rest * (c.cpi != null ? c.cpi : 3.1)) / 100;
  var gap = real - (c.cpi != null ? c.cpi : 3.1);
  var rv = $('#riVal'); if (rv) rv.textContent = fmt(real, 1) + '%';
  var rf = $('#riFed'); if (rf) rf.textContent = 'FED CPI: ' + fmt(c.cpi, 1) + '%';
  var rg = $('#riGap');
  if (rg) {
    rg.textContent = 'GAP ' + (gap > 0 ? '+' : '') + fmt(gap, 1) + 'pp';
    rg.className = (gap > 0 ? 'dn' : 'up');
    rg.style.fontSize = '11px'; rg.style.fontWeight = '600';
  }
  var rr = $('#riRest'); if (rr) rr.textContent = 'REST ' + rest + '%';
}

function renderGold() {
  if (!B || !B.gold) return;
  var g = B.gold, p = g.changePct == null ? 0 : g.changePct;
  var px = $('#px'); if (px) px.textContent = fmt(g.price);
  var bc = $('#pxc');
  if (bc) {
    bc.className = 'bigchg ' + cls(p);
    bc.textContent = (p >= 0 ? 'UP +' : 'DN ') + fmt(Math.abs(g.change == null ? 0 : g.change)) + ' (' + sgn(p) + fmt(p) + '%)';
  }
  var gs = $('#gsrc'); if (gs) gs.textContent = String(g.source).toUpperCase();
  var gc = $('#gchip');
  if (gc) { gc.textContent = g.delay === 'simulated' ? 'SIM' : 'NEAR LIVE'; gc.className = 'chip ' + (g.delay === 'simulated' ? 'ai' : 'near'); }
  var m = B.ml;
  var ml = $('#mlLine');
  if (ml) {
    ml.innerHTML = m
      ? 'ML: <b class="' + (m.p >= 0.5 ? 'up' : 'dn') + '">' + esc(m.direction) + ' ' + (m.p * 100).toFixed(0) + '%</b> <b class="gold">' + esc(m.regime.state) + '</b> ' + m.final.agreeing + '/10 <a href="/ai.html" style="color:var(--cyan)">DETAILS</a>'
      : 'ML WARMING';
  }
  var live = B.mode === 'live';
  var ft = $('#feedTxt'); if (ft) ft.textContent = live ? 'LIVE' : 'SIM';
  var fd = $('#feedDot');
  if (fd) {
    fd.style.color = live ? 'var(--up)' : 'var(--amber)';
    var di = fd.querySelector('i'); if (di) di.style.background = live ? 'var(--up)' : 'var(--amber)';
  }
}

function renderRates() {
  if (!B || !B.macro) return;
  var keys = ['US10Y', 'REAL10Y', 'BREAKEV', 'SOFR', 'EFFR'];
  var rows = B.macro.rows || [];
  var h = keys.map(function (k) {
    var r = rows.find(function (x) { return x.key === k; });
    if (!r) return '';
    var d = (r.value - r.prior) * 100;
    return '<div class="ri"><span class="n">' + esc(r.label) + '</span><span class="gold">' + fmt(r.value, 2) + '%</span><span class="' + (d <= 0 ? 'up' : 'dn') + '" style="justify-self:end;font-size:9px">' + (d <= 0 ? 'v' : '^') + fmt(Math.abs(d), 1) + 'bp</span></div>';
  }).join('');
  if (B.dxy) {
    var dp = B.dxy.changePct == null ? 0 : B.dxy.changePct;
    h += '<div class="ri" style="border-top:1px dashed var(--line2);margin-top:4px;padding-top:5px"><span class="n">DXY</span><span class="cyan">' + fmt(B.dxy.price, 2) + '</span><span class="' + (dp >= 0 ? 'dn' : 'up') + '" style="justify-self:end;font-size:9px">' + sgn(dp) + fmt(dp, 2) + '%</span></div>';
  }
  h += '<div class="footnote">FRED DAILY - DXY NEAR-LIVE</div>';
  var rb = $('#ratesBody'); if (rb) rb.innerHTML = h;
}

function renderAlerts() {
  if (!B || !B.alerts) return;
  var list = B.alerts;
  var ac = $('#alCount'); if (ac) ac.textContent = list.length + ' ACTIVE';
  var al = $('#alList');
  if (al) al.innerHTML = list.map(function (a) {
    return '<div class="al ' + a.se + '"><span class="g">' + (a.se === 'crit' ? '#' : a.se === 'warn' ? '^' : 'o') + '</span><time>' + esc(a.t) + '</time><p>' + esc(a.txt) + '</p></div>';
  }).join('') || '<div class="al info"><p class="mut">NO ALERTS</p></div>';
}

function renderHealth() {
  if (!B || !B.health) return;
  var on = B.health.filter(function (h) { return h.status === 'online'; }).length;
  var tot = B.health.length;
  var hc = $('#hChip');
  if (hc) { hc.textContent = on + '/' + tot + ' ON'; hc.className = 'chip ' + (on === tot ? 'live' : on > 0 ? 'near' : 'ai'); }
  var hb = $('#hBody');
  if (hb) hb.innerHTML = B.health.map(function (h) {
    return (h.status === 'online' ? '<span class="up">o</span>' : '<span class="dim">-</span>') + ' ' + esc(h.name.toUpperCase());
  }).join('<br>');
}

function renderNews() {
  if (!B || !B.news) return;
  var nw = $('#nwList'); if (!nw) return;
  var gold = B.news.gold || [];
  nw.innerHTML = gold.slice(0, 6).map(function (n) {
    var sc = n.sentiment === 'bull' ? 'b' : (n.sentiment === 'bear' ? 's' : 'n');
    var st = n.sentiment === 'bull' ? 'BULL' : (n.sentiment === 'bear' ? 'BEAR' : 'NEUT');
    var link = (n.url && n.url !== '#') ? '<a href="' + esc(safeUrl(n.url)) + '" target="_blank" rel="noopener">OPEN</a>' : 'SIM';
    return '<li><time>' + new Date(n.publishedTs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</time><span class="tag">' + esc(n.source) + '</span><p>' + esc(n.title) + '</p><span class="sent ' + sc + '">' + st + '</span><div class="sum">' + link + '</div></li>';
  }).join('');
}

function renderTape() {
  if (!B || !B.tape) return;
  var h = B.tape.map(function (t) {
    var ch = t.changePct == null ? 0 : t.changePct;
    var dg = t.price > 500 ? 1 : (t.price > 20 ? 2 : 3);
    return '<span class="tg"><span class="k">' + esc(t.symbol) + '</span><span class="v">' + fmt(t.price, dg) + '</span><span class="c ' + cls(ch) + '">' + (ch >= 0 ? 'UP' : 'DN') + sgn(ch) + fmt(Math.abs(ch), 1) + '%</span></span>';
  }).join('');
  var a = $('#tapeA'), b = $('#tapeB');
  if (a) a.innerHTML = h; if (b) b.innerHTML = h;
}

function renderWatch() {
  var WATCH = [];
  try { WATCH = JSON.parse(localStorage.getItem('git-watch') || '[]'); } catch (e) { }
  var wc = $('#wcount'); if (wc) wc.textContent = String(WATCH.length);
  var wl = $('#watchList'); if (!wl) return;
  if (!WATCH.length) { wl.innerHTML = '<div class="footnote">ADD TICKERS (NEM, GLD, SPY...)</div>'; return; }
  getJSON('/api/watch?syms=' + encodeURIComponent(WATCH.join(','))).then(function (r) {
    wl.innerHTML = (r.quotes || []).map(function (q) {
      var ch = q.changePct == null ? 0 : q.changePct;
      return '<div class="watchrow"><b>' + esc(q.symbol) + '</b><span class="mut">' + esc(q.name || '') + '</span><span class="r"><b>' + fmt(q.price, 2) + '</b></span><span class="r ' + cls(ch) + '">' + sgn(ch) + fmt(ch, 2) + '%</span><span class="del" data-s="' + esc(q.symbol) + '">x</span></div>';
    }).join('');
    wl.querySelectorAll('.del').forEach(function (d) {
      d.addEventListener('click', function () {
        WATCH = WATCH.filter(function (s) { return s !== d.dataset.s; });
        localStorage.setItem('git-watch', JSON.stringify(WATCH));
        renderWatch();
      });
    });
  }).catch(function () { wl.innerHTML = '<div class="footnote">WATCH PENDING</div>'; });
}

var addgo = $('#addgo');
if (addgo) addgo.addEventListener('click', function () {
  var WATCH = [];
  try { WATCH = JSON.parse(localStorage.getItem('git-watch') || '[]'); } catch (e) { }
  var v = ($('#addsym').value || '').trim().toUpperCase();
  if (v && !WATCH.includes(v) && WATCH.length < 12) WATCH.push(v);
  var ai = $('#addsym'); if (ai) ai.value = '';
  localStorage.setItem('git-watch', JSON.stringify(WATCH));
  renderWatch();
});

function renderAll() {
  renderTape(); renderGold(); renderRates(); renderAlerts(); renderHealth(); renderNews(); renderWatch(); calc();
}

var aOut = $('#aOut');
function aiLine(txt) {
  if (!aOut) return null;
  var d = document.createElement('div'); d.className = 'ln'; d.textContent = txt || '';
  aOut.appendChild(d); aOut.scrollTop = 1e9; return d;
}
function typeInto(el, txt, cps) {
  return new Promise(function (res) {
    if (!el) { res(); return; }
    var i = 0;
    (function step() {
      if (i >= txt.length) { res(); return; }
      el.textContent += txt[i++];
      if (aOut) aOut.scrollTop = 1e9;
      setTimeout(step, Math.round(1000 / (cps || 70)));
    })();
  });
}
var busy = false;
var runA = $('#runA');
if (runA) runA.addEventListener('click', async function () {
  if (busy || !B) return; busy = true;
  runA.disabled = true; runA.textContent = 'ANALYZING...';
  if (aOut) aOut.innerHTML = '';
  try {
    var r = await fetch('/api/ai/analyst', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: { operator: P.name || 'OPERATOR', realInflation: parseFloat(($('#riVal') ? $('#riVal').textContent : '').replace('%', '')) || null } })
    });
    var ai = await r.json();
    await typeInto(aiLine(''), '> ' + ai.engine + '\n', 150);
    await typeInto(aiLine(''), '\n' + ai.text, 60);
  } catch (e) { aiLine('> ERROR: ' + String(e && e.message || e)); }
  runA.disabled = false; runA.textContent = 'RUN ANALYST';
  busy = false;
});

(async function init() {
  try {
    B = await getJSON('/api/bootstrap?tf=1D');
    renderAll();
  } catch (e) {
    var s = $('#status .mid');
    if (s) s.textContent = 'ERROR: ' + String(e && e.message || e);
  }
})();

setInterval(async function () {
  if (document.hidden || !B) return;
  try { B = await getJSON('/api/bootstrap?tf=1D'); renderAll(); } catch (e) { }
}, 60000);

setInterval(async function () {
  if (document.hidden || !B) return;
  try {
    var q = await getJSON('/api/quote');
    if (isFinite(q.gold) && B.gold.prevClose) {
      B.gold.price = q.gold;
      B.gold.change = q.gold - B.gold.prevClose;
      B.gold.changePct = (q.gold / B.gold.prevClose - 1) * 100;
    }
    renderGold(); renderTape();
  } catch (e) { }
}, 20000);

(function () {
  var mode = localStorage.getItem('git-theme') || 'auto';
  var isDay = function () { return mode === 'day' || (mode === 'auto' && matchMedia('(prefers-color-scheme: light)').matches); };
  var apply = function () {
    document.body.classList.toggle('day', isDay());
    var b = document.getElementById('themeBtn');
    if (b) b.textContent = mode === 'auto' ? 'AUTO' : mode.toUpperCase();
  };
  var b = document.getElementById('themeBtn');
  if (b) b.addEventListener('click', function () { mode = mode === 'auto' ? 'day' : (mode === 'day' ? 'night' : 'auto'); localStorage.setItem('git-theme', mode); apply(); });
  apply();
})();
})();
