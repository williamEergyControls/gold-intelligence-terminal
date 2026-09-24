(function () {
'use strict';
var $ = function (s) { return document.querySelector(s); };
var fmt = function (n, d) { if (n == null || isNaN(n)) return '--'; d = d == null ? 1 : d; return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

var TOKEN = localStorage.getItem('git-token') || '';
if (!TOKEN) { location.replace('/login.html'); return; }
var _f = window.fetch;
window.fetch = function (u, o) { o = o || {}; o.headers = o.headers || {}; o.headers['x-session'] = TOKEN; return _f(u, o); };

setInterval(function () { var c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);
var clk = $('#clock'); if (clk) clk.textContent = new Date().toLocaleTimeString('en-GB');

var ML = null;
var HISTORY = [];

fetch('/api/ml').then(function (r) { return r.json(); }).then(function (ml) {
  if (ml.status === 'WARMING' || !ml.direction) {
    var mb = $('#mlBody');
    if (mb) mb.innerHTML = '<div class="footnote">ML WARMING - first prediction within the hour</div>';
    var sb = $('#scoresBody');
    if (sb) sb.innerHTML = '<div class="footnote">PENDING ML ACTIVATION</div>';
    return;
  }
  ML = ml;
  renderSignal(); renderAgents(); drawGauge(); drawAgentChart(); drawHistory();
}).catch(function (e) {
  var mb = $('#mlBody'); if (mb) mb.textContent = 'ML ERROR: ' + e.message;
});

function getCSS(n) { return getComputedStyle(document.body).getPropertyValue(n).trim(); }

function renderSignal() {
  var m = ML;
  var dir = $('#mlDir');
  if (dir) { dir.textContent = m.direction; dir.className = 'chip ' + (m.p >= 0.5 ? 'live' : 'ai'); }
  var h = '';
  h += '<div class="bi"><span class="n">SIGNAL</span><span class="' + (m.p >= 0.5 ? 'up' : 'dn') + '">' + m.direction + ' ' + (m.p * 100).toFixed(0) + '%</span></div>';
  h += '<div class="bi"><span class="n">REGIME</span><span class="gold">' + esc(m.regime.state) + '</span></div>';
  h += '<div class="bi"><span class="n">CONFIDENCE</span><span class="gold">' + (m.final.score * 100).toFixed(0) + '%</span></div>';
  h += '<div class="bi"><span class="n">AGREEMENT</span><span class="mut">' + m.final.agreeing + '/10</span></div>';
  h += '<div class="bi"><span class="n">ACCURACY</span><span class="mut">' + esc(m.final.accStatus) + '</span></div>';
  if (m.model && m.model.metrics) {
    h += '<div class="bi"><span class="n">LOGISTIC</span><span class="mut">' + (m.model.metrics.lrAcc * 100).toFixed(1) + '%</span></div>';
    h += '<div class="bi"><span class="n">GRAD BOOST</span><span class="mut">' + (m.model.metrics.gbsAcc * 100).toFixed(1) + '%</span></div>';
  }
  h += '<div class="footnote">LOGISTIC + GRADIENT BOOST + HMM - 2Y DATA - WF VALIDATED</div>';
  var mb = $('#mlBody'); if (mb) mb.innerHTML = h;
}

function renderAgents() {
  var agents = ML.agents || [];
  var h = agents.map(function (a) {
    var pct = Math.round(a.p * 100);
    var col = a.p >= 0.6 ? 'var(--up)' : a.p >= 0.4 ? 'var(--amber)' : 'var(--dn)';
    return '<div class="scorebar"><span class="sn">' + esc(a.name) + '</span><span class="sv ' + (a.p >= 0.5 ? 'up' : 'dn') + '">' + pct + '</span><div class="sb"><i style="width:' + pct + '%;background:' + col + '"></i></div></div>';
  }).join('');
  h += '<div class="footnote">10 AGENTS EACH ANALYZE ONE FACTOR</div>';
  var sb = $('#scoresBody'); if (sb) sb.innerHTML = h;
}

function drawGauge() {
  var cv = $('#gaugeCv'); if (!cv) return;
  var r = cv.getBoundingClientRect(); if (r.width < 10) return;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  var gold = getCSS('--gold'), dim = getCSS('--dim'), up = getCSS('--up'), dn = getCSS('--dn');
  var cx = r.width / 2, cy = r.height * 0.8, rad = Math.min(r.width, r.height) * 0.35;
  ctx.beginPath(); ctx.arc(cx, cy, rad, Math.PI, 2 * Math.PI);
  ctx.strokeStyle = dim; ctx.lineWidth = 12; ctx.stroke();
  var conf = ML.final.score;
  ctx.beginPath(); ctx.arc(cx, cy, rad, Math.PI, Math.PI + Math.PI * conf);
  ctx.strokeStyle = conf >= 0.6 ? up : conf >= 0.4 ? gold : dn;
  ctx.lineWidth = 12; ctx.stroke();
  ctx.fillStyle = gold; ctx.font = '700 22px IBM Plex Mono'; ctx.textAlign = 'center';
  ctx.fillText((conf * 100).toFixed(0) + '%', cx, cy - 15);
  ctx.fillStyle = dim; ctx.font = '600 8px IBM Plex Mono';
  ctx.fillText('CONFIDENCE', cx, cy + 5);
}

function drawAgentChart() {
  var cv = $('#agentCv'); if (!cv) return;
  var r = cv.getBoundingClientRect(); if (r.width < 10) return;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  var up = getCSS('--up'), dn = getCSS('--dn'), mut = getCSS('--mut'), grid = getCSS('--grid');
  var agents = ML.agents || []; if (!agents.length) return;
  var W = r.width, H = r.height;
  var padL = 35, padB = 30, padT = 10;
  var pw = W - padL - 10, ph = H - padB - padT;
  var gap = pw / agents.length, bw = gap * 0.6;
  ctx.font = '8px IBM Plex Mono';
  for (var g = 0; g <= 4; g++) {
    var y = padT + ph * g / 4;
    ctx.strokeStyle = grid; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - 10, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = mut; ctx.textAlign = 'right';
    ctx.fillText(String(100 - g * 25), padL - 5, y + 3);
  }
  var y50 = padT + ph / 2;
  ctx.strokeStyle = mut; ctx.beginPath(); ctx.moveTo(padL, y50); ctx.lineTo(W - 10, y50); ctx.stroke();
  agents.forEach(function (a, i) {
    var x = padL + gap * i + (gap - bw) / 2;
    var y = padT + ph * (1 - a.p);
    ctx.fillStyle = a.p >= 0.5 ? up : dn;
    ctx.fillRect(x, y, bw, ph * a.p);
    ctx.fillStyle = mut; ctx.textAlign = 'center';
    ctx.fillText(a.name.slice(0, 6), x + bw / 2, H - 5);
  });
  ctx.fillStyle = gold0(); ctx.textAlign = 'left';
  ctx.fillText('P(UP) BY AGENT', padL, padT - 2);
  function gold0() { return getCSS('--gold'); }
}

function drawHistory() {
  var cv = $('#histCv'); if (!cv) return;
  var r = cv.getBoundingClientRect(); if (r.width < 10) return;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  var gold = getCSS('--gold'), mut = getCSS('--mut'), grid = getCSS('--grid'), up = getCSS('--up'), dn = getCSS('--dn');
  var rounds = ML.rounds || [];
  if (!rounds.length) {
    ctx.fillStyle = mut; ctx.font = '10px IBM Plex Mono'; ctx.textAlign = 'center';
    ctx.fillText('NO ROUND DATA', r.width / 2, r.height / 2);
    return;
  }
  var W = r.width, H = r.height;
  var padL = 35, padB = 18, padT = 10;
  var pw = W - padL - 10, ph = H - padB - padT;
  var vals = rounds.map(function (rd) { return rd.pAfter; });
  var lo = Math.min.apply(null, vals) - 0.05;
  var hi = Math.max.apply(null, vals) + 0.05;
  var rg = hi - lo || 1;
  ctx.font = '8px IBM Plex Mono';
  for (var g = 0; g <= 3; g++) {
    var y = padT + ph * g / 3;
    ctx.strokeStyle = grid; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - 10, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = mut; ctx.textAlign = 'right';
    ctx.fillText((hi - rg * g / 3).toFixed(2), padL - 5, y + 3);
  }
  ctx.beginPath();
  rounds.forEach(function (rd, i) {
    var x = padL + (pw / Math.max(1, rounds.length - 1)) * i;
    var y = padT + ph * (1 - (rd.pAfter - lo) / rg);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = gold; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
  rounds.forEach(function (rd, i) {
    var x = padL + (pw / Math.max(1, rounds.length - 1)) * i;
    var y = padT + ph * (1 - (rd.pAfter - lo) / rg);
    ctx.fillStyle = rd.pAfter >= 0.5 ? up : dn;
    ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = mut; ctx.textAlign = 'center';
    ctx.fillText('R' + rd.round, x, H - 5);
  });
}

var askBtn = $('#askBtn');
if (askBtn) askBtn.addEventListener('click', function () {
  var qb = $('#qbox'); if (!qb) return;
  var q = qb.value.trim(); if (!q) return;
  askBtn.disabled = true; askBtn.textContent = 'ANALYZING...';
  var out = $('#answer');
  if (out) out.innerHTML = '<span class="hint">QUERYING...</span>';
  fetch('/api/ai/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: q })
  }).then(function (r) { return r.json(); }).then(function (d) {
    askBtn.disabled = false; askBtn.textContent = 'ASK ANALYST';
    if (!out) return;
    if (d.ok) {
      out.innerHTML = '';
      var h = document.createElement('div'); h.className = 'ln'; h.style.color = 'var(--dim)';
      h.textContent = '> ' + d.engine; out.appendChild(h);
      var b = document.createElement('div'); b.className = 'ln'; b.style.marginTop = '8px';
      b.textContent = d.answer; out.appendChild(b);
      HISTORY.unshift({ q: q, a: d.answer });
      renderHist();
    } else {
      out.innerHTML = '<span class="hint" style="color:var(--dn)">ERROR</span>';
    }
  }).catch(function () {
    askBtn.disabled = false; askBtn.textContent = 'ASK ANALYST';
    if (out) out.innerHTML = '<span class="hint" style="color:var(--dn)">CONNECTION ERROR</span>';
  });
});

function renderHist() {
  var hb = $('#historyBody'); if (!hb) return;
  hb.innerHTML = HISTORY.map(function (item) {
    return '<div class="hist-item"><div class="q">Q: ' + esc(item.q) + '</div><div class="a">' + esc(item.a) + '</div></div>';
  }).join('') || '<div class="footnote">NO QUESTIONS YET</div>';
}

var rzT;
window.addEventListener('resize', function () {
  clearTimeout(rzT);
  rzT = setTimeout(function () { if (ML) { drawGauge(); drawAgentChart(); drawHistory(); } }, 150);
});

(function () {
  var mode = localStorage.getItem('git-theme') || 'auto';
  var isDay = function () { return mode === 'day' || (mode === 'auto' && matchMedia('(prefers-color-scheme: light)').matches); };
  var apply = function () {
    document.body.classList.toggle('day', isDay());
    var b = document.getElementById('themeBtn');
    if (b) b.textContent = mode === 'auto' ? 'AUTO' : mode.toUpperCase();
    if (ML) { drawGauge(); drawAgentChart(); drawHistory(); }
  };
  var b = document.getElementById('themeBtn');
  if (b) b.addEventListener('click', function () { mode = mode === 'auto' ? 'day' : (mode === 'day' ? 'night' : 'auto'); localStorage.setItem('git-theme', mode); apply(); });
  apply();
})();
})();
