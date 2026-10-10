/* ================================================================
   NARRATIVE RADAR + PODCAST DIGESTS (Pro) — /api/news/radar · /api/news/episodes
   Radar.mount(el)     coverage split per theme (independent vs mainstream), five lenses
   Episodes.mount(el)  full-episode digests, each theme marked by how much mainstream covers it
   free accounts: a one-line lock note (the server returns 403 PRO_REQUIRED anyway)
   ================================================================ */
(function () {
  'use strict';
  var G = window.GT || {}, esc = G.esc || function (s) { return String(s); };
  var safe = function (u) { try { var x = new URL(String(u)); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : '#'; } catch (e) { return '#'; } };
  function ago(ts) { return G.ago ? G.ago(ts) : new Date(ts).toLocaleString(); }
  function lockNote(el, what) {
    el.innerHTML = '<div class="empty"><span class="protag" style="margin:0 6px 0 0">Pro</span>' + esc(what) + ' is part of Pro. Access is granted by the site admin.</div>';
  }
  function get(u) {
    return fetch(u).then(function (r) {
      if (r.status === 403) return Promise.reject(new Error('PRO'));
      return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status));
    });
  }
  var radarP = null;
  function radarData() { if (!radarP) radarP = get('/api/news/radar').catch(function (e) { radarP = null; throw e; }); return radarP; }
  function lead(h) {
    if (h == null) return '';
    var a = Math.abs(h), t = a >= 48 ? Math.round(a / 24) + ' days' : a + ' h';
    return h > 0 ? 'Independent first by ' + t : h < 0 ? 'Mainstream first by ' + t : 'Same day';
  }
  function toneTxt(v) { return v == null ? 'no read' : v >= 0.25 ? 'bullish' : v <= -0.25 ? 'bearish' : 'mixed'; }

  /* ---------- radar ---------- */
  var LENSES = [
    ['ahead', 'Ahead of the mainstream', 'Independent voices are on it and big outlets are not, or were later by a day or more.'],
    ['louder', 'Louder in independent media', 'Both cover it, but it takes up at least twice the share of independent airtime.'],
    ['tone', 'Same story, different read', 'Both cover it; the tone (bullish vs bearish items) points different ways.'],
    ['rising', 'Rising in the last 3 days', 'Mentions in the last 72 hours run at twice the earlier daily rate or more.'],
    ['mainstream', 'Mainstream only', 'Big outlets keep running it; your independent sources have not touched it.']
  ];
  function row(t, max) {
    var wi = Math.round(100 * t.ind / max), wm = Math.round(100 * t.main / max);
    var ex = (t.exInd && t.exInd[0]) || (t.exMain && t.exMain[0]);
    return '<div class="rd-row">' +
      '<div class="rd-t"><b>' + esc(t.theme) + '</b><span>' + esc(lead(t.leadH) || (t.main ? '' : 'Not on mainstream yet')) +
        (t.indTone != null || t.mainTone != null ? ' · independent ' + toneTxt(t.indTone) + ', mainstream ' + toneTxt(t.mainTone) : '') + '</span></div>' +
      '<div class="rd-bar" title="' + t.ind + ' independent · ' + t.main + ' mainstream"><span class="rd-l"><i style="width:' + wi + '%"></i><em>' + t.ind + '</em></span><span class="rd-r"><i style="width:' + wm + '%"></i><em>' + t.main + '</em></span></div>' +
      (ex ? '<a class="rd-ex" href="' + esc(safe(ex.url)) + '" target="_blank" rel="noopener">' + esc(ex.source) + ': ' + esc(ex.title) + '</a>' : '') +
      '</div>';
  }
  function mountRadar(el) {
    if (!el) return;
    if (G.tier === 'free') return lockNote(el, 'The narrative radar');
    el.innerHTML = '<div class="empty">Reading 14 days of coverage…</div>';
    var cur = 'ahead';
    radarData().then(function (d) {
      var w = d.window || {};
      if (!w.ind && !w.main) { el.innerHTML = '<div class="empty"><b>No tagged stories yet.</b> Themes are tagged as stories arrive; give the crawler a few runs.</div>'; return; }
      function paint() {
        var L = LENSES.filter(function (l) { return l[0] === cur; })[0];
        var xs = d[cur] || [];
        var max = Math.max(1, Math.max.apply(null, xs.map(function (t) { return Math.max(t.ind, t.main); }).concat([1])));
        el.innerHTML =
          '<div class="rd-head"><div class="rd-kpis"><span><b>' + w.ind + '</b> independent items · ' + w.indSources + ' channels</span><span><b>' + w.main + '</b> mainstream items · ' + w.mainSources + ' outlets</span><span class="dim">last ' + w.days + ' days · built ' + ago(d.ts) + '</span></div>' +
          '<div class="tgrp rd-tabs" role="tablist">' + LENSES.map(function (l) { return '<button type="button" data-l="' + l[0] + '"' + (l[0] === cur ? ' class="on"' : '') + '>' + esc(l[1]) + ' <span class="dim">' + ((d[l[0]] || []).length) + '</span></button>'; }).join('') + '</div></div>' +
          '<p class="rd-what">' + esc(L[2]) + '</p>' +
          '<div class="rd-legend"><span class="li">Independent</span><span class="lm">Mainstream</span></div>' +
          (xs.length ? '<div class="rd-list">' + xs.map(function (t) { return row(t, max); }).join('') + '</div>' : '<div class="empty">Nothing in this lens right now.</div>');
      }
      paint();
      el.addEventListener('click', function (e) { var b = e.target.closest('[data-l]'); if (!b) return; cur = b.dataset.l; paint(); });
    }).catch(function (e) { if (e.message === 'PRO') lockNote(el, 'The narrative radar'); else el.innerHTML = '<div class="empty">The radar is unavailable right now.</div>'; });
  }

  /* ---------- episodes ---------- */
  var NAMES = { XAU: 'Gold', XAG: 'Silver', DXY: 'US dollar', WTI: 'WTI crude', BRENT: 'Brent', NATGAS: 'Natural gas', SPX: 'S&P 500', NDX: 'Nasdaq 100', UST10Y: '10Y Treasury', BTC: 'Bitcoin', COPPER: 'Copper', BDRY: 'Dry bulk freight' };
  function mountEpisodes(el, o) {
    if (!el) return;
    o = o || {};
    if (G.tier === 'free') return lockNote(el, 'Full podcast and video digests');
    el.innerHTML = '<div class="empty">Loading digests…</div>';
    Promise.all([get('/api/news/episodes?limit=' + (o.limit || 9)), radarData().catch(function () { return null; })]).then(function (res) {
      var d = res[0], R = res[1];
      var cov = {};
      if (R) (R.all || []).forEach(function (t) { cov[t.theme] = t.main; });
      var xs = d.episodes || [];
      if (!xs.length) {
        var q = (d.queue || []).map(function (x) { return x.n + ' ' + x.status; }).join(', ');
        el.innerHTML = '<div class="empty"><b>No digests yet.</b> New episodes from your independent and favorite channels are transcribed and summarized through the day (up to 4 a day).' + (q ? ' Queue this week: ' + esc(q) + '.' : '') + '</div>';
        return;
      }
      el.innerHTML = '<div class="ep-grid">' + xs.map(function (e) {
        var s = e.summary;
        var th = (s.themes || []).map(function (t) {
          var m = cov[t]; var k = m == null ? '' : m === 0 ? ' quiet' : m < 4 ? ' some' : ' heavy';
          var tip = m == null ? 'not tracked yet' : m === 0 ? 'no mainstream coverage in 14 days' : m + ' mainstream items in 14 days';
          return '<span class="ep-th' + k + '" title="' + esc(tip) + '">' + esc(t) + '</span>';
        }).join('');
        var as = (s.assets || []).map(function (a) { return '<span class="idea ' + esc(a.bias) + '" title="' + esc(a.why) + '">' + (a.bias === 'long' ? 'Long' : a.bias === 'short' ? 'Short' : 'Watch') + ' ' + esc(NAMES[a.asset] || a.asset) + '</span>'; }).join('');
        return '<article class="ep">' +
          '<div class="ep-top">' + (e.thumb ? '<img loading="lazy" alt="" src="' + esc(safe(e.thumb)) + '">' : '') +
            '<div><div class="ep-src">' + esc(e.source || 'YouTube') + (e.cls === 'independent' ? ' <span class="indep">Independent</span>' : '') + ' · ' + ago(e.published) + '</div>' +
            '<a class="ep-t" href="' + esc(safe(e.url)) + '" target="_blank" rel="noopener">' + esc(e.title) + '</a></div></div>' +
          '<h4>' + esc(s.headline) + '</h4><p>' + esc(s.summary) + '</p>' +
          (as ? '<div class="nf-tags">' + as + '<span class="ep-st">' + esc(s.stance) + '</span></div>' : '<div class="nf-tags"><span class="ep-st">' + esc(s.stance) + '</span></div>') +
          (s.contrarian ? '<p class="ep-c"><b>Vs consensus:</b> ' + esc(s.contrarian) + '</p>' : '') +
          (th ? '<div class="ep-ths"><span class="dim">Mainstream coverage of these themes:</span> ' + th + '</div>' : '') +
          '<details><summary>Key points' + (s.risks && s.risks.length ? ', risks' : '') + (s.claims && s.claims.length ? ', claims to check' : '') + '</summary>' +
            (s.key_points && s.key_points.length ? '<ul>' + s.key_points.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
            (s.risks && s.risks.length ? '<div class="secH">Risks they flag</div><ul>' + s.risks.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
            (s.claims && s.claims.length ? '<div class="secH">Claims worth checking</div><ul>' + s.claims.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
          '</details>' +
          '<div class="ep-f dim">' + (e.mode === 'captions' ? 'From the full transcript' : e.mode === 'feed' ? 'From the short feed description only' : 'From the video description (no captions)') + (e.chars ? ' · ' + Math.round(e.chars / 1000) + 'k characters' : '') + ' · AI summary, open the episode before acting</div>' +
          '</article>';
      }).join('') + '</div>';
    }).catch(function (e) { if (e.message === 'PRO') lockNote(el, 'Full podcast and video digests'); else el.innerHTML = '<div class="empty">Digests are unavailable right now.</div>'; });
  }
  window.Radar = { mount: mountRadar };
  window.Episodes = { mount: mountEpisodes };
})();
