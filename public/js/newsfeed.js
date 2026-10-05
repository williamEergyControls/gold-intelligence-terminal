/* ================================================================
   NEWS FEED + TRADE IDEAS — renders /api/news/feed and /api/news/ideas
   NewsFeed.mount(el, { topic, limit, filters, thumbs, poll })
   Ideas.mount(el, { limit, topic })
   items come from your crawled sources (RSS + YouTube) with an AI digest;
   GDELT fills the gap when a desk has few crawled stories.
   ================================================================ */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var safe = function (u) { try { var x = new URL(String(u)); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : '#'; } catch (e) { return '#'; } };
  function ago(ts) {
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  var NAMES = { XAU: 'Gold', XAG: 'Silver', DXY: 'US dollar', EURUSD: 'EUR/USD', USDJPY: 'USD/JPY', GBPUSD: 'GBP/USD', USDCNY: 'USD/CNY', WTI: 'WTI crude', BRENT: 'Brent crude',
    NATGAS: 'Natural gas', CORN: 'Corn', WHEAT: 'Wheat', SOY: 'Soybeans', COPPER: 'Copper', SPX: 'S&P 500', NDX: 'Nasdaq 100', UST10Y: '10Y Treasury', BTC: 'Bitcoin', ETH: 'Ether', USDT: 'Tether', USDC: 'USD Coin', BDRY: 'Dry bulk freight' };
  var TOPICS = [['all', 'All'], ['gold', 'Gold'], ['markets', 'Markets'], ['macro', 'Macro'], ['fx', 'FX'], ['energy', 'Energy'], ['agri', 'Agri'], ['shipping', 'Shipping'], ['crypto', 'Crypto'], ['water', 'Water'], ['land', 'Land']];
  function sentTitle(it) {
    if (!it.sentiment) return '';
    var a = it.assets && it.assets[0] ? (NAMES[it.assets[0]] || it.assets[0]) : 'the market';
    return it.sentiment === 'bull' ? 'Positive for ' + a : it.sentiment === 'bear' ? 'Negative for ' + a : 'Neutral for ' + a;
  }
  function biasTxt(b) { return b === 'long' ? 'Long' : b === 'short' ? 'Short' : 'Watch'; }

  function itemHtml(it, thumbs) {
    var meta = '<span class="sdot ' + (it.sentiment || '') + '" title="' + esc(sentTitle(it)) + '"></span>' +
      '<span class="src">' + esc(it.source) + '</span>' +
      (it.kind === 'youtube' ? '<span class="yt">Video</span>' : '') +
      (it.favorite ? '<span title="One of your sources">Your source</span>' : '') +
      '<time datetime="' + new Date(it.published).toISOString() + '">' + ago(it.published) + '</time>' +
      (it.aiSummary ? '<span class="dim">AI summary</span>' : '');
    var tags = '';
    if (it.idea) tags += '<span class="idea ' + esc(it.idea.bias) + '" title="' + esc(it.idea.why) + '">' + biasTxt(it.idea.bias) + ' ' + esc(NAMES[it.idea.asset] || it.idea.asset) + ' · ' + esc(it.idea.horizon) + '</span>';
    return '<article class="nf-it">' +
      '<div class="nf-meta">' + meta + '</div>' +
      '<a class="nf-t" href="' + esc(safe(it.url)) + '" target="_blank" rel="noopener">' + esc(it.title) + '</a>' +
      (thumbs && it.thumb ? '<img class="nf-thumb" loading="lazy" alt="" src="' + esc(safe(it.thumb)) + '">' : '') +
      (it.summary ? '<p class="nf-s">' + esc(it.summary) + '</p>' : '') +
      (tags ? '<div class="nf-tags">' + tags + '</div>' : '') +
      '</article>';
  }

  function mount(el, o) {
    if (!el) return;
    o = o || {};
    var st = { topic: o.topic || 'all', fav: false, limit: o.limit || 8 };
    el.classList.add('nf');
    el.innerHTML = (o.filters ? '<div class="nf-filters" role="tablist"></div>' : '') + '<div class="nf-list"><div class="empty">Loading stories…</div></div>' +
      (o.more ? '<button class="btn ghost sm auto nf-more" type="button">Show more</button>' : '');
    var list = el.querySelector('.nf-list');
    if (o.filters) {
      var f = el.querySelector('.nf-filters');
      f.innerHTML = TOPICS.map(function (t) { return '<button type="button" class="tag' + (t[0] === st.topic ? ' on' : '') + '" data-t="' + t[0] + '">' + t[1] + '</button>'; }).join('') +
        '<button type="button" class="tag" data-fav="1">Your sources only</button>';
      f.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        if (b.dataset.fav) { st.fav = !st.fav; b.classList.toggle('on', st.fav); }
        else { st.topic = b.dataset.t; f.querySelectorAll('[data-t]').forEach(function (x) { x.classList.toggle('on', x === b); }); }
        st.limit = o.limit || 8; load();
      });
    }
    var more = el.querySelector('.nf-more');
    if (more) more.addEventListener('click', function () { st.limit = Math.min(40, st.limit + (o.limit || 8)); load(); });
    function load() {
      fetch('/api/news/feed?topic=' + encodeURIComponent(st.topic) + '&limit=' + st.limit + (st.fav ? '&fav=1' : ''))
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (d) {
          var items = d.items || [];
          if (!items.length) {
            list.innerHTML = '<div class="empty"><b>No stories yet.</b> The crawler checks your sources every 10 minutes' + (d.sources ? ' (' + d.sources + ' sources active)' : '') + '.</div>';
          } else list.innerHTML = items.map(function (it) { return itemHtml(it, o.thumbs !== false); }).join('');
          if (more) more.classList.toggle('hide', items.length < st.limit || st.limit >= 40);
          if (o.onLoad) o.onLoad(d);
        })
        .catch(function () { list.innerHTML = '<div class="empty">News is unavailable right now. It retries automatically.</div>'; });
    }
    load();
    if (o.poll !== false) setInterval(function () { if (!document.hidden) load(); }, o.poll || 180000);
    return { reload: load };
  }
  function ideas(el, o) {
    if (!el) return;
    o = o || {};
    function load() {
      fetch('/api/news/ideas?limit=' + (o.limit || 6) + '&topic=' + encodeURIComponent(o.topic || 'all'))
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (d) {
          var xs = d.ideas || [];
          if (!xs.length) { el.innerHTML = '<div class="empty"><b>No trade ideas yet.</b> Ideas appear when the AI digest (every 20 minutes) finds a story with a clear directional angle.</div>'; return; }
          el.innerHTML = '<div class="ideas">' + xs.map(function (x) {
            return '<div class="ic"><div class="ic-h"><span class="ic-a">' + esc(NAMES[x.asset] || x.asset) + '</span><span class="idea ' + esc(x.bias) + '">' + biasTxt(x.bias) + '</span><span class="ic-b dim">' + esc(x.horizon) + '</span></div>' +
              '<div class="ic-r">' + esc(x.why) + '</div>' +
              '<div class="ic-x">Wrong if: ' + esc(x.risk) + '</div>' +
              '<a class="ic-f" href="' + esc(safe(x.url)) + '" target="_blank" rel="noopener" title="' + esc(x.title) + '">' + esc(x.source) + ', ' + ago(x.published) + '</a></div>';
          }).join('') + '</div><p class="footnote">Generated by an AI model from the headlines in your feed. They are prompts for your own research, not investment advice.</p>';
        })
        .catch(function () { el.innerHTML = '<div class="empty">Ideas are unavailable right now.</div>'; });
    }
    load();
    setInterval(function () { if (!document.hidden) load(); }, 300000);
  }

  window.NewsFeed = { mount: mount };
  window.Ideas = { mount: ideas };
})();
