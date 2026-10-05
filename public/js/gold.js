/* ================================================================
   GOLD DESK
   INIT     /api/bootstrap?tf=15M (retry with backoff) → candles for the chosen timeframe
   POLL     bootstrap 60 s · quote 20 s · ML snapshot + history on load
   PUBLISH  hero · chart · attribution · model card · driver comparison · miners heat map
            calendar, news and ideas come from their own modules
   ================================================================ */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var G = window.GT, fmt = G.fmt, sgn = G.sgn, cls = G.cls, esc = G.esc, css = G.css;
  var B = null, CH = [], TF = '15M', CMP = 'dxy';
  var view = { type: 'candle', ma20: true, ma50: true };
  var mouse = { x: 0, in: false }, rafQ = false;

  function getJSON(u) { return G.getJSON(u); }
  function setChip(el, delay) {
    var map = { 'near-live': ['Near live', 'near'], eod: ['End of day', 'month'], daily: ['Daily', 'month'], simulated: ['Simulated', 'ai'], realtime: ['Live', 'live'] };
    var m = map[delay] || ['–', 'month'];
    if (el) { el.textContent = m[0]; el.className = 'chip ' + m[1]; }
  }

  /* ---------- hero ---------- */
  function renderHero() {
    if (!B || !B.gold) return;
    var g = B.gold, p = g.changePct == null ? 0 : g.changePct;
    setChip($('#gChip'), g.delay);
    $('#bigPx').textContent = '$' + fmt(g.price);
    var bc = $('#bigChg'); bc.className = 'bigchg ' + cls(p);
    bc.textContent = sgn(g.change) + fmt(g.change) + ' (' + sgn(p) + fmt(p) + '%) today';
    $('#bid').textContent = g.bid != null ? fmt(g.bid) : '–';
    $('#ask').textContent = g.ask != null ? fmt(g.ask) : '–';
    $('#oo').textContent = fmt(g.open); $('#oh').textContent = fmt(g.high); $('#ol').textContent = fmt(g.low);
    $('#prevC').textContent = fmt(g.prevClose);
    var d = (B.series && B.series.dailyCloses) || [];
    if (d.length > 25) {
      var last = d[d.length - 1];
      var w = d.length > 5 ? (last / d[d.length - 6] - 1) * 100 : null;
      var y = d.length > 250 ? (last / d[d.length - 251] - 1) * 100 : null;
      var sw = $('#stWk'); sw.textContent = w == null ? '–' : sgn(w) + fmt(w, 1) + '%'; sw.className = cls(w);
      var sy = $('#st1y'); sy.textContent = y == null ? '–' : sgn(y) + fmt(y, 1) + '%'; sy.className = cls(y);
    }
    if (B.ratio) $('#ratioV').textContent = fmt(B.ratio, 1);
    $('#gSrc').textContent = ' · ' + G.sc(String(g.source || '')).replace(/\(unofficial\)/i, '').trim();
    $('#asof').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function renderTape() {
    if (!B || !B.tape) return;
    $('#tapeA').innerHTML = B.tape.map(function (t) {
      var ch = t.changePct == null ? 0 : t.changePct, dg = t.price > 500 ? 1 : (t.price > 20 ? 2 : 3);
      return '<span class="tg"><span class="k">' + esc(t.symbol) + '</span><span class="v">' + fmt(t.price, dg) + '</span><span class="c ' + cls(ch) + '">' + sgn(ch) + fmt(ch, 2) + '%</span></span>';
    }).join('');
  }

  /* ---------- attribution ---------- */
  function renderWhy() {
    if (!B || !B.why) return;
    var w = B.why, mp = B.gold ? B.gold.changePct : w.movePct;
    $('#whyMove').innerHTML = 'Gold is <b class="' + cls(mp) + '">' + (mp >= 0 ? 'up ' : 'down ') + fmt(Math.abs(mp), 2) + '%</b> today. Ranked drivers:';
    $('#whyDrv').innerHTML = (w.drivers || []).map(function (d) {
      return '<div class="drow"><span class="n">' + esc(G.sc(d.name)) + '</span><span class="d ' + (d.dir > 0 ? 'up' : d.dir < 0 ? 'dn' : 'mut') + '">' + esc(d.delta) + '</span><span class="m" title="weight ' + d.magnitude + '"><i style="width:' + Math.max(4, Math.min(100, d.magnitude)) + '%"></i></span></div>';
    }).join('');
    $('#confBar').style.width = Math.max(0, Math.min(100, w.confidence)) + '%';
    $('#confVal').textContent = w.confidence + '%';
  }

  /* ---------- model card ---------- */
  function ring(p) {
    var r = 54, C = 2 * Math.PI * r, col = p >= 0.5 ? 'var(--up)' : 'var(--dn)';
    return '<div class="ring"><svg viewBox="0 0 132 132"><circle cx="66" cy="66" r="' + r + '" fill="none" stroke="var(--grid)" stroke-width="10"/>' +
      '<circle cx="66" cy="66" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + (C * p).toFixed(1) + ' ' + C.toFixed(1) + '"/></svg>' +
      '<div class="rv"><b>' + Math.round(p * 100) + '%</b><small>chance up</small></div></div>';
  }
  function renderML(hist) {
    var m = B && B.ml;
    if (!m || m.status === 'WARMING' || m.p == null) return;
    var agents = (m.agents || []).map(function (a) {
      var c = a.p >= 0.55 ? 'up' : a.p <= 0.45 ? 'dn' : 'mut';
      return '<div title="' + esc(a.note) + '"><span class="sdot ' + (a.p >= 0.55 ? 'bull' : a.p <= 0.45 ? 'bear' : '') + '"></span><span class="nm">' + esc(G.sc(a.name)) + '</span><b class="' + c + '">' + Math.round(a.p * 100) + '%</b></div>';
    }).join('');
    var hit = '–';
    if (hist && hist.length) {
      var g = hist.filter(function (r) { return r.correct != null; });
      if (g.length) hit = Math.round(g.filter(function (r) { return r.correct; }).length / g.length * 100) + '% of ' + g.length;
    }
    $('#mlBody').innerHTML = '<div class="mlwrap">' + ring(m.p) +
      '<div class="kv k2"><div><label>Call</label><b class="' + (m.p >= 0.5 ? 'up' : 'dn') + '">' + (m.p >= 0.5 ? 'Bullish' : 'Bearish') + '</b></div>' +
      '<div><label>Regime (HMM)</label><b>' + esc(G.sc(m.regime && m.regime.state || '–')) + '</b></div>' +
      '<div><label>Agents agreeing</label><b>' + (m.final ? m.final.agreeing : '–') + ' of ' + (m.agents ? m.agents.length : 10) + '</b></div>' +
      '<div><label>Hit rate, graded</label><b>' + hit + '</b></div></div></div>' +
      '<div class="agents">' + agents + '</div>' +
      '<div class="mlhist"><canvas id="cvHist" aria-label="Past predictions"></canvas><div class="cktip" id="tpHist"></div></div>' +
      '<div class="note dim" style="font-size:12px;margin-top:6px">Line: model probability at each run. Dots: graded 5-day outcome (green right, red wrong).</div>';
    if (hist && hist.length > 1 && window.GK) {
      var pts = hist.slice().reverse().map(function (r) { return { x: r.ts, y: r.p_up * 100, c: r.correct == null ? css('--dim') : r.correct ? css('--up') : css('--dn') }; });
      GK.line($('#cvHist'), $('#tpHist'), { series: [{ name: 'P(up)', pts: pts, color: css('--gold'), width: 1.8, dots: true }], refs: [{ y: 50, label: '50%', color: css('--dim') }], yMin: 0, yMax: 100, yFmt: function (v) { return Math.round(v) + '%'; } });
    }
  }

  /* ---------- miners heat map ---------- */
  function rgb(hex) { hex = hex.replace('#', ''); if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join(''); return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]; }
  function tint(c) {
    var up = rgb(css('--up')), dn = rgb(css('--dn')), a = Math.min(1, Math.abs(c) / 4);
    var base = c >= 0 ? up : dn, day = document.body.classList.contains('day');
    var alpha = 0.12 + a * (day ? 0.75 : 0.6);
    return { bg: 'rgba(' + base.join(',') + ',' + alpha.toFixed(2) + ')', fg: alpha > 0.55 ? (day ? '#fff' : '#111') : 'var(--txt)' };
  }
  function renderMiners() {
    if (!B || !B.miners) return;
    var ms = B.miners.slice().sort(function (a, b) { return (b.changePct || 0) - (a.changePct || 0); });
    setChip($('#hmChip'), ms[0] ? ms[0].delay : 'eod');
    var avg = ms.reduce(function (s, m) { return s + (m.changePct || 0); }, 0) / Math.max(1, ms.length);
    var up = ms.filter(function (m) { return (m.changePct || 0) > 0; }).length;
    var gp = B.gold ? B.gold.changePct : 0;
    $('#hmSum').innerHTML = '<span>Gold <b class="' + cls(gp) + '">' + sgn(gp) + fmt(gp, 1) + '%</b></span><span>Miners avg <b class="' + cls(avg) + '">' + sgn(avg) + fmt(avg, 1) + '%</b></span><span>' + up + ' of ' + ms.length + ' up</span>';
    $('#hm').innerHTML = ms.map(function (m) {
      var c = m.changePct == null ? 0 : m.changePct, t = tint(c);
      return '<div class="hc" style="background:' + t.bg + ';color:' + t.fg + '" title="' + esc(m.name || m.symbol) + (m.price != null ? ' · $' + fmt(m.price) : '') + '"><div class="t">' + esc(m.symbol) + '</div><div class="c">' + sgn(c) + fmt(c, 1) + '%</div></div>';
    }).join('');
    [-3, -1.5, 0, 1.5, 3].forEach(function (v, i) { var e = $('#lg' + (i + 1)); if (e) e.style.background = tint(v).bg; });
    $('#hmSrc').textContent = ms[0] ? G.sc(String(ms[0].source || '').split('(')[0]) : '';
  }

  /* ---------- comparison mini ---------- */
  function renderCmp() {
    if (!B || !B.series || !window.GK) return;
    var s = B.series, gold = s.goldIdx || [], other, name, note, stat;
    if (CMP === 'dxy') { other = s.dxyIdx || null; name = 'US dollar (DXY)'; stat = 'Correlation <b>' + (B.corr && B.corr.dxy != null ? B.corr.dxy.toFixed(2) : '–') + '</b><span>DXY <b>' + (B.dxy ? fmt(B.dxy.price, 2) : '–') + '</b></span>'; note = 'Gold usually moves against the dollar; a correlation near −1 means that link is strong right now.'; }
    else if (CMP === 'ry') { other = s.ryIdx || []; name = '10Y real yield (indexed)'; var ry = (B.macro && B.macro.rows || []).find(function (r) { return r.key === 'REAL10Y'; }); stat = 'Correlation <b>' + (B.corr && B.corr.ry != null ? B.corr.ry.toFixed(2) : '–') + '</b><span>TIPS 10Y <b>' + (ry ? fmt(ry.value, 2) + '%' : '–') + '</b></span>'; note = 'Real yields are gold\'s opportunity cost. Source: FRED DFII10.'; }
    else { other = null; gold = s.ratio || []; name = 'Gold / silver ratio'; stat = 'Ratio <b class="gold">' + (B.ratio ? fmt(B.ratio, 1) : '–') + '</b>'; note = 'Ounces of silver per ounce of gold. Higher means silver is cheap relative to gold.'; }
    var n = gold.length, X = function (i) { return Date.now() - (n - 1 - i) * 864e5 * 1.4; };
    var series = [{ name: CMP === 'ratio' ? 'Gold / silver' : 'Gold', pts: gold.map(function (v, i) { return { x: X(i), y: v }; }), color: css('--gold'), width: 2, fill: true }];
    if (other && other.length) series.push({ name: name, pts: other.map(function (v, i) { return { x: X(i + gold.length - other.length), y: v }; }), color: css('--blue'), width: 1.6, dash: CMP === 'ry' ? [4, 3] : null });
    GK.line($('#cvCmp'), null, { series: series, yFmt: function (v) { return fmt(v, CMP === 'ratio' ? 1 : 0); }, xFmt: function () { return ''; } });
    $('#cmpStat').innerHTML = '<span>' + stat.replace('</b><span>', '</b></span><span>') + '</span>';
    $('#cmpNote').textContent = note;
  }
  $('#cmpTabs').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    CMP = b.dataset.k;
    this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
    renderCmp();
  });

  /* ---------- main chart ---------- */
  function fit(cv) { var r = cv.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2); cv.width = Math.max(1, Math.round(r.width * d)); cv.height = Math.max(1, Math.round(r.height * d)); var ctx = cv.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0); return [ctx, r.width, r.height]; }
  var sma = function (a, p) { return a.map(function (_, i) { if (i < p - 1) return null; var s = 0; for (var k = i - p + 1; k <= i; k++) s += a[k]; return s / p; }); };
  function drawMain() {
    var cv = $('#chCv'); if (!cv || cv.getBoundingClientRect().width < 10) return;
    var f = fit(cv), ctx = f[0], W = f[1], H = f[2]; ctx.clearRect(0, 0, W, H);
    var gold = css('--gold'), up = css('--up'), dn = css('--dn'), grid = css('--grid'), dim = css('--dim'), cyan = css('--cyan'), blue = css('--blue'), panel = css('--panel');
    var d = CH, n = d.length; if (!n) { ctx.fillStyle = dim; ctx.font = G.font(13); ctx.textAlign = 'center'; ctx.fillText('Loading candles…', W / 2, H / 2); return; }
    var padL = 4, padR = 64, padT = 10, axB = 24, plotH = H - padT - axB;
    var closes = d.map(function (k) { return k.c; });
    var m20 = view.ma20 ? sma(closes, 20) : [], m50 = view.ma50 ? sma(closes, 50) : [];
    var lo = Infinity, hi = -Infinity;
    d.forEach(function (k) { lo = Math.min(lo, view.type === 'line' ? k.c : k.l); hi = Math.max(hi, view.type === 'line' ? k.c : k.h); });
    [m20, m50].forEach(function (a) { a.forEach(function (v) { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); });
    var pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    var py = function (v) { return padT + (hi - v) / (hi - lo) * plotH; };
    var cw = (W - padL - padR) / n, bw = Math.max(1.5, Math.min(12, cw * 0.62));
    ctx.font = G.font(11); ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.lineWidth = 1;
    for (var g = 0; g <= 5; g++) { var v = hi - (hi - lo) * g / 5, y = Math.round(py(v)) + 0.5; ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); ctx.fillStyle = dim; ctx.fillText(fmt(v, v > 1000 ? 0 : 1), W - padR + 8, y); }
    // time labels
    ctx.textAlign = 'center'; ctx.fillStyle = dim;
    var intraday = TF === '5M' || TF === '15M' || TF === '1H';
    for (var t = 0; t < 5; t++) { var i = Math.round((n - 1) * (t + 0.5) / 5), dt = new Date(d[i].t); ctx.fillText(intraday ? dt.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : dt.toLocaleDateString([], { month: 'short', day: 'numeric', year: TF === '1W' ? '2-digit' : undefined }), padL + cw * i + cw / 2, H - 9); }
    if (view.type === 'line') {
      var gr = ctx.createLinearGradient(0, padT, 0, padT + plotH); gr.addColorStop(0, gold); gr.addColorStop(1, 'transparent');
      ctx.save(); ctx.globalAlpha = 0.14; ctx.fillStyle = gr; ctx.beginPath();
      d.forEach(function (k, i) { var x = padL + cw * i + cw / 2; if (i) ctx.lineTo(x, py(k.c)); else ctx.moveTo(x, py(k.c)); });
      ctx.lineTo(padL + cw * (n - 1) + cw / 2, padT + plotH); ctx.lineTo(padL + cw / 2, padT + plotH); ctx.closePath(); ctx.fill(); ctx.restore();
      ctx.beginPath(); d.forEach(function (k, i) { var x = padL + cw * i + cw / 2; if (i) ctx.lineTo(x, py(k.c)); else ctx.moveTo(x, py(k.c)); });
      ctx.strokeStyle = gold; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke(); ctx.lineWidth = 1;
    } else {
      d.forEach(function (k, i) {
        var x = Math.round(padL + cw * i + cw / 2) + 0.5, u = k.c >= k.o;
        ctx.strokeStyle = ctx.fillStyle = u ? up : dn;
        ctx.beginPath(); ctx.moveTo(x, py(k.h)); ctx.lineTo(x, py(k.l)); ctx.stroke();
        var top = py(Math.max(k.o, k.c)), hgt = Math.max(1, py(Math.min(k.o, k.c)) - top);
        ctx.fillRect(x - bw / 2, top, bw, hgt);
      });
    }
    function drawMA(arr, col) { ctx.beginPath(); var st = false; arr.forEach(function (v, i) { if (v == null) return; var x = padL + cw * i + cw / 2; if (st) ctx.lineTo(x, py(v)); else ctx.moveTo(x, py(v)); st = true; }); ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1; }
    if (view.ma20) drawMA(m20, cyan); if (view.ma50) drawMA(m50, blue);
    if (B && B.gold) {
      var ly = py(B.gold.price);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = gold; ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - padR, ly); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = gold; var bx = W - padR + 2, bh = 22; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(bx, ly - bh / 2, padR - 4, bh, 6); else ctx.rect(bx, ly - bh / 2, padR - 4, bh); ctx.fill();
      ctx.fillStyle = panel; ctx.font = G.font(11.5, 600); ctx.textAlign = 'left'; ctx.fillText(fmt(B.gold.price, 1), bx + 6, ly + 0.5);
    }
    if (mouse.in) {
      var hi2 = Math.max(0, Math.min(n - 1, Math.floor((mouse.x - padL) / cw))), cx = padL + cw * hi2 + cw / 2;
      ctx.strokeStyle = dim; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH); ctx.stroke(); ctx.setLineDash([]);
      var k = d[hi2], dl = (k.c / k.o - 1) * 100, when = new Date(k.t);
      $('#chRead').innerHTML = '<span class="dim" style="margin-right:10px">' + (intraday ? when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : when.toLocaleDateString()) + '</span>Open <b>' + fmt(k.o, 1) + '</b> High <b>' + fmt(k.h, 1) + '</b> Low <b>' + fmt(k.l, 1) + '</b> Close <b>' + fmt(k.c, 1) + '</b> <b class="' + cls(dl) + '">' + sgn(dl) + fmt(dl, 2) + '%</b>';
    }
  }

  function renderAll() { renderTape(); renderHero(); renderWhy(); renderMiners(); renderCmp(); drawMain(); }
  function redraw() { drawMain(); renderMiners(); if (window.GK) GK.redraw(); }

  /* ---------- analyst ---------- */
  var busy = false;
  $('#runWhy').addEventListener('click', function () {
    if (busy || !B) return; busy = true;
    var btn = $('#runWhy'), out = $('#whyOut');
    btn.disabled = true; btn.textContent = 'Thinking…'; out.classList.remove('hide'); out.innerHTML = '<span class="hint">Asking the analyst…</span>';
    fetch('/api/ai/analyst', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (ai) { out.innerHTML = '<div class="eng">' + esc(ai.engine) + '</div><div class="ln">' + esc(ai.text) + '</div>'; })
      .catch(function (e) { out.textContent = 'The analyst is unavailable: ' + e.message; })
      .then(function () { btn.disabled = false; btn.textContent = 'Ask again'; busy = false; });
  });

  /* ---------- wiring ---------- */
  var cv = $('#chCv');
  cv.addEventListener('mousemove', function (e) { var r = cv.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.in = true; if (!rafQ) { rafQ = true; requestAnimationFrame(function () { rafQ = false; drawMain(); }); } });
  cv.addEventListener('mouseleave', function () { mouse.in = false; drawMain(); });
  $('#tfGrp').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
    TF = b.dataset.tf;
    getJSON('/api/candles?tf=' + TF).then(function (r) { CH = r.candles || []; drawMain(); }).catch(function () { });
  });
  $('#tCandle').addEventListener('click', function () { view.type = 'candle'; this.classList.add('on'); $('#tLine').classList.remove('on'); drawMain(); });
  $('#tLine').addEventListener('click', function () { view.type = 'line'; this.classList.add('on'); $('#tCandle').classList.remove('on'); drawMain(); });
  $('#tMa20').addEventListener('click', function () { view.ma20 = !view.ma20; this.classList.toggle('on'); drawMain(); });
  $('#tMa50').addEventListener('click', function () { view.ma50 = !view.ma50; this.classList.toggle('on'); drawMain(); });
  var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(drawMain, 150); });
  window.addEventListener('themechange', redraw);

  if (window.NewsFeed) NewsFeed.mount($('#newsBody'), { topic: 'gold', limit: 6 });
  if (window.Ideas) Ideas.mount($('#ideasBody'), { topic: 'gold', limit: 4 });
  if (window.Cal) Cal.mount($('#calBody'), { scope: 'gold' });

  /* ---------- init + polls ---------- */
  (function init(wait) {
    getJSON('/api/bootstrap?tf=15M').then(function (b) {
      B = b; CH = b.candles || [];
      try { renderAll(); } catch (e) { $('#status .mid').textContent = 'Render error: ' + e.message; }
      if (b.stale) $('#status .mid').textContent = 'Showing the last good data while sources retry.';
      getJSON('/api/candles?tf=' + TF).then(function (r) { CH = r.candles || CH; drawMain(); }).catch(function () { });
      getJSON('/api/ml/history').then(function (h) { renderML(h.rows || []); }).catch(function () { renderML([]); });
    }).catch(function (e) {
      $('#status .mid').textContent = 'Data temporarily unavailable (' + e.message + '). Retrying in ' + Math.round(wait / 1000) + ' s.';
      setTimeout(function () { init(Math.min(wait * 2, 30000)); }, wait);
    });
  })(4000);
  setInterval(function () {
    if (document.hidden || !B) return;
    getJSON('/api/bootstrap?tf=15M').then(function (b) { B = b; renderTape(); renderHero(); renderWhy(); renderMiners(); renderCmp(); drawMain(); }).catch(function () { });
  }, 60000);
  setInterval(function () {
    if (document.hidden || !B) return;
    getJSON('/api/quote').then(function (q) {
      if (isFinite(q.gold) && B.gold.prevClose) { B.gold.price = q.gold; B.gold.change = q.gold - B.gold.prevClose; B.gold.changePct = (q.gold / B.gold.prevClose - 1) * 100; }
      renderHero(); drawMain();
    }).catch(function () { });
  }, 20000);
})();
