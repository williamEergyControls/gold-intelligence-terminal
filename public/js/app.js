/* GOLD INTELLIGENCE TERMINAL — frontend runtime.
   The browser NEVER talks to a market API. It polls /api/bootstrap (1 request / 30s)
   and renders normalized JSON. Simulation (if any) comes from the Worker, labeled SIM. */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const fmt = (n, d = 2) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const sgn = n => (n > 0 ? '+' : '');
const CHIP = { realtime: ['LIVE', 'live'], 'near-live': ['NEAR LIVE', 'near'], delayed: ['DELAYED', 'month'], eod: ['EOD', 'month'], daily: ['DAILY', 'month'], monthly: ['MONTHLY', 'month'], reference: ['REFERENCE', 'month'], 'event-driven': ['EVENT', 'evt'], simulated: ['SIM', 'ai'] };
const ageStr = ms => { const s = Math.max(0, Math.floor(ms / 1e3)); return s < 90 ? s + 's' : s < 5400 ? Math.floor(s / 60) + 'm' : Math.floor(s / 86400) + 'd'; };

let B = null;                       // bootstrap payload (source of truth)
const CH = { candles: [], tf: '15M' };
const view = { type: 'candle', ma20: true, ma50: true, vol: true };
const mouse = { x: 0, y: 0, in: false }; let rafQ = false;
const registry = [];                // canvas redraw fns

async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

/* ================= BOOT ================= */
async function bootSeq(mode) {
  const box = $('#bootLines'); if (!box) return;
  const L = ['GIT/4.2.26 — GOLD INTELLIGENCE TERMINAL', '', `FEED MODE .......... ${mode === 'live' ? 'LIVE SOURCES' : 'SIMULATED PREVIEW (no keys / upstream down)'}`,
    'API HANDSHAKE ...... /api/bootstrap OK', 'KV CACHE ........... WARM', 'RENDER ............. HI-DPI · CRT MASK', '', 'READY.'];
  for (let i = 0; i < L.length; i++) { const d = document.createElement('div'); d.textContent = L[i]; box.appendChild(d); await new Promise(r => setTimeout(r, 90)); }
  await new Promise(r => setTimeout(r, 400));
  const b = $('#boot'); if (b) { b.classList.add('off'); setTimeout(() => b.remove(), 520); }
}

/* ================= INIT ================= */
(async function init() {
  try { B = await getJSON('/api/bootstrap?tf=15M'); }
  catch (e) {
    document.getElementById('bootLines').innerHTML = `<div style="color:#ff4f5e">API UNREACHABLE — is the Worker running? (npm run dev)</div>`;
    return;
  }
  CH.candles = B.candles;
  $('#status .mid').textContent = B.mode === 'live'
    ? `LIVE · SOURCES: ${B.health.filter(h => h.status === 'online').map(h => h.name).join(' / ')} · NO KEY EVER SHIPS IN FRONTEND`
    : 'SIMULATED PREVIEW — configure API keys to go live (docs/MANUAL_SETUP.md) · NO FAKE "LIVE" LABELS';
  await bootSeq(B.mode);
  renderAll(); wireUI(); startClock(); startPoll();
})();

/* ================= RENDER: EVERYTHING ================= */
function renderAll() {
  setChip('#p-gold', B.gold.delay, `${B.gold.source} · <span data-ageq="gold">…</span>`);
  setChip('#p-chart', B.gold.delay, `${B.gold.source}`);
  renderHero(); renderTape(); drawMain(); drawSpark();
  renderHeatmap(); renderMinis(); renderInflation(); renderRE(); renderFX();
  renderAlerts(); renderNews(); renderReference(); renderHealth(); renderWhy(); myIdxCalc(); tickAges();
}
function setChip(sel, delay, srcText) {
  const p = $(sel); if (!p) return;
  const chip = p.querySelector('.chip'); const [label, cls] = CHIP[delay] ?? ['?', ''];
  if (chip) { chip.textContent = label; chip.className = 'chip ' + cls; }
  const src = p.querySelector('.src'); if (src && srcText) src.innerHTML = srcText;
}
function renderHero() {
  const g = B.gold;
  $('#bigPx').textContent = fmt(g.price);
  const c = g.change ?? 0, pct = g.changePct ?? 0;
  const bc = $('#bigChg'); bc.className = 'bigchg ' + (c >= 0 ? 'up' : 'dn');
  bc.innerHTML = `${c >= 0 ? '▲ +' : '▼ '}${fmt(Math.abs(c))}&nbsp;&nbsp;(${sgn(pct)}${fmt(pct)}%)`;
  $('#bid').textContent = fmt(g.price - 0.3); $('#ask').textContent = fmt(g.price + 0.3);
  $('#oc').textContent = fmt(g.price, 1);
  if (g.high) $('#oh').textContent = fmt(g.high, 1);
  if (g.low && g.high) $('#rmark').style.left = Math.round((g.price - g.low) / (g.high - g.low) * 100) + '%';
  if (B.ratio) { $('#ratioV').textContent = fmt(B.ratio, 1); $('#ratioLast').textContent = fmt(B.ratio, 1); }
  const a = B.analytics;
  $('.regime').innerHTML = `REGIME ▸ <b class="gold">${a.label}</b> · MOM <b>${a.scores.momentum}</b> · TREND <b>${a.scores.trend}</b> · VOL-RISK <b>${a.scores.volatilityRisk}</b> · SRC <b>${a.source}</b>`;
}
function renderTape() {
  const h = B.tape.map(t => {
    const ch = t.changePct ?? 0, cls = ch >= 0 ? 'up' : 'dn', arw = ch >= 0 ? '▲' : '▼';
    const d = t.price > 500 ? 1 : t.price > 20 ? 2 : 4;
    return `<span class="tg"><span class="k">${t.symbol}</span><span class="v${t.symbol.startsWith('XAU') ? ' g' : ''}">${fmt(t.price, d)}${t.currency === '%' ? '%' : ''}</span><span class="c ${cls}">${arw}${sgn(ch)}${fmt(Math.abs(ch), 2)}${t.currency === '%' ? 'bp' : '%'}</span></span>`;
  }).join('');
  $('#tapeA').innerHTML = h; $('#tapeB').innerHTML = h;
}

/* ---------- candle chart (canvas, crosshair, studies) ---------- */
function fit(cv) { const r = cv.getBoundingClientRect(); const d = Math.min(window.devicePixelRatio || 1, 2); cv.width = Math.max(1, r.width * d); cv.height = Math.max(1, r.height * d); const ctx = cv.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0); return [ctx, r.width, r.height]; }
const sma = (a, p) => a.map((_, i) => i < p - 1 ? null : a.slice(i - p + 1, i + 1).reduce((s, v) => s + v, 0) / p);
function drawMain() {
  const cv = $('#chCv'); if (!cv || cv.getBoundingClientRect().width === 0) return;
  const [ctx, W, H] = fit(cv); ctx.clearRect(0, 0, W, H);
  const d = CH.candles, n = d.length; if (!n) return;
  const padL = 6, padR = 64, padT = 8, axB = 18, volH = view.vol ? 54 : 8;
  const plotW = W - padL - padR, plotH = H - padT - axB - volH, volTop = H - axB - volH + 6, volHh = volH - 12;
  const m20 = view.ma20 ? sma(d.map(c => c.c), 20) : [], m50 = view.ma50 ? sma(d.map(c => c.c), 50) : [];
  let lo = Infinity, hi = -Infinity;
  d.forEach(k => { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); });
  [m20, m50].forEach(a => a.forEach(v => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
  const pad = (hi - lo) * .05; lo -= pad; hi += pad;
  const py = v => padT + (hi - v) / (hi - lo) * plotH;
  const cw = plotW / n, bw = Math.max(1.5, cw * .62);
  ctx.font = '9px IBM Plex Mono'; ctx.textBaseline = 'middle';
  ctx.setLineDash([3, 3]); ctx.strokeStyle = '#161c21'; ctx.fillStyle = '#59636c'; ctx.textAlign = 'left';
  for (let g = 0; g <= 5; g++) { const v = hi - (hi - lo) * g / 5, y = py(v); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); ctx.fillText(fmt(v, 1), W - padR + 6, y); }
  const stepI = Math.ceil(n / 8), stepMs = (d[1]?.t - d[0]?.t) || 36e5;
  for (let i = 0; i < n; i += stepI) { const x = padL + cw * i + cw / 2; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - axB); ctx.stroke(); ctx.textAlign = 'center'; ctx.fillStyle = '#4d565e'; ctx.fillText(new Date(d[i].t).toLocaleString('en-GB', stepMs >= 864e5 ? { day: '2-digit', month: 'short' } : { hour: '2-digit', minute: '2-digit' }), x, H - axB + 8); ctx.textAlign = 'left'; ctx.fillStyle = '#59636c'; }
  ctx.setLineDash([]);
  if (view.vol) { const vmax = Math.max(...d.map(k => k.v ?? 0), 1); d.forEach((k, i) => { const h = (k.v ?? 0) / vmax * volHh, x = padL + cw * i + (cw - bw) / 2; ctx.fillStyle = k.c >= k.o ? 'rgba(19,217,126,.32)' : 'rgba(255,79,94,.32)'; ctx.fillRect(x, volTop + volHh - h, bw, h); }); }
  if (view.type === 'candle') {
    d.forEach((k, i) => { const x = padL + cw * i + cw / 2, up = k.c >= k.o; ctx.strokeStyle = ctx.fillStyle = up ? '#13d97e' : '#ff4f5e'; ctx.beginPath(); ctx.moveTo(x, py(k.h)); ctx.lineTo(x, py(k.l)); ctx.stroke(); const y1 = py(Math.max(k.o, k.c)), y2 = py(Math.min(k.o, k.c)); ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1)); });
  } else {
    ctx.beginPath(); d.forEach((k, i) => { const x = padL + cw * i + cw / 2; i ? ctx.lineTo(x, py(k.c)) : ctx.moveTo(x, py(k.c)); });
    ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 1.6; ctx.stroke(); ctx.lineWidth = 1;
    ctx.lineTo(padL + plotW, py(d[n - 1].c)); ctx.lineTo(padL + cw / 2, py(d[n - 1].c)); ctx.closePath(); ctx.fillStyle = 'rgba(255,179,0,.06)'; ctx.fill();
  }
  const drawMA = (arr, col) => { ctx.beginPath(); let st = false; arr.forEach((v, i) => { if (v == null) return; const x = padL + cw * i + cw / 2, y = py(v); st ? ctx.lineTo(x, y) : ctx.moveTo(x, y); st = true; }); ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.stroke(); ctx.lineWidth = 1; };
  if (view.ma20) drawMA(m20, '#2fd6e8'); if (view.ma50) drawMA(m50, '#4f9cf9');
  const ly = py(B.gold.price);
  ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(255,179,0,.85)'; ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - padR, ly); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#ffb300'; ctx.fillRect(W - padR + 1, ly - 8, padR - 4, 16); ctx.fillStyle = '#000'; ctx.fillText(fmt(B.gold.price, 1), W - padR + 6, ly);
  let hi2 = n - 1;
  if (mouse.in) {
    hi2 = Math.max(0, Math.min(n - 1, Math.floor((mouse.x - padL) / cw))); const cx = padL + cw * hi2 + cw / 2;
    ctx.setLineDash([4, 4]); ctx.strokeStyle = '#77828b'; ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, H - axB); ctx.stroke(); ctx.beginPath(); ctx.moveTo(padL, mouse.y); ctx.lineTo(W - padR, mouse.y); ctx.stroke(); ctx.setLineDash([]);
    const hv = hi - (mouse.y - padT) / plotH * (hi - lo);
    ctx.fillStyle = '#1a2026'; ctx.fillRect(W - padR + 1, mouse.y - 8, padR - 4, 16); ctx.strokeStyle = '#2b3540'; ctx.strokeRect(W - padR + 1, mouse.y - 8, padR - 4, 16); ctx.fillStyle = '#e6edf2'; ctx.fillText(fmt(hv, 1), W - padR + 6, mouse.y);
  }
  const k = d[hi2], dl = (k.c / k.o - 1) * 100, r20 = m20[hi2], r50 = m50[hi2];
  $('#chLast').textContent = fmt(B.gold.price); const cc = $('#chChg'); cc.textContent = sgn(B.gold.changePct) + fmt(B.gold.changePct) + '%'; cc.className = (B.gold.changePct ?? 0) >= 0 ? 'up' : 'dn';
  $('#chRead').innerHTML = `${new Date(k.t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} ▸ O <b>${fmt(k.o, 1)}</b> · H <b>${fmt(k.h, 1)}</b> · L <b>${fmt(k.l, 1)}</b> · C <b>${fmt(k.c, 1)}</b> <b class="${dl >= 0 ? 'up' : 'dn'}">(${sgn(dl)}${fmt(dl, 2)}%)</b> · MA20 <b class="cyan">${r20 != null ? fmt(r20, 1) : '—'}</b> · MA50 <b class="blue">${r50 != null ? fmt(r50, 1) : '—'}</b>`;
}
registry.push(drawMain);
function drawSpark() {
  const cv = $('#sparkCv'); if (!cv) return; const [ctx, W, H] = fit(cv); ctx.clearRect(0, 0, W, H);
  const d = CH.candles.slice(-90).map(c => c.c); if (d.length < 2) return;
  const lo = Math.min(...d) - 4, hi = Math.max(...d) + 4;
  const px = i => 6 + (W - 12) * i / (d.length - 1), py = v => 5 + (H - 10) * (1 - (v - lo) / (hi - lo));
  ctx.beginPath(); d.forEach((v, i) => { i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v)); }); ctx.lineTo(px(d.length - 1), H); ctx.lineTo(px(0), H); ctx.closePath(); ctx.fillStyle = 'rgba(255,179,0,.07)'; ctx.fill();
  ctx.beginPath(); d.forEach((v, i) => { i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v)); }); ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 1.4; ctx.stroke();
}
registry.push(drawSpark);

/* ---------- heatmap ---------- */
function renderHeatmap() {
  const hm = $('#hm'); hm.innerHTML = '';
  const tip = $('#tip');
  B.miners.forEach(m => {
    const c = m.changePct ?? 0, a = 0.08 + Math.min(1, Math.abs(c) / 3) * 0.34;
    const el = document.createElement('div'); el.className = 'hc';
    el.style.background = c >= 0 ? `rgba(19,217,126,${a})` : `rgba(255,79,94,${a})`;
    el.innerHTML = `<div class="t">${m.symbol}</div><div class="p">${fmt(m.price, 2)}</div><div class="c ${c >= 0 ? 'up' : 'dn'}">${c >= 0 ? '▲' : '▼'}${fmt(Math.abs(c), 2)}%</div>`;
    el.addEventListener('mousemove', e => {
      tip.style.display = 'block';
      tip.innerHTML = `<div class="th">${m.name ?? m.symbol} · ${m.symbol}</div>
        <div class="tr"><span>LAST</span><b>${fmt(m.price, 2)}</b></div>
        <div class="tr"><span>CHG</span><b class="${c >= 0 ? 'up' : 'dn'}">${sgn(c)}${fmt(c, 2)}%</b></div>
        <div class="tr"><span>SOURCE</span><b>${m.source}</b></div>
        <div class="tr"><span>DATA TYPE</span><b>${CHIP[m.delay]?.[0] ?? m.delay}</b></div>
        <div class="tf">PROVENANCE: ${m.source} · ${ageStr(Date.now() - m.ts)} OLD</div>`;
      let x = e.clientX + 16, y = e.clientY + 14; if (x + 220 > innerWidth) x = e.clientX - 230; if (y + 150 > innerHeight) y = e.clientY - 150;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    });
    el.addEventListener('mouseleave', () => tip.style.display = 'none');
    el.addEventListener('click', () => { $$('.hc').forEach(x => x.classList.remove('sel')); el.classList.add('sel'); $('#hmFocus').innerHTML = `FOCUS ▸ <b>${m.name ?? m.symbol} (${m.symbol})</b> ${fmt(m.price, 2)} <b class="${c >= 0 ? 'up' : 'dn'}">${sgn(c)}${fmt(c, 2)}%</b> · ${m.source} · ${CHIP[m.delay]?.[0]}`; });
    hm.appendChild(el);
  });
}

/* ---------- mini relationship charts ---------- */
function makeMini(cvId, readId, series, opts = {}) {
  const cv = document.getElementById(cvId), read = readId ? document.getElementById(readId) : null;
  const st = { h: -1 };
  function draw() {
    if (!cv || cv.getBoundingClientRect().width === 0) return;
    const [ctx, W, H] = fit(cv); ctx.clearRect(0, 0, W, H);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = '#151b20';
    for (let g = 1; g < 4; g++) { const y = H * g / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.setLineDash([]);
    if (opts.thresh != null) { const y = H - 6 - (H - 12) * 0.5; ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(47,214,232,.5)'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = '#2fd6e8'; ctx.font = '8px IBM Plex Mono'; ctx.fillText(String(opts.thresh), W - 24, y - 4); }
    series.forEach(s => {
      const d = s.data; if (!d || d.length < 2) return;
      const lo = Math.min(...d), hi = Math.max(...d), rg = (hi - lo) || 1;
      const px = i => 4 + (W - 8) * i / (d.length - 1), py = v => 6 + (H - 12) * (1 - (v - lo) / rg);
      ctx.beginPath(); d.forEach((v, i) => { i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v)); });
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; if (s.dash) ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
      ctx.fillStyle = s.color; ctx.fillRect(px(d.length - 1) - 2, py(d[d.length - 1]) - 2, 4, 4);
    });
    if (st.h >= 0 && series[0]?.data?.length) {
      const n = series[0].data.length, i = Math.max(0, Math.min(n - 1, Math.round((st.h - 4) / Math.max(1, W - 8) * (n - 1))));
      const x = 4 + (W - 8) * i / (n - 1);
      ctx.setLineDash([2, 3]); ctx.strokeStyle = '#77828b'; ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, H - 2); ctx.stroke(); ctx.setLineDash([]);
      if (read) read.textContent = 'IDX ' + String(i).padStart(2, '0') + ' ▸ ' + series.map(s => `${s.name} ${fmt(s.data?.[i], 1)}`).join(' · ');
    } else if (read) read.textContent = opts.base || 'HOVER FOR INDEXED READOUT';
  }
  if (cv) { cv.addEventListener('mousemove', e => { const r = cv.getBoundingClientRect(); st.h = e.clientX - r.left; draw(); }); cv.addEventListener('mouseleave', () => { st.h = -1; draw(); }); }
  registry.push(draw); draw();
}
function renderMinis() {
  makeMini('cvDxy', 'rdDxy', [{ name: 'GOLD', data: B.series.goldIdx, color: '#ffb300' }, { name: 'DXY', data: B.series.dxyIdx, color: '#2fd6e8', dash: 1 }]);
  makeMini('cvRy', 'rdRy', [{ name: 'GOLD', data: B.series.goldIdx, color: '#ffb300' }, { name: 'RY', data: B.series.ryIdx, color: '#4f9cf9', dash: 1 }]);
  makeMini('cvAux', 'rdAux', [{ name: 'XAU/XAG', data: B.series.ratio, color: '#ffb300' }], { thresh: 100 });
  if (B.corr.dxy != null) $('#corrDxy').textContent = B.corr.dxy.toFixed(2);
  if (B.corr.ry != null) $('#corrRy').textContent = B.corr.ry.toFixed(2);
}

/* ---------- inflation / real economy ---------- */
function renderInflation() {
  setChip('#p-infl', 'monthly', 'BLS · FRED');
  const tb = $('#inflTb'); tb.innerHTML = '';
  B.macro.rows.forEach(r => {
    const d = r.value - r.prior;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.label}</td><td class="r"><b>${fmt(r.value, 1)}${r.unit === 'pct' ? '%' : r.unit === 'bp' ? '%' : ''}</b></td><td class="r mut">${fmt(r.prior, 1)}</td><td class="r ${d < 0 ? 'up' : d > 0 ? 'dn' : 'mut'}">${d === 0 ? '—' : (d < 0 ? '▼' : '▲') + fmt(Math.abs(d), 1) + 'pp'}</td>`;
    const td = document.createElement('td'); td.style.width = '68px';
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 14; cv.style.display = 'block'; td.appendChild(cv);
    const draw = () => { const [ctx, W, H] = fit(cv); ctx.clearRect(0, 0, W, H); const dta = r.spark; const lo = Math.min(...dta), hi = Math.max(...dta), rg = (hi - lo) || 1; ctx.beginPath(); dta.forEach((v, i) => { const x = 1 + (W - 2) * i / (dta.length - 1), y = 1 + (H - 2) * (1 - (v - lo) / rg); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.strokeStyle = d < 0 ? '#13d97e' : '#ffb300'; ctx.stroke(); };
    draw(); registry.push(draw); tr.appendChild(td); tb.appendChild(tr);
  });
  $('#cpiBrk').innerHTML = B.macro.cpiBreakdown.map(b => `<div class="bi ${b.yoy < 0 ? 'neg' : ''}"><span class="n">${b.label}</span><span class="${b.yoy < 0 ? 'up' : 'gold'}">${sgn(b.yoy)}${fmt(b.yoy, 1)}%</span><div class="m"><i style="width:${Math.min(100, Math.abs(b.yoy) / 12 * 100)}%"></i></div></div>`).join('');
}
let reP = '1Y';
function renderRE() {
  const d = B.realeconomy.periods[reP] ?? {};
  $('#reBars').innerHTML = Object.entries(d).map(([k, v]) => {
    const col = v < 0 ? 'var(--up)' : v > 5 ? 'var(--dn)' : 'var(--amber)';
    return `<div class="bi warm"><span class="n">${k === 'AUTOINS' ? 'AUTO INSUR.' : k}</span><span class="${v < 0 ? 'up' : 'gold'}">${sgn(v)}${fmt(v, 1)}%</span><div class="m"><i style="width:${Math.min(100, Math.abs(v) / 12 * 100)}%;background:${col}"></i></div><span class="v">${fmt(Math.abs(v) / 12 * 100, 0)}</span></div>`;
  }).join('');
}
function myIdxCalc() {
  const w = { hou: +$('#wHou').value, food: +$('#wFood').value, ins: +$('#wIns').value, ene: +$('#wEne').value };
  $('#wHou').nextElementSibling.textContent = w.hou + '%'; $('#wFood').nextElementSibling.textContent = w.food + '%';
  $('#wIns').nextElementSibling.textContent = w.ins + '%'; $('#wEne').nextElementSibling.textContent = w.ene + '%';
  const c = B.macro.components, rest = Math.max(0, 100 - w.hou - w.food - w.ins - w.ene);
  const v = (w.hou * c.housing + w.food * c.food + w.ins * c.autoins + w.ene * c.energy + rest * c.cpi) / 100;
  const gap = v - c.cpi;
  $('#myIdx').textContent = fmt(v, 1) + '%';
  const g = $('#myGap'); g.textContent = (gap > 0 ? '+' : '') + fmt(gap, 1) + 'pp'; g.className = gap > 0 ? 'dn' : 'up';
}

/* ---------- fx / alerts / news / reference / health ---------- */
function renderFX() {
  setChip('#p-fx', B.fx[0]?.delay ?? 'daily', `FRANKFURTER/ECB · ${B.fx[0] ? ageStr(Date.now() - B.fx[0].ts) : '—'}`);
  const tb = $('#fxTb'); tb.innerHTML = '';
  B.fx.forEach(r => {
    const ch = r.changePct ?? 0, d = r.price > 20 ? 2 : 4;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><b>${r.symbol}</b></td><td class="r"><b>${fmt(r.price, d)}</b></td><td class="r ${ch >= 0 ? 'up' : 'dn'}">${ch >= 0 ? '▲' : '▼'}${fmt(Math.abs(ch), 2)}%</td>
    <td>${r.wkHigh && r.wkLow ? `<span class="rngcell"><i style="left:${Math.round((r.price - r.wkLow) / (r.wkHigh - r.wkLow) * 100)}%"></i></span>` : ''}</td>
    <td class="r mut">${r.source.split('/')[0]}</td>`;
    tb.appendChild(tr);
  });
}
let alF = 'all';
function renderAlerts() {
  const box = $('#alList'); box.innerHTML = '';
  const list = B.alerts.filter(a => alF === 'all' || a.cat === alF);
  box.innerHTML = list.map(a => `<div class="al ${a.se}"><span class="g">${a.se === 'crit' ? '■' : a.se === 'warn' ? '▲' : '●'}</span><time>${a.t}</time><p>${a.txt}</p></div>`).join('')
    || '<div class="al info"><span class="g">●</span><p class="mut">NO ALERTS IN THIS CHANNEL</p></div>';
  $('#alCount').textContent = B.alerts.length + ' ACTIVE';
}
let nwF = 'gold';
function renderNews() {
  setChip('#p-news', B.news.gold[0]?.delay ?? 'near-live', `GDELT 2.0 · ${B.news.gold[0] ? ageStr(Date.now() - B.news.gold[0].publishedTs) : '—'}`);
  const ul = $('#nwList'); ul.innerHTML = '';
  (B.news[nwF] ?? []).forEach(n => {
    const li = document.createElement('li');
    li.innerHTML = `<time>${new Date(n.publishedTs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time><span class="tag">${n.source}</span><p>${n.title}</p><span class="sent ${n.sentiment === 'bull' ? 'b' : n.sentiment === 'bear' ? 's' : 'n'}">${n.sentiment === 'bull' ? 'BULL' : n.sentiment === 'bear' ? 'BEAR' : 'NEUT'}</span><div class="sum">// SENTIMENT: ${n.sentimentNote} · ${n.url !== '#' ? `<a href="${n.url}" target="_blank" rel="noopener" style="color:var(--cyan)">OPEN SOURCE ↗</a>` : 'SIMULATED PREVIEW'}</div>`;
    li.addEventListener('click', () => li.classList.toggle('open'));
    ul.appendChild(li);
  });
  $$('#nwF button').forEach(b => { const c = (B.news[b.dataset.f] ?? []).length; b.textContent = `${b.dataset.f.toUpperCase()} ${c}`; });
}
function renderReference() {
  $('#shipTb').innerHTML = B.reference.shipping.map(r => `<tr><td class="lab">${r.label}</td><td class="r"><b>${r.value}</b></td><td class="r ${r.deltaDir > 0 ? 'up' : 'dn'}">${r.delta}</td><td><span class="typetag idx">${r.typetag}</span></td></tr>`).join('');
  $('#insTb').innerHTML = B.reference.insurance.map(r => `<tr><td>${r.line}</td><td class="r"><b class="dn">+${fmt(r.yoy, 1)}%</b></td><td><span class="pressure${r.pressure === 2 ? ' md' : r.pressure === 1 ? ' lo' : ''}">${'<i class="on"></i>'.repeat(r.pressure)}${'<i></i>'.repeat(3 - r.pressure)}</span></td><td class="r"><span class="typetag">${r.tag}</span></td></tr>`).join('');
  $('#cbTb').innerHTML = B.reference.centralBanks.map(r => `<tr><td><b>${r.bank}</b></td><td class="r">${r.rate}</td><td class="mut">${r.next}</td><td><span class="stance n">${r.stance}</span></td><td class="r">${r.gold}</td></tr>`).join('');
  $('#calTb').innerHTML = B.reference.calendar.map(r => `<tr><td class="mut">${r.when}</td><td>${r.event}</td><td class="r">${r.cons}</td><td class="r mut">${r.prior}</td><td class="imp">${'<i class="on"></i>'.repeat(r.imp)}${'<i></i>'.repeat(3 - r.imp)}</td></tr>`).join('');
}
function renderHealth() {
  $('#healthTb').innerHTML = B.health.map(h => `<tr><td><b>${h.name.toUpperCase()}</b></td><td><span class="stdot ${h.status === 'online' ? 'on' : h.status === 'degraded' ? 'idle' : ''}"></span>${h.status.toUpperCase()}</td><td>${h.lastSuccess ? `<span data-ageh="${h.name}">${ageStr(Date.now() - h.lastSuccess)}</span>` : '—'}</td><td class="mut">${h.delay ? CHIP[h.delay]?.[0] ?? h.delay : '—'}</td><td>${h.lastSuccess ? new Date(h.lastSuccess).toLocaleTimeString('en-GB') : '—'}</td><td class="r mut">${h.latencyMs ?? '—'}ms</td><td class="mut">${h.configured ? (h.name === 'fred' || h.name === 'metals.dev' ? 'KEY' : 'NONE') : 'NOT SET'}</td></tr>`).join('');
}

/* ---------- WHY panel + AI ---------- */
const confSegs = $('#confSegs'); for (let i = 0; i < 26; i++) confSegs.appendChild(document.createElement('i'));
function confSet(v) { const lit = Math.round(v / 100 * 26); $('#confVal').textContent = v + '%'; [...confSegs.children].forEach((s, i) => { if (i < lit) setTimeout(() => s.classList.add('on'), i * 18); else s.classList.remove('on'); }); }
function renderWhy() {
  const w = B.why;
  $('.move').innerHTML = `MOVE ▸ <b class="${w.movePct >= 0 ? 'up' : 'dn'}">GOLD ${sgn(w.movePct)}${fmt(w.movePct, 2)}%</b> · 1D WINDOW <span class="tag amber">${w.method}</span>`;
  $('.drv').innerHTML = w.drivers.map(d => `<div class="dr"><span class="n">${d.name}</span><span class="d ${d.dir >= 0 ? 'up' : 'dn'}">${d.delta}</span><div class="m"><i style="width:${Math.max(4, d.magnitude)}%"></i></div><span class="v">${d.magnitude}</span></div>`).join('');
  const evi = $('.evi');
  evi.children[0].lastElementChild.innerHTML = w.evidence.map(e => `<li class="pos">${e}</li>`).join('') || '<li class="pos">—</li>';
  evi.children[1].lastElementChild.innerHTML = w.counter.map(e => `<li class="neg">${e}</li>`).join('');
  confSet(w.confidence);
  $('.sub').textContent = `${B.health.filter(h => h.status === 'online').length} SOURCES · BUILT ${new Date(B.builtAt).toLocaleTimeString('en-GB')} · ANALYSIS, NOT FINANCIAL ADVICE`;
}
async function tw(parent, caret, txt, cps = 90) {
  return new Promise(res => { let i = 0, cur = null;
    (function step() {
      if (i >= txt.length) return res();
      if (txt[i] === '\n') { parent.insertBefore(document.createElement('br'), caret); i++; return step(); }
      if (!cur) { cur = document.createElement('span'); parent.insertBefore(cur, caret); }
      cur.textContent += txt[i++];
      parent.parentElement.scrollTop = 1e9;
      setTimeout(step, 1000 / cps);
    })();
  });
}
const whyOut = $('#whyOut'), whyCaret = $('#whyCaret');
let investigating = false;
async function runInvestigation() {
  if (investigating) return; investigating = true;
  const btn = $('#runWhy'); btn.disabled = true; btn.textContent = '▮ ANALYZING…';
  whyOut.innerHTML = ''; whyOut.appendChild(whyCaret);
  confSet(52);
  try {
    const ai = await getJSON('/api/ai/analyst');
    const head = document.createElement('div'); head.className = 'ln'; whyOut.insertBefore(head, whyCaret);
    await tw(head, whyCaret, `> ENGINE: ${ai.engine}\n> DATA: ${B.gold.source} · ${CHIP[B.gold.delay][0]} · ${new Date(ai.ts).toISOString().replace('T', ' ').slice(0, 16)} UTC\n`, 140);
    const body = document.createElement('div'); body.className = 'ln'; whyOut.insertBefore(body, whyCaret);
    await tw(body, whyCaret, ai.text, 65);
    confSet(B.why.confidence);
  } catch (e) {
    const d = document.createElement('div'); d.className = 'ln'; whyOut.insertBefore(d, whyCaret);
    d.textContent = '> ANALYST UNAVAILABLE — ' + String(e.message);
  }
  btn.disabled = false; btn.textContent = '▶ RUN INVESTIGATION';
  investigating = false;
}

/* ---------- clock / ages / countdown / polling ---------- */
function startClock() {
  setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('en-GB'); tickAges(); }, 1000);
  $('#clock').textContent = new Date().toLocaleTimeString('en-GB');
  const next = B.reference.calendar[0]?.ts ?? Date.now() + 36e5;
  setInterval(() => { const s = Math.max(0, Math.floor((next - Date.now()) / 1e3)); const p = n => String(n).padStart(2, '0'); $('#cd').textContent = `T-${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`; }, 1000);
}
function tickAges() {
  $$('[data-ageq]').forEach(el => { if (el.dataset.ageq === 'gold' && B?.gold) el.textContent = ageStr(Date.now() - B.gold.ts); });
  $$('[data-ageh]').forEach(el => { const h = B?.health.find(x => x.name === el.dataset.ageh); if (h?.lastSuccess) el.textContent = ageStr(Date.now() - h.lastSuccess); });
}
function startPoll() {
  async function poll() {
    if (document.hidden) return;
    try { const nb = await getJSON('/api/bootstrap?tf=' + CH.tf); B = nb; CH.candles = nb.candles; renderTape(); renderHero(); drawMain(); drawSpark(); tickAges(); renderWhy(); }
    catch { /* transient — next poll retries; KV keeps serving */ }
  }
  setInterval(poll, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  // SIM mode only: local micro-tick keeps the demo alive between polls. Clearly labeled SIM.
  if (B.mode === 'simulated') setInterval(() => {
    const dp = (Math.random() - 0.5) * 1.9; B.gold.price = Math.max(4100, Math.min(4160, B.gold.price + dp));
    B.gold.change = B.gold.price - B.gold.prevClose; B.gold.changePct = B.gold.change / B.gold.prevClose * 100; B.gold.ts = Date.now();
    const L = CH.candles[CH.candles.length - 1]; if (L) { L.c = B.gold.price; L.h = Math.max(L.h, B.gold.price); L.l = Math.min(L.l, B.gold.price); }
    renderHero(); renderTape(); drawMain(); drawSpark();
  }, 2300);
}

/* ---------- UI wiring ---------- */
function wireUI() {
  $('#chCv').addEventListener('mousemove', e => { const r = e.currentTarget.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.in = true; if (!rafQ) { rafQ = true; requestAnimationFrame(() => { rafQ = false; drawMain(); }); } });
  $('#chCv').addEventListener('mouseleave', () => { mouse.in = false; drawMain(); });
  $('#tfGrp').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#tfGrp button').forEach(x => x.classList.remove('on')); b.classList.add('on');
    CH.tf = b.dataset.tf;
    try { const r = await getJSON('/api/candles?symbol=XAU:USD&tf=' + CH.tf); CH.candles = r.candles; } catch { }
    drawMain();
  });
  $('#tCandle').addEventListener('click', () => { view.type = 'candle'; $('#tCandle').classList.add('on'); $('#tLine').classList.remove('on'); drawMain(); });
  $('#tLine').addEventListener('click', () => { view.type = 'line'; $('#tLine').classList.add('on'); $('#tCandle').classList.remove('on'); drawMain(); });
  [['tMa20', () => view.ma20 = !view.ma20], ['tMa50', () => view.ma50 = !view.ma50], ['tVol', () => view.vol = !view.vol]].forEach(([id, fn]) => $('#' + id).addEventListener('click', () => { fn(); $('#' + id).classList.toggle('on'); drawMain(); }));
  $('#rePer').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $$('#rePer button').forEach(x => x.classList.remove('on')); b.classList.add('on'); reP = b.dataset.p; renderRE(); });
  ['wHou', 'wFood', 'wIns', 'wEne'].forEach(id => $('#' + id).addEventListener('input', myIdxCalc));
  $('#alF').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $$('#alF button').forEach(x => x.classList.remove('on')); b.classList.add('on'); alF = b.dataset.f; renderAlerts(); });
  $('#nwF').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $$('#nwF button').forEach(x => x.classList.remove('on')); b.classList.add('on'); nwF = b.dataset.f; renderNews(); });
  $('#runWhy').addEventListener('click', runInvestigation);
  $$('.gchip').forEach(b => b.addEventListener('click', () => gotoPanel(b.dataset.goto)));
  wirePalette();
  let rzT; window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => registry.forEach(f => { try { f(); } catch { } }), 120); });
  if (document.fonts?.ready) document.fonts.ready.then(() => registry.forEach(f => { try { f(); } catch { } }));
}
function gotoPanel(id) { const el = document.getElementById(id); if (!el) return; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

/* ---------- command palette (unchanged UX) ---------- */
const CMDS = [['/GOLD', 'SPOT GOLD', 'p-gold'], ['/CHART', 'XAU/USD CANDLES', 'p-chart'], ['/WHY-GOLD', 'AI INVESTIGATION', 'p-why'], ['/HEATMAP', 'MINING EQUITIES', 'p-heat'], ['/CPI', 'INFLATION', 'p-infl'], ['/REAL-ECONOMY', 'COST PRESSURE', 'p-realeco'], ['/FX', 'FOREX MAJORS', 'p-fx'], ['/ALERTS', 'MARKET ALERTS', 'p-alerts'], ['/NEWS', 'NEWS INTELLIGENCE', 'p-news'], ['/SHIPPING', 'FREIGHT INDEXES', 'p-ship'], ['/INSURANCE', 'INSURANCE INFLATION', 'p-ins'], ['/CENTRAL-BANKS', 'POLICY & GOLD', 'p-cb'], ['/CALENDAR', 'ECONOMIC CALENDAR', 'p-cal'], ['/DATA-HEALTH', 'SOURCE REGISTRY', 'p-health'], ['/RUN-WHY', 'EXECUTE AI ENGINE', 'p-why']];
let palOpen = false, palCur = CMDS, palIdx = 0;
function renderPal(q = '') {
  q = q.trim().toUpperCase();
  palCur = q ? CMDS.filter(c => c[0].includes(q) || c[1].toUpperCase().includes(q)) : CMDS;
  palIdx = Math.min(palIdx, Math.max(0, palCur.length - 1));
  $('#palList').innerHTML = palCur.map((c, i) => `<li class="${i === palIdx ? 'on' : ''}" data-i="${i}"><span class="c">${c[0]}</span><span class="d">${c[1]}</span></li>`).join('') || '<li><span class="c mut">NO MATCH</span></li>';
}
function wirePalette() {
  $('#cmdOpen').addEventListener('click', openPal);
  $('#palIn').addEventListener('input', e => renderPal(e.target.value));
  $('#palIn').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = Math.min(palCur.length - 1, palIdx + 1); renderPal($('#palIn').value); }
    if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); renderPal($('#palIn').value); }
    if (e.key === 'Enter' && palCur[palIdx]) { const c = palCur[palIdx]; closePal(); gotoPanel(c[2]); if (c[0] === '/RUN-WHY' || c[0] === '/WHY-GOLD') setTimeout(runInvestigation, 500); }
  });
  $('#palList').addEventListener('click', e => { const li = e.target.closest('li'); if (li?.dataset.i != null) { const c = palCur[+li.dataset.i]; closePal(); gotoPanel(c[2]); } });
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); palOpen ? closePal() : openPal(); }
    if (e.key === 'Escape' && palOpen) closePal();
  });
}
function openPal() { palOpen = true; $('#pal').classList.add('on'); palIdx = 0; renderPal(); setTimeout(() => $('#palIn').focus(), 20); }
function closePal() { palOpen = false; $('#pal').classList.remove('on'); $('#palIn').value = ''; }
