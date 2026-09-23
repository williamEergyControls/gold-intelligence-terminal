/* ================================================================
   GIT/4.2.26 - HOME RUNTIME - session, profile, watchlist, AI
   ================================================================ */
(function () {
'use strict';
const $ = s => document.querySelector(s);
const fmt = (n, d = 2) => (n == null || isNaN(n)) ? '--' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sgn = n => (n > 0 ? '+' : '');
const cls = v => (v ?? 0) >= 0 ? 'up' : 'dn';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => { try { const x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : '#'; } catch { return '#'; } };
async function getJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

let B = null;

/* ---------- session via D1 token ---------- */
const TOKEN = localStorage.getItem('git-token') || '';
const AH = { 'x-session': TOKEN };
const NAME = localStorage.getItem('git-name') || '';
if (!TOKEN) { location.replace('/login.html'); return; }
fetch('/api/auth/me', { headers: { 'x-session': TOKEN } })
  .then(r => r.json())
  .then(d => {
    if (!d.valid) { localStorage.clear(); location.replace('/login.html'); }
    else { localStorage.setItem('git-role', d.role || 'operator'); }
  })
  .catch(() => { });
const badge = $('#opbadge'); if (badge) badge.textContent = (NAME || 'OPERATOR').toUpperCase();
const lo = $('#logout');
if (lo) lo.addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) }); } catch (e) { }
  localStorage.removeItem('git-token'); localStorage.removeItem('git-name'); localStorage.removeItem('git-role');
  location.href = '/login.html';
});
   
/* ---------- clock ---------- */
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);
 $('#clock').textContent = new Date().toLocaleTimeString('en-GB');

/* ---------- profile ---------- */
const DEF = { name: NAME || '', wf: 15, we: 10, wi: 10, wh: 30, wg: 10 };
let P = Object.assign({}, DEF, (() => { try { return JSON.parse(localStorage.getItem('git-profile') || '{}'); } catch (e) { return {}; } })());
const save = () => localStorage.setItem('git-profile', JSON.stringify(P));
const op = $('#opname'); if (op) { op.value = P.name; op.addEventListener('input', () => { P.name = op.value.slice(0, 24); save(); }); }
['wf', 'we', 'wi', 'wh', 'wg'].forEach(id => {
  const el = $('#' + id); if (!el) return;
  el.value = P[id]; el.nextElementSibling.textContent = P[id] + '%';
  el.addEventListener('input', () => { P[id] = +el.value; el.nextElementSibling.textContent = P[id] + '%'; save(); calc(); });
});

function calc() {
  if (!B) return;
  const c = B.macro && B.macro.components ? B.macro.components : {};
  const d = (B.series && B.series.dailyCloses) || [];
  const n = Math.min(252, d.length - 2);
  const goldYoY = (d.length > 60 && n > 0) ? (d[d.length - 1] / d[d.length - 1 - n] - 1) * 100 : 0;
  const rest = Math.max(0, 100 - P.wf - P.we - P.wi - P.wh - P.wg);
  const real = (P.wf * (c.food ?? 2.7) + P.we * (c.energy ?? -1.9) + P.wi * (c.autoins ?? 11.8) + P.wh * (c.housing ?? 4.2) + P.wg * goldYoY + rest * (c.cpi ?? 3.1)) / 100;
  const gap = real - (c.cpi ?? 3.1);
  $('#riVal').textContent = fmt(real, 1) + '%';
  $('#riFed').textContent = 'FED VIEW (CPI): ' + fmt(c.cpi, 1) + '%';
  const g = $('#riGap');
  g.textContent = 'GAP ' + (gap > 0 ? '+' : '') + fmt(gap, 1) + 'pp - ' + (gap > 0.5 ? 'REALITY RUNS HOTTER THAN OFFICIAL' : gap < -0.5 ? 'REALITY COOLER THAN OFFICIAL' : 'IN LINE WITH OFFICIAL');
  g.className = (gap > 0 ? 'dn' : 'up'); g.style.fontSize = '11px'; g.style.fontWeight = '600';
  $('#riRest').textContent = 'REST ' + rest + '%';
}

/* ---------- render ---------- */
function renderGold() {
  const g = B.gold, p = g.changePct ?? 0;
  $('#px').textContent = fmt(g.price);
  const bc = $('#pxc'); bc.className = 'bigchg ' + cls(p);
  bc.innerHTML = (p >= 0 ? 'UP +' : 'DN ') + fmt(Math.abs(g.change)) + '  (' + sgn(p) + fmt(p) + '%)';
  $('#gsrc').textContent = String(g.source).toUpperCase() + ' - ' + (g.delay === 'simulated' ? 'SIM' : 'NEAR LIVE');
  const ch = $('#gchip'); ch.textContent = g.delay === 'simulated' ? 'SIM' : 'NEAR LIVE'; ch.className = 'chip ' + (g.delay === 'simulated' ? 'ai' : 'near');
  const m = B.ml ?? null;
  $('#mlLine').innerHTML = m
    ? 'ML SIGNAL: <b class="' + (m.p >= 0.5 ? 'up' : 'dn') + '">' + esc(m.direction) + ' ' + (m.p * 100).toFixed(0) + '%</b> - REGIME <b class="gold">' + esc(m.regime.state) + '</b> - AGREE ' + m.final.agreeing + '/10 - ACC ' + esc(m.final.accStatus) + ' - <a href="/gold.html" style="color:var(--cyan)">FULL DESK</a>'
    : 'ML WARMING - first prediction appears within the hour';
  const live = B.mode === 'live';
  $('#feedTxt').textContent = live ? 'FEED LIVE' : 'FEED SIM';
  const fd = $('#feedDot'); fd.style.color = live ? 'var(--up)' : 'var(--amber)';
  const i = fd.querySelector('i'); if (i) i.style.background = live ? 'var(--up)' : 'var(--amber)';
}
function renderRates() {
  const keys = ['US10Y', 'REAL10Y', 'BREAKEV', 'SOFR', 'EFFR'];
  let h = keys.map(k => {
    const r = (B.macro && B.macro.rows ? B.macro.rows : []).find(x => x.key === k); if (!r) return '';
    const d = (r.value - r.prior) * 100;
    return '<div class="ri"><span class="n">' + esc(r.label) + '</span><span class="gold">' + fmt(r.value, 2) + '%</span><span class="' + (d <= 0 ? 'up' : 'dn') + '" style="justify-self:end;font-size:9px">' + (d <= 0 ? 'v ' : '^ ') + fmt(Math.abs(d), 1) + 'bp</span></div>';
  }).join('');
  const dxy = B.dxy, dp = dxy.changePct ?? 0;
  h += '<div class="ri" style="border-top:1px dashed var(--line2);margin-top:4px;padding-top:5px"><span class="n">US DOLLAR (DXY)</span><span class="cyan">' + fmt(dxy.price, 2) + '</span><span class="' + (dp >= 0 ? 'dn' : 'up') + '" style="justify-self:end;font-size:9px">' + sgn(dp) + fmt(dp, 2) + '%</span></div>';
  h += '<div class="footnote">10Y / REAL / BREAKEVEN / SOFR (REPO) / EFFR - FRED DAILY OFFICIAL - DXY NEAR-LIVE</div>';
  $('#ratesBody').innerHTML = h;
}
function renderAlerts() {
  const list = B.alerts || [];
  $('#alCount').textContent = list.length + ' ACTIVE';
  $('#alList').innerHTML = list.map(a =>
    '<div class="al ' + a.se + '"><span class="g">' + (a.se === 'crit' ? '#' : a.se === 'warn' ? '^' : 'o') + '</span><time>' + esc(a.t) + '</time><p>' + esc(a.txt) + '</p></div>').join('') || '<div class="al info"><span class="g">o</span><p class="mut">NO ALERTS</p></div>';
}
function renderHealth() {
  const on = B.health.filter(h => h.status === 'online').length, tot = B.health.length;
  const hc = $('#hChip'); hc.textContent = on + '/' + tot + ' ONLINE'; hc.className = 'chip ' + (on === tot ? 'live' : (on ? 'near' : 'ai'));
  $('#hBody').innerHTML = B.health.map(h => (h.status === 'online' ? '<span class="up">o</span> ' : '<span class="dim">-</span> ') + esc(h.name.toUpperCase()) + ' - ' + esc(h.status.toUpperCase())).join('<br>');
}
function renderNews() {
  $('#nwList').innerHTML = ((B.news && B.news.gold) || []).slice(0, 6).map(n => {
    const sc = n.sentiment === 'bull' ? 'b' : (n.sentiment === 'bear' ? 's' : 'n');
    const st = n.sentiment === 'bull' ? 'BULL' : (n.sentiment === 'bear' ? 'BEAR' : 'NEUT');
    const link = (n.url && n.url !== '#') ? '<a href="' + esc(safeUrl(n.url)) + '" target="_blank" rel="noopener noreferrer">OPEN</a>' : 'SIM';
    return '<li><time>' + new Date(n.publishedTs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</time><span class="tag">' + esc(n.source) + '</span><p>' + esc(n.title) + '</p><span class="sent ' + sc + '">' + st + '</span><div class="sum">// ' + esc(n.sentimentNote) + ' - ' + link + '</div></li>';
  }).join('');
}
function renderTape() {
  const h = (B.tape || []).map(t => {
    const ch = t.changePct ?? 0, dg = t.price > 500 ? 1 : (t.price > 20 ? 2 : 3);
    return '<span class="tg"><span class="k">' + esc(t.symbol) + '</span><span class="v">' + fmt(t.price, dg) + '</span><span class="c ' + cls(ch) + '">' + (ch >= 0 ? 'UP ' : 'DN ') + sgn(ch) + fmt(Math.abs(ch), 2) + '%</span></span>';
  }).join('');
  $('#tapeA').innerHTML = h; $('#tapeB').innerHTML = h;
}
function renderAll() { renderTape(); renderGold(); renderRates(); renderAlerts(); renderHealth(); renderNews(); calc(); }

/* ---------- watchlist ---------- */
let WATCH = [];
try { WATCH = JSON.parse(localStorage.getItem('git-watch') || '[]'); } catch (e) { }
const saveWatch = () => { localStorage.setItem('git-watch', JSON.stringify(WATCH)); loadWatch(); };
async function loadWatch() {
  const wc = $('#wcount'); if (wc) wc.textContent = WATCH.length + '';
  if (!WATCH.length) { $('#watchList').innerHTML = '<div class="footnote">EMPTY - ADD A TICKER ABOVE</div>'; return; }
  try {
    const r = await getJSON('/api/watch?syms=' + encodeURIComponent(WATCH.join(',')));
    $('#watchList').innerHTML = (r.quotes || []).map(q => {
      const ch = q.changePct ?? 0;
      const del = '<span class="del" data-sym="' + esc(q.symbol) + '">x</span>';
      return '<div class="watchrow"><b>' + esc(q.symbol) + '</b><span class="mut">' + esc(q.name || '') + '</span><span class="r"><b>' + fmt(q.price, 2) + '</b></span><span class="r ' + cls(ch) + '">' + sgn(ch) + fmt(ch, 2) + '%</span>' + del + '</div>';
    }).join('');
    document.querySelectorAll('#watchList .del').forEach(d => d.addEventListener('click', () => {
      WATCH = WATCH.filter(s => s !== d.dataset.sym); saveWatch();
    }));
  } catch (e) { $('#watchList').innerHTML = '<div class="footnote">WATCH QUOTES PENDING</div>'; }
}
const addgo = $('#addgo');
if (addgo) addgo.addEventListener('click', () => {
  const v = ($('#addsym').value || '').trim().toUpperCase();
  if (!v) return;
  if (!WATCH.includes(v) && WATCH.length < 12) WATCH.push(v);
  $('#addsym').value = '';
  saveWatch();
});
 $('#addsym').addEventListener('keydown', e => { if (e.key === 'Enter') addgo.click(); });
loadWatch();
setInterval(() => { if (!document.hidden) loadWatch(); }, 30000);

/* ---------- AI with profile ---------- */
const aOut = $('#aOut');
function line(txt) { const d = document.createElement('div'); d.className = 'ln'; d.textContent = txt || ''; aOut.appendChild(d); aOut.scrollTop = 1e9; return d; }
function typeInto(el, txt, cps) {
  return new Promise(res => { let i = 0;
    (function step() { if (i >= txt.length) return res(); el.textContent += txt[i++]; aOut.scrollTop = 1e9; setTimeout(step, Math.round(1000 / (cps || 70))); })();
  });
}
let busy = false;
 $('#runA').addEventListener('click', async () => {
  if (busy || !B) return; busy = true;
  const btn = $('#runA'); btn.disabled = true; btn.textContent = 'ANALYZING...';
  aOut.innerHTML = '';
  try {
    const r = await fetch('/api/ai/analyst', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: {
        operator: P.name || 'OPERATOR',
        realInflation: parseFloat(($('#riVal').textContent || '').replace('%', '')) || null,
        weights: { food: P.wf, energy: P.we, insurance: P.wi, housing: P.wh, gold: P.wg },
      } }),
    });
    const ai = await r.json();
    await typeInto(line(''), '> ENGINE: ' + ai.engine + '\n> DATA: ' + B.gold.source + ' - ' + new Date(ai.ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC\n', 150);
    await typeInto(line(''), '\n' + ai.text, 60);
    if (ai.aiErrors && ai.aiErrors.length) line('> AI TRIED: ' + ai.aiErrors.join(' | '));
  } catch (e) { line('> ANALYST UNAVAILABLE - ' + String(e && e.message || e)); }
  btn.disabled = false; btn.textContent = 'RUN ANALYST - WITH YOUR PROFILE';
  busy = false;
});

/* ---------- init + polls ---------- */
(async function init() {
  try { B = await getJSON('/api/bootstrap?tf=1D', AH); renderAll(); }
  catch (e) { const s = $('#status .mid'); if (s) s.textContent = 'API ERROR - ' + String(e && e.message || e); }
})();
setInterval(async () => {
  if (document.hidden || !B) return;
  try { B = await getJSON('/api/bootstrap?tf=1D', AH); renderAll(); } catch (e) { }
}, 60000);
setInterval(async () => {
  if (document.hidden || !B) return;
  try {
    const q = await getJSON('/api/quote');
    if (isFinite(q.gold) && B.gold.prevClose) {
      B.gold.price = q.gold; B.gold.change = q.gold - B.gold.prevClose; B.gold.changePct = (q.gold / B.gold.prevClose - 1) * 100; B.gold.ts = q.ts;
    }
    renderGold(); renderTape();
  } catch (e) { }
}, 20000);

/* ---------- theme ---------- */
(function () {
  let mode = localStorage.getItem('git-theme') || 'auto';
  const isDay = () => mode === 'day' || (mode === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  const apply = () => {
    document.body.classList.toggle('day', isDay());
    const b = document.getElementById('themeBtn');
    if (b) b.textContent = 'AUTO/' + (mode === 'auto' ? 'SYS' : mode.toUpperCase());
  };
  const b = document.getElementById('themeBtn');
  if (b) b.addEventListener('click', () => { mode = mode === 'auto' ? 'day' : (mode === 'day' ? 'night' : 'auto'); localStorage.setItem('git-theme', mode); apply(); });
  try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (mode === 'auto') apply(); }); } catch (e) { }
  apply();
})();
})();
