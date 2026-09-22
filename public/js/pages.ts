/* ================================================================
   GIT/4.2.26 - SHARED PAGE RUNTIME (ENERGY + AGRI desks)
   Renders /api/page/{type} + /api/candles. Theme-aware. ASCII only.
   ================================================================ */
(function () {
'use strict';
const $ = s => document.querySelector(s);
const fmt = (n, d = 2) => (n == null || isNaN(n)) ? '--' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sgn = n => (n > 0 ? '+' : '');
const cls = v => (v ?? 0) >= 0 ? 'up' : 'dn';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => { try { const x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : '#'; } catch { return '#'; } };
const C = window.PAGE_CONFIG || { type: 'energy', api: '/api/page/energy', sym: 'CL1', heroUnit: '$/BBL' };

let D = null, CH = [], TF = '1D';

async function getJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

function tick() { const el = $('#clock'); if (el) el.textContent = new Date().toLocaleTimeString('en-GB'); }
setInterval(tick, 1000); tick();

/* ---------------- renderers ---------------- */
function renderTape() {
  const h = (D && D.tape ? D.tape : []).map(t => {
    const ch = t.changePct ?? 0, dg = t.price > 500 ? 1 : (t.price > 20 ? 2 : 3);
    return '<span class="tg"><span class="k">' + esc(t.symbol) + '</span><span class="v">' + fmt(t.price, dg) + '</span><span class="c ' + cls(ch) + '">' + (ch >= 0 ? 'UP ' : 'DN ') + sgn(ch) + fmt(Math.abs(ch), 2) + '%</span></span>';
  }).join('');
  const a = $('#tapeA'), b = $('#tapeB'); if (a) a.innerHTML = h; if (b) b.innerHTML = h;
}
function renderHero() {
  if (!D || !D.hero) return;
  const g = D.hero, c = g.change ?? 0, p = g.changePct ?? 0;
  $('#px').textContent = fmt(g.price);
  const bc = $('#pxc'); bc.className = 'bigchg ' + cls(p);
  bc.innerHTML = (c >= 0 ? '+ ' : '- ') + fmt(Math.abs(c)) + '  (' + sgn(p) + fmt(p) + '%)';
  $('#meta').textContent = (g.name || g.symbol).toUpperCase() + ' - ' + (g.unit || C.heroUnit || '');
  $('#prov').textContent = String(g.source).toUpperCase() + ' - ' + (g.delay === 'simulated' ? 'SIM' : 'NEAR LIVE');
  const chip = $('#chip'); if (chip) { chip.textContent = g.delay === 'simulated' ? 'SIM' : 'NEAR LIVE'; chip.className = 'chip ' + (g.delay === 'simulated' ? 'ai' : 'near'); }
  $('#oo').textContent = fmt(g.open); $('#oh').textContent = fmt(g.high); $('#ol').textContent = fmt(g.low); $('#op').textContent = fmt(g.prevClose);
  $('#obid').textContent = fmt(g.bid); $('#oask').textContent = fmt(g.ask);
  if (g.high && g.low && g.high > g.low) $('#rmark').style.left = Math.round((g.price - g.low) / (g.high - g.low) * 100) + '%';
}
function renderMonitor() {
  $('#monTb').innerHTML = (D && D.monitor ? D.monitor : []).filter(q => q.symbol !== 'XAU:USD' && q.symbol !== 'DXY').map(q => {
    const ch = q.changePct ?? 0;
    return '<tr><td><b>' + esc(q.symbol) + '</b></td><td class="mut">' + esc(q.name || '') + '</td><td class="r"><b>' + fmt(q.price, q.price > 100 ? 2 : 3) + '</b></td><td class="r ' + cls(ch) + '">' + sgn(ch) + fmt(ch, 2) + '%</td><td class="r mut">' + esc(q.unit || '') + '</td><td class="r mut">' + esc(String(q.source).split('(')[0]) + '</td></tr>';
  }).join('');
}
function renderSpot() {
  $('#spots').innerHTML = (D && D.spotlights ? D.spotlights : []).map(s =>
    '<div class="hc"><div class="t">' + esc(s.symbol) + '</div><div class="p">' + esc(s.note || '') + '</div><div class="c ' + cls(s.changePct) + '">' + sgn(s.changePct) + fmt(s.changePct, 2) + '%</div><div class="p" style="margin-top:3px">' + fmt(s.price, 2) + '</div></div>').join('');
  $('#ratios').innerHTML = (D && D.ratios ? D.ratios : []).map(r =>
    '<div class="hc"><div class="t">' + esc(r.label) + '</div><div class="c gold">' + fmt(r.value, 1) + '</div><div class="p">' + esc(r.unit) + '</div></div>').join('');
  $('#spreads').innerHTML = (D && D.spreads && D.spreads.length ? D.spreads : []).map(s =>
    '<div class="bi"><span class="n">' + esc(s.label) + '</span><span class="gold">' + esc(s.value) + '</span><span class="dim" style="justify-self:end;font-size:9px">' + (s.change ? esc(s.change) : '') + '</span></div>').join('') || '<div class="bi"><span class="dim">--</span></div>';
}
function renderExtra() {
  const eb = $('#extraBody'); if (!eb || !D) return;
  if (C.type === 'energy') {
    eb.innerHTML = (D.eia && D.eia.length)
      ? '<table class="tb"><thead><tr><th>EIA SERIES</th><th class="r">VALUE</th><th class="r">CHG</th><th class="r">AS OF</th></tr></thead><tbody>' +
        D.eia.map(r => '<tr><td>' + esc(r.label) + '</td><td class="r"><b>' + fmt(r.value, 1) + '</b> <span class="dim">' + esc(r.unit) + '</span></td><td class="r ' + (-(r.change ?? 0) >= 0 ? 'up' : 'dn') + '">' + (r.change == null ? '--' : sgn(r.change) + fmt(r.change, 1)) + '</td><td class="r mut">' + esc(r.asOf) + '</td></tr>').join('') +
        '</tbody></table><div class="footnote">EIA WEEKLY - STOCKS DRAW = TIGHTER SUPPLY</div>'
      : '<div class="footnote">EIA PENDING - check EIA_API_KEY + series IDs (verify at eia.gov)</div>';
  } else {
    let h = '';
    if (D.water) {
      h += '<h6 class="secH">WATER - NQH2O + USGS</h6>';
      if (D.water.nqH2o) {
        const chg = D.water.nqH2o.value - D.water.nqH2o.prior;
        h += '<div class="bi"><span class="n">CA WATER IDX</span><span class="' + cls(chg) + '">' + sgn(chg) + fmt(chg, 0) + ' $/AF</span><span class="gold" style="justify-self:end">' + fmt(D.water.nqH2o.value, 0) + '</span></div>';
      }
      for (const l of (D.water.levels || [])) {
        h += '<div class="bi"><span class="n">' + esc(l.name) + '</span><span class="cyan">' + fmt(l.gageFt, 2) + ' ft</span><span class="dim" style="justify-self:end;font-size:8px">GAUGE - INDICATOR</span></div>';
      }
      h += '<div class="footnote">NQH2O VIA FRED - USGS NWIS GAUGES = RIVER INDICATORS, NOT LAKE % CAPACITY</div>';
    }
    if (D.weather) {
      const w = D.weather;
      h += '<h6 class="secH" style="margin-top:10px">WEATHER - S. PLAINS (OPEN-METEO)</h6>';
      h += '<div class="bi"><span class="n">NOW</span><span class="cyan">' + fmt(w.tempC, 0) + 'C / ' + fmt(w.windKph, 0) + ' km/h</span><span class="dim" style="justify-self:end;font-size:8px">LIVE - NO KEY</span></div>';
      h += (w.daily || []).slice(0, 5).map(d =>
        '<div class="bi"><span class="n">' + esc(d.date.slice(5)) + '</span><span class="mut">' + fmt(d.tmin, 0) + '-' + fmt(d.tmax, 0) + 'C</span><span class="' + (d.precip > 1 ? 'cyan' : 'dim') + '" style="justify-self:end">' + fmt(d.precip, 1) + 'mm</span></div>').join('');
    }
    if (!h) h = '<div class="footnote">WATER / WEATHER PENDING FIRST CRON</div>';
    eb.innerHTML = h;
  }
}
function renderNews() {
  $('#nwList').innerHTML = (D && D.news ? D.news : []).map(n => {
    const sc = n.sentiment === 'bull' ? 'b' : (n.sentiment === 'bear' ? 's' : 'n');
    const st = n.sentiment === 'bull' ? 'BULL' : (n.sentiment === 'bear' ? 'BEAR' : 'NEUT');
    const link = (n.url && n.url !== '#') ? '<a href="' + esc(safeUrl(n.url)) + '" target="_blank" rel="noopener noreferrer">OPEN</a>' : 'SIM';
    return '<li><time>' + new Date(n.publishedTs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</time><span class="tag">' + esc(n.source) + '</span><p>' + esc(n.title) + '</p><span class="sent ' + sc + '">' + st + '</span><div class="sum">// ' + esc(n.sentimentNote) + ' - ' + link + '</div></li>';
  }).join('') || '<li><span class="dim">NO NEWS YET</span></li>';
}
function renderCal() {
  $('#calTb').innerHTML = (D && D.calendar ? D.calendar : []).map(c =>
    '<tr><td class="mut">' + esc(c.when) + '</td><td>' + esc(c.event) + '</td><td class="r dim">' + esc(c.note) + '</td></tr>').join('');
}
function renderAll() { renderTape(); renderHero(); renderMonitor(); renderSpot(); renderExtra(); renderNews(); renderCal(); }

/* ---------------- chart ---------------- */
function fit(cv) { const r = cv.getBoundingClientRect(); const d = Math.min(window.devicePixelRatio || 1, 2); cv.width = Math.max(1, Math.round(r.width * d)); cv.height = Math.max(1, Math.round(r.height * d)); const ctx = cv.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0); return [ctx, r.width, r.height]; }
let hoverX = -1;
function drawChart() {
  const cv = $('#chCv'); if (!cv || cv.getBoundingClientRect().width < 10) return;
  const f = fit(cv), ctx = f[0], W = f[1], H = f[2]; ctx.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.body);
  const gold = cs.getPropertyValue('--gold').trim(), up = cs.getPropertyValue('--up').trim(), dn = cs.getPropertyValue('--dn').trim(), grid = cs.getPropertyValue('--grid').trim(), mut = cs.getPropertyValue('--mut').trim();
  const d = CH, n = d.length; if (!n) return;
  const padL = 6, padR = 58, padT = 8, axB = 16, volH = 44;
  const plotH = H - padT - axB - volH;
  let lo = Infinity, hi = -Infinity; d.forEach(k => { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); });
  const pad = (hi - lo) * .05; lo -= pad; hi += pad;
  const py = v => padT + (hi - v) / (hi - lo) * plotH, cw = (W - padL - padR) / n, bw = Math.max(1.5, cw * .62);
  const ma = a => a.map((_, i) => i < 19 ? null : a.slice(i - 19, i + 1).reduce((s, v) => s + v, 0) / 20);
  const m20 = ma(d.map(k => k.c));
  ctx.font = '9px IBM Plex Mono'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.setLineDash([3, 3]); ctx.strokeStyle = grid; ctx.fillStyle = mut;
  for (let g = 0; g <= 4; g++) { const v = hi - (hi - lo) * g / 4, y = py(v); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); ctx.fillText(fmt(v, 1), W - padR + 5, y); }
  ctx.setLineDash([]);
  let vmax = 1; d.forEach(k => vmax = Math.max(vmax, k.v || 0));
  d.forEach((k, i) => { const h = (k.v || 0) / vmax * (volH - 8), x = padL + cw * i + (cw - bw) / 2; ctx.fillStyle = k.c >= k.o ? 'rgba(19,217,126,.3)' : 'rgba(255,79,94,.3)'; ctx.fillRect(x, H - axB - h, bw, h); });
  d.forEach((k, i) => { const x = padL + cw * i + cw / 2, u = k.c >= k.o; ctx.strokeStyle = ctx.fillStyle = u ? up : dn; ctx.beginPath(); ctx.moveTo(x, py(k.h)); ctx.lineTo(x, py(k.l)); ctx.stroke(); ctx.fillRect(x - bw / 2, py(Math.max(k.o, k.c)), bw, Math.max(1, py(Math.min(k.o, k.c)) - py(Math.max(k.o, k.c)))); });
  ctx.beginPath(); let st = false; m20.forEach((v, i) => { if (v == null) return; const x = padL + cw * i + cw / 2; st ? ctx.lineTo(x, py(v)) : ctx.moveTo(x, py(v)); st = true; }); ctx.strokeStyle = '#2fd6e8'; ctx.lineWidth = 1.1; ctx.stroke(); ctx.lineWidth = 1;
  const last = d[n - 1].c, ly = py(last);
  ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(255,179,0,.8)'; ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - padR, ly); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = gold; ctx.fillRect(W - padR + 1, ly - 8, padR - 4, 16); ctx.fillStyle = '#000'; ctx.fillText(fmt(last, 1), W - padR + 5, ly);
  if (hoverX >= 0) {
    const i = Math.max(0, Math.min(n - 1, Math.floor((hoverX - padL) / cw))); const x = padL + cw * i + cw / 2;
    ctx.setLineDash([2, 3]); ctx.strokeStyle = mut; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - axB); ctx.stroke(); ctx.setLineDash([]);
    const k = d[i], dl = (k.c / k.o - 1) * 100;
    $('#chRead').innerHTML = esc(C.sym) + ' - ' + new Date(k.t).toLocaleDateString('en-GB') + ' O <b>' + fmt(k.o, 2) + '</b> H <b>' + fmt(k.h, 2) + '</b> L <b>' + fmt(k.l, 2) + '</b> C <b>' + fmt(k.c, 2) + '</b> <b class="' + (dl >= 0 ? 'up' : 'dn') + '">' + sgn(dl) + fmt(dl, 2) + '%</b>';
  }
}
document.addEventListener('mousemove', e => { const cv = $('#chCv'); if (!cv) return; const r = cv.getBoundingClientRect(); hoverX = (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) ? e.clientX - r.left : -1; drawChart(); });

/* ---------------- tf buttons ---------------- */
document.querySelectorAll('[data-tf]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('[data-tf]').forEach(x => x.classList.remove('on')); b.classList.add('on');
  TF = b.dataset.tf;
  getJSON('/api/candles?sym=' + encodeURIComponent(C.sym) + '&tf=' + TF).then(r => { CH = r.candles || []; drawChart(); }).catch(() => { });
}));

/* ---------------- init + poll ---------------- */
async function loadAll() {
  try { D = await getJSON(C.api); renderAll(); }
  catch (e) { const s = $('#status .mid'); if (s) s.textContent = 'API ERROR - ' + String(e && e.message || e); }
  try { const r = await getJSON('/api/candles?sym=' + encodeURIComponent(C.sym) + '&tf=' + TF); CH = r.candles || []; drawChart(); } catch (e) { }
}
loadAll();
setInterval(() => { if (!document.hidden) loadAll(); }, 60000);
let rzT; window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(drawChart, 150); });

/* ---------------- theme (shared with home) ---------------- */
(function () {
  let mode = localStorage.getItem('git-theme') || 'auto';
  const isDay = () => mode === 'day' || (mode === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
  const apply = () => {
    document.body.classList.toggle('day', isDay());
    const b = document.getElementById('themeBtn');
    if (b) b.textContent = 'AUTO/' + (mode === 'auto' ? 'SYS' : mode.toUpperCase());
    try { drawChart(); } catch (e) { }
  };
  const b = document.getElementById('themeBtn');
  if (b) b.addEventListener('click', () => { mode = mode === 'auto' ? 'day' : (mode === 'day' ? 'night' : 'auto'); localStorage.setItem('git-theme', mode); apply(); });
  try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (mode === 'auto') apply(); }); } catch (e) { }
  apply();
})();
})();
