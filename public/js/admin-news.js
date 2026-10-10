/* ADMIN · NEWS SOURCES
   INIT    topic chips → load /api/admin/news/sources when the tab opens
   EVALUATE add (resolve channel/feed + first crawl), star, pause, delete, crawl now
   PUBLISH table of sources with item counts, AI coverage and last error */
(function () {
  'use strict';
  var G = window.GT, esc = G.esc, $ = function (s) { return document.querySelector(s); };
  var TOPICS = ['markets', 'gold', 'macro', 'fx', 'energy', 'agri', 'shipping', 'crypto', 'water', 'land'];
  var loaded = false;
  $('#srcTopics').innerHTML = '<span class="tmeta">Topics:</span>' + TOPICS.map(function (t) {
    return '<label><input type="checkbox" value="' + t + '"' + (t === 'markets' || t === 'gold' ? ' checked' : '') + '>' + t.charAt(0).toUpperCase() + t.slice(1) + '</label>';
  }).join('');
  function post(u, b) {
    return fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.detail || d.hint || d.error || ('HTTP ' + r.status)); return d; }); });
  }
  function load() {
    loaded = true;
    G.getJSON('/api/admin/news/sources').then(function (d) {
      var S = d.sources || [];
      var yt = S.filter(function (s) { return s.kind === 'youtube'; }).length;
      $('#srcMeta').textContent = S.length + ' sources · ' + yt + ' YouTube · ' + (S.length - yt) + ' RSS';
      $('#srcTbl').innerHTML = '<thead><tr><th></th><th>Source</th><th>Topics</th><th class="r">Stored</th><th class="r">AI digested</th><th>Last fetch</th><th></th></tr></thead><tbody>' +
        S.map(function (s) {
          var err = s.last_error ? '<div class="dn" style="font-size:12px;white-space:normal;max-width:340px">' + esc(s.last_error) + '</div>' : '';
          return '<tr' + (s.enabled ? '' : ' style="opacity:.55"') + '><td><button class="star' + (s.favorite ? ' on' : '') + '" data-a="fav" data-id="' + s.id + '" data-v="' + (s.favorite ? 0 : 1) + '" title="' + (s.favorite ? 'Unstar' : 'Star as favorite') + '" aria-label="Favorite">★</button></td>' +
            '<td><span class="kindtag' + (s.kind === 'youtube' ? ' yt' : '') + '">' + (s.kind === 'youtube' ? 'YouTube' : 'RSS') + '</span> <b>' + esc(s.name) + '</b><div class="dim" style="font-size:12px;max-width:380px;overflow:hidden;text-overflow:ellipsis">' + esc(s.url) + '</div>' + err + '</td>' +
            '<td class="mut">' + esc(String(s.topics || '').split(',').join(', ')) + '<div><button class="abtn sm ghost" data-a="cls" data-id="' + s.id + '" data-v="' + (s.cls === 'independent' ? 'mainstream' : 'independent') + '" title="Radar class: click to switch">' + (s.cls === 'independent' ? 'Independent' : 'Mainstream') + '</button></div></td>' +
            '<td class="r">' + (s.stored || 0) + '</td><td class="r">' + (s.summarized || 0) + '</td>' +
            '<td class="mut">' + (s.last_fetch ? G.ago(s.last_fetch) : 'Never') + (s.fails ? ' · <span class="dn">' + s.fails + ' fails</span>' : '') + '</td>' +
            '<td class="r" style="white-space:nowrap"><button class="abtn sm ghost" data-a="crawl" data-id="' + s.id + '">Crawl</button> <button class="abtn sm ghost" data-a="en" data-id="' + s.id + '" data-v="' + (s.enabled ? 0 : 1) + '">' + (s.enabled ? 'Pause' : 'Resume') + '</button> <button class="abtn sm warn" data-a="del" data-id="' + s.id + '" data-n="' + esc(s.name) + '">Remove</button></td></tr>';
        }).join('') + '</tbody>';
    }).catch(function (e) { $('#srcTbl').innerHTML = '<tbody><tr><td class="err">Could not load sources: ' + esc(e.message) + '</td></tr></tbody>'; });
  }
  $('#srcTbl').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-a]'); if (!b) return;
    var id = +b.dataset.id, a = b.dataset.a, p;
    b.disabled = true;
    if (a === 'fav') p = post('/api/admin/news/sources/update', { id: id, favorite: b.dataset.v === '1' });
    else if (a === 'cls') p = post('/api/admin/news/sources/update', { id: id, cls: b.dataset.v });
    else if (a === 'en') p = post('/api/admin/news/sources/update', { id: id, enabled: b.dataset.v === '1' });
    else if (a === 'del') { if (!confirm('Remove ' + b.dataset.n + ' and its stored items?')) { b.disabled = false; return; } p = post('/api/admin/news/sources/delete', { id: id }); }
    else if (a === 'crawl') p = post('/api/admin/news/crawl', { ids: [id] }).then(function (d) { $('#crawlMeta').textContent = 'Fetched ' + (d.crawl.fetched || 0) + ', added ' + (d.crawl.added || 0) + (d.digest ? ', AI digested ' + (d.digest.done || d.digest.summarized || 0) : ''); });
    p.then(load).catch(function (er) { $('#crawlMeta').textContent = er.message; b.disabled = false; });
  });
  $('#srcForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var topics = Array.prototype.map.call(document.querySelectorAll('#srcTopics input:checked'), function (i) { return i.value; }).join(',');
    var btn = $('#srcAdd'); btn.disabled = true; $('#srcMsg').textContent = 'Resolving the channel and running the first crawl…';
    post('/api/admin/news/sources', { url: $('#srcUrl').value.trim(), name: $('#srcName').value.trim() || undefined, topics: topics, favorite: $('#srcFav').checked })
      .then(function (d) {
        $('#srcMsg').innerHTML = 'Added <b>' + esc(d.source.name) + '</b>. First crawl found ' + (d.crawl.fetched || 0) + ' items, ' + (d.crawl.added || 0) + ' new.' + (d.crawl.errors && d.crawl.errors.length ? ' <span class="dn">' + esc(d.crawl.errors[0]) + '</span>' : '');
        $('#srcUrl').value = ''; $('#srcName').value = ''; load();
      })
      .catch(function (er) { $('#srcMsg').innerHTML = '<span class="dn">' + esc(er.message) + '</span>'; })
      .then(function () { btn.disabled = false; });
  });
  $('#bCrawl').addEventListener('click', function () {
    var b = this; b.disabled = true; $('#crawlMeta').textContent = 'Crawling…';
    post('/api/admin/news/crawl', {}).then(function (d) { $('#crawlMeta').textContent = 'Fetched ' + (d.crawl.fetched || 0) + ', added ' + (d.crawl.added || 0) + (d.crawl.errors && d.crawl.errors.length ? ', ' + d.crawl.errors.length + ' errors' : ''); load(); })
      .catch(function (er) { $('#crawlMeta').textContent = er.message; }).then(function () { b.disabled = false; });
  });
  var by = $('#bYt');
  if (by) by.addEventListener('click', function () {
    var b = this; b.disabled = true; $('#crawlMeta').textContent = 'Running one digest step…';
    post('/api/admin/news/ytstep', {}).then(function (d) { $('#crawlMeta').textContent = 'Podcast digest: ' + d.step + (d.note ? ' · ' + d.note : ''); })
      .catch(function (er) { $('#crawlMeta').textContent = er.message; }).then(function () { b.disabled = false; });
  });
  $('#bRefs').addEventListener('click', function () {
    var b = this; b.disabled = true; $('#crawlMeta').textContent = 'Refreshing…';
    post('/api/admin/refs/refresh', {}).then(function () { $('#crawlMeta').textContent = 'Calendar and drought map refreshed.'; })
      .catch(function (er) { $('#crawlMeta').textContent = er.message; }).then(function () { b.disabled = false; });
  });
  document.getElementById('tabs').addEventListener('click', function (e) { var b = e.target.closest('button[data-t]'); if (b && b.dataset.t === 'news' && !loaded) load(); });
  if ($('#s-news').classList.contains('on')) load();
})();
