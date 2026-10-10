/* ================================================================
   SHELL — one app bar for every page (loaded first thing in <body>).
   INIT    auth guard → fetch wrapper (x-session) → theme before paint
   BUILD   header: brand · nav (active page) · search · theme · clock · avatar menu
   PUBLISH window.GT helpers + 'themechange' event so pages redraw canvases
   ================================================================ */
(function () {
  'use strict';
  var TOK = null, NAME = '', ROLE = 'operator', TIER = '';
  try { TOK = localStorage.getItem('git-token'); NAME = localStorage.getItem('git-name') || ''; ROLE = localStorage.getItem('git-role') || 'operator'; TIER = localStorage.getItem('git-tier') || ''; } catch (e) { }
  if (!TIER) TIER = ROLE === 'admin' ? 'admin' : ROLE === 'pro' ? 'pro' : 'free';
  var path = location.pathname.replace(/\/+$/, '') || '/';
  var page = (document.body && document.body.getAttribute('data-page')) || (path === '/' || path === '/index.html' ? 'home' : path.replace(/^\//, '').replace(/\.html$/, ''));
  // public pages: login and the site map (search engines and signed-out visitors)
  var PUBLIC = { login: 1, sitemap: 1 };
  if (!TOK && !PUBLIC[page]) { location.replace('/login.html'); return; }
  // Pro desks: the server returns 403 PRO_REQUIRED for their data; the page shows a locked card
  var PRO = { outlook: 1, loops: 1, data: 1, chart: 1 };

  // fetch wrapper: every same-origin call carries the session (idempotent)
  if (!window.fetch._gt) {
    var _f = window.fetch.bind(window);
    window.fetch = function (u, o) {
      o = o || {};
      var h = o.headers || {};
      if (TOK) {
        if (typeof Headers !== 'undefined' && h instanceof Headers) { if (!h.has('x-session')) h.set('x-session', TOK); }
        else if (!h['x-session']) h['x-session'] = TOK;
      }
      o.headers = h;
      return _f(u, o);
    };
    window.fetch._gt = true;
  }

  /* ---------- theme: auto (system) → light → dark ---------- */
  var mode = 'auto';
  try { mode = localStorage.getItem('git-theme') || 'auto'; } catch (e) { }
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;
  function isDay() { return mode === 'day' || (mode === 'auto' && (!mq || mq.matches)); }
  var ICON = {
    auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17A8.5 8.5 0 0 0 12 3.5z" fill="currentColor" stroke="none"/></svg>',
    day: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>',
    night: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>'
  };
  var LABEL = { auto: 'Theme: match system', day: 'Theme: light', night: 'Theme: dark' };
  function applyTheme(fire) {
    document.body.classList.toggle('day', isDay());
    var b = document.getElementById('gtTheme');
    if (b) { b.innerHTML = ICON[mode]; b.title = LABEL[mode]; b.setAttribute('aria-label', LABEL[mode]); }
    // older desk scripts redraw canvases on resize, newer ones on themechange
    if (fire) { try { window.dispatchEvent(new Event('themechange')); window.dispatchEvent(new Event('resize')); } catch (e) { } }
  }
  document.body.classList.toggle('day', isDay());
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (mode === 'auto') applyTheme(true); });

  if (page === 'login') return;
  if (!TOK) {
    // signed-out view of a public page: logo, theme, sign in. nothing else is wired.
    var h0 = document.getElementById('top') || document.createElement('header');
    h0.id = 'top';
    h0.innerHTML = '<a class="logo" href="/login.html" title="Gold Intelligence Terminal"><span class="lx"></span><span class="lt">Gold Terminal</span></a><nav class="gochips"></nav>' +
      '<div class="tsright"><button class="iconbtn" id="gtTheme" type="button"></button><a class="gchip on" href="/login.html">Sign in</a></div>';
    if (!h0.parentNode) { var m0 = document.currentScript; if (m0 && m0.parentNode) m0.parentNode.insertBefore(h0, m0); else document.body.insertBefore(h0, document.body.firstChild); }
    applyTheme(false);
    document.getElementById('gtTheme').addEventListener('click', function () { mode = mode === 'auto' ? 'day' : (mode === 'day' ? 'night' : 'auto'); try { localStorage.setItem('git-theme', mode); } catch (e) { } applyTheme(true); });
    window.GT = { page: page, tier: 'none', esc: function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); } };
    return;
  }

  /* ---------- header ---------- */
  var NAV = [
    ['/', 'Home', 'home'], ['/outlook.html', 'Outlook', 'outlook'], ['/gold.html', 'Gold', 'gold'], ['/energy.html', 'Energy', 'energy'], ['/agri.html', 'Agri', 'agri'],
    ['/fx.html', 'FX', 'fx'], ['/treasury.html', 'Treasury', 'treasury'], ['/stable.html', 'Crypto', 'stable'], ['/vol.html', 'Volatility', 'vol'],
    ['/shipping.html', 'Shipping', 'shipping'], ['/water.html', 'Water', 'water'], ['/land.html', 'Land', 'land'],
    ['/news.html', 'News', 'news'], ['/ai.html', 'AI', 'ai'], ['/chart.html', 'Charts', 'chart'], ['/loops.html', 'Loops', 'loops'], ['/data.html', 'Data', 'data']
  ];
  function navHtml(role) {
    var items = NAV.slice();
    if (role === 'admin') items.push(['/admin.html', 'Admin', 'admin']);
    return items.map(function (n) {
      var lock = PRO[n[2]] && TIER === 'free';
      return '<a class="gchip' + (n[2] === page ? ' on' : '') + (lock ? ' locked' : '') + '" href="' + n[0] + '"' + (n[2] === page ? ' aria-current="page"' : '') + (lock ? ' title="Pro desk"' : '') + '>' + n[1] + (PRO[n[2]] ? '<span class="protag">Pro</span>' : '') + '</a>';
    }).join('');
  }
  var ini = (NAME || 'O').trim().charAt(0).toUpperCase() || 'O';
  var hdr = document.getElementById('top') || document.createElement('header');
  hdr.id = 'top';
  hdr.innerHTML =
    '<a class="logo" href="/" title="Gold Intelligence Terminal"><span class="lx"></span><span class="lt">Gold Terminal</span></a>' +
    '<nav class="gochips" aria-label="Desks">' + navHtml(ROLE) + '</nav>' +
    '<div class="tsright">' +
      '<span class="livedot hide" id="feedDot"><i></i><span id="feedTxt"></span></span>' +
      '<a class="iconbtn" href="/sitemap.html" title="Site map" aria-label="Site map"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="9" y="3" width="6" height="5" rx="1.2"/><rect x="3" y="16" width="6" height="5" rx="1.2"/><rect x="15" y="16" width="6" height="5" rx="1.2"/><path d="M12 8v4M6 16v-2h12v2" stroke-linecap="round"/></svg></a>' +
      '<a class="iconbtn" href="/search.html" title="Search" aria-label="Search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg></a>' +
      '<button class="iconbtn" id="gtTheme" type="button"></button>' +
      '<span id="clock" title="Local time"></span>' +
      '<button class="opbadge" id="opbadge" type="button" title="' + (NAME ? NAME.replace(/"/g, '') : 'Operator') + '">' + ini + '</button>' +
      '<button id="logout" type="button">Sign out</button>' +
    '</div>';
  if (!hdr.parentNode) {
    var me = document.currentScript;
    if (me && me.parentNode) me.parentNode.insertBefore(hdr, me); else document.body.insertBefore(hdr, document.body.firstChild);
  }
  applyTheme(false);
  // keep the active tab visible on narrow screens
  var on = hdr.querySelector('.gchip.on');
  if (on && on.scrollIntoView) { try { on.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { } }

  document.getElementById('gtTheme').addEventListener('click', function () {
    mode = mode === 'auto' ? 'day' : (mode === 'day' ? 'night' : 'auto');
    try { localStorage.setItem('git-theme', mode); } catch (e) { }
    applyTheme(true);
  });
  document.getElementById('logout').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOK }) }).catch(function () { })
      .then(function () {
        try { ['git-token', 'git-name', 'git-role', 'git-tier'].forEach(function (k) { localStorage.removeItem(k); }); sessionStorage.removeItem('git-role-checked'); } catch (e) { }
        location.href = '/login.html';
      });
  });
  function tick() { var c = document.getElementById('clock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  tick(); setInterval(tick, 15000);

  // role + tier check once per tab session, and on every Pro page (the admin can grant or end Pro at any time).
  // the server enforces both on every call; this only drives the nav and the locked card.
  var checked = null; try { checked = sessionStorage.getItem('git-role-checked'); } catch (e) { }
  if (!checked || PRO[page]) {
    fetch('/api/auth/me').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (d) {
      // only a definite "this session is not valid" signs out; a 429/5xx leaves the user where they are
      if (d && d.valid === false) { try { localStorage.removeItem('git-token'); } catch (e) { } location.replace('/login.html'); return; }
      var t = d.tier || (d.role === 'admin' ? 'admin' : 'free');
      try { localStorage.setItem('git-role', d.role || 'operator'); localStorage.setItem('git-tier', t); sessionStorage.setItem('git-role-checked', '1'); } catch (e) { }
      var was = TIER;
      if ((d.role || 'operator') !== ROLE || t !== TIER) { ROLE = d.role || 'operator'; TIER = t; GT.tier = t; var nv = hdr.querySelector('.gochips'); if (nv) nv.innerHTML = navHtml(ROLE); }
      if (PRO[page] && was !== t) { if (t === 'free') GT.lock(); else if (was === 'free') location.reload(); }
    }).catch(function () { });
  }

  /* ---------- shared helpers for page scripts ---------- */
  var GT = window.GT = {};
  GT.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  GT.fmt = function (n, d) { if (n == null || !isFinite(n)) return '–'; d = d == null ? 2 : d; return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
  GT.sgn = function (n) { return n > 0 ? '+' : ''; };
  GT.cls = function (v) { return (v == null ? 0 : v) >= 0 ? 'up' : 'dn'; };
  GT.css = function (name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); };
  GT.safeUrl = function (u) { try { var x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : '#'; } catch (e) { return '#'; } };
  GT.ago = function (ts) {
    if (!ts) return '';
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago';
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  GT.getJSON = function (u) {
    return fetch(u).then(function (r) {
      if (r.status === 403 && PRO[page]) return r.json().catch(function () { return {}; }).then(function (b) { if (b && b.error === 'PRO_REQUIRED') { try { localStorage.setItem('git-tier', 'free'); } catch (e) { } GT.lock(); } throw new Error('HTTP 403'); });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  };
  // server labels arrive in caps ('REAL YIELD 10Y'); show them in sentence case, keep acronyms
  var KEEP = /^(XAU|XAG|USD|DXY|CPI|PCE|PPI|FRED|USDA|USGS|EIA|ML|AI|HMM|GDELT|WTI|OHLC|MA20|MA50|ETF|ECB|VIX|GVZ|OVX|MOVE|RV|RV20|GARCH|FX|US|UST|TIPS|NQH2O|BLS|USDT|USDC|DAI|SOFR|EFFR|FOMC|GDP|RSI|MACD|SMA50|SMA20|LR|GBS|EOD|YOY|BP|OK|NY|LA|EU|UK|CN|JPY|EUR|GBP|CNY|CAD|AUD|CHF|MXN|NFP|JOLTS|WASDE|COT|CFTC|LNG|RBOB|API|KV|D1|ID|BTC|ETH|S&P|SPX|NDX|RUT|VXN|VVIX|KIE|XL[A-Z]|GLD|SLV|NEM|GDX|GDXJ|UUP|BDRY|BWET|PHO|ZIM|FPI|CL1|NG1|C1|S1|W1|HO1|XB1|CO1|LC1|FC1|CT1|SB1|\d+[A-Z]{1,2}|[A-Z]{2,5}=F)$/;
  GT.sc = function (s) {
    s = String(s == null ? '' : s);
    if (!/[A-Z]{3,}/.test(s) || /[a-z]/.test(s)) return s;
    var first = true;
    return s.split(/(\s+|[-/·(),:])/).map(function (w) {
      if (!w || /^(\s+|[-/·(),:])$/.test(w)) return w;
      var bare = w.replace(/[^A-Za-z0-9&=]/g, '');
      var out = KEEP.test(bare) ? w : (first ? w.charAt(0) + w.slice(1).toLowerCase() : w.toLowerCase());
      first = false;
      return out;
    }).join('');
  };
  GT.page = page;
  GT.tier = TIER;
  /* locked card for Pro desks (free accounts). page scripts check GT.locked before they start. */
  GT.lock = function () {
    if (GT._lockShown) return; GT._lockShown = true; GT.locked = true;
    var m = document.querySelector('main'); if (!m) return;
    var h1 = m.querySelector('.pagehead h1'); var nm = h1 ? h1.textContent : 'This desk';
    m.innerHTML = '<div class="pagehead"><div><h1>' + GT.esc(nm) + '</h1><p>Pro desk</p></div></div>' +
      '<section class="panel prolock"><div class="p-bd"><div class="pl-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg></div>' +
      '<h2>' + GT.esc(nm) + ' is part of Pro</h2>' +
      '<p>Pro adds the outlook and forecast ledger, the evolution loops, the data explorer, the custom chart builder, the narrative radar and full podcast digests. Access is granted by the site admin.</p>' +
      '<p class="pl-who">Signed in as <b>' + GT.esc(NAME || 'you') + '</b> · free account</p>' +
      '<div class="pl-row"><a class="gchip on" href="/sitemap.html">See every desk</a><a class="gchip" href="/">Back to Home</a></div></div></section>';
  };
  GT.locked = !!(PRO[page] && TIER === 'free');
  if (GT.locked) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', GT.lock); else GT.lock(); }
  // desk scripts written for the old terminal still emit caps; fix text as it lands.
  // single short tokens (tickers, codes) are left alone unless they are plain words.
  var WORDS = /^(LAST|OPEN|HIGH|LOW|CLOSE|PREV|BID|ASK|UNIT|NOTE|WHEN|EVENT|SOURCE|SRC|DATE|TIME|NAME|PRICE|CHANGE|CHG|VALUE|LEVEL|RANGE|TREND|SIGNAL|STATUS|LIVE|DAILY|WEEKLY|MONTHLY|STALE|WARMING|LOADING|NONE|SPOT|RATE|RATES|YIELD|SPREAD|INDEX|TOTAL|NET|TYPE|STATE|PEG|SUPPLY|VOLUME|RANK|SCORE|REGIME|NORMAL|STRESS|ELEVATED|CALM|BULL|BEAR|NEUTRAL|BUY|SELL|HOLD|UP|DOWN|FLAT|YES|NO|ON|OFF|AVG|MIN|MAX|MEAN|HIT|MISS|PENDING|ACTIVE|IDLE|ERROR|FAIL|PASS|SKIP|REAL|NOMINAL|GAUGE|RIVER|FLOW|DROUGHT|FARM|RENT|PORT|PORTS|ROUTE|ROUTES|FREIGHT|SEA|WIND|WAVE|WAVES|GOLD|SILVER|COPPER|CORN|WHEAT|SOY|CATTLE|CRUDE|BRENT|GAS|DIESEL|POWER|WATER|LAND|NEWS|MOVERS|MONITOR|ALERTS|CALENDAR|REFERENCE|SECTOR|EQUITIES|MAJORS|STRENGTH|HISTORY|ASK|ANSWER|MODEL|AGENT|AGENTS|WEIGHT|FEATURES|PREDICTION|OUTCOME|NEAR|FEED|DELAYED|EST|CALC|PROBE|USERS|DATABASE|ROWS|SIZE|AGE|FRESH|KEYS|ROLE|ADMIN|OPERATOR)$/;
  function fixNode(t) {
    var v = t.nodeValue;
    if (!v || !/[A-Z]{3,}/.test(v) || /[a-z]/.test(v)) return;
    var core = v.trim();
    if (!/\s/.test(core) && core.length <= 6 && !WORDS.test(core.replace(/[^A-Z]/g, ''))) return;
    var nv = GT.sc(v);
    if (nv !== v) t.nodeValue = nv;
  }
  function fixTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { fixNode(root); return; }
    if (root.nodeType !== 1 || root.closest('.keepcase,#tape,.hc,.tg,canvas,script,style,code,pre,textarea,input')) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), n;
    while ((n = w.nextNode())) { if (!n.parentNode.closest('.keepcase,#tape,.hc,code,pre,script,style')) fixNode(n); }
  }
  GT.fixCase = fixTree;
  function watchCase() {
    var roots = [document.querySelector('main'), document.getElementById('status'), document.querySelector('.awrap'), document.querySelector('.vwrap')].filter(Boolean);
    roots.forEach(function (r) {
      fixTree(r);
      new MutationObserver(function (ms) {
        ms.forEach(function (m) {
          if (m.type === 'characterData') fixNode(m.target);
          else m.addedNodes.forEach(fixTree);
        });
      }).observe(r, { childList: true, subtree: true, characterData: true });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchCase); else watchCase();
  GT.font = function (px, w) { return (w || 400) + ' ' + px + 'px "Roboto Flex", Roboto, system-ui, sans-serif'; };
  GT.feed = function (live, txt) {
    var fd = document.getElementById('feedDot'), ft = document.getElementById('feedTxt');
    if (!fd || !ft) return;
    fd.classList.remove('hide'); ft.textContent = txt || (live ? 'Live' : 'Last known prices');
    fd.style.color = live ? 'var(--up)' : 'var(--amber)';
  };
})();
