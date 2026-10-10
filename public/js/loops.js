/* LOOPS
   INIT   /api/loops (status of A–D + daily jobs + Outlook weights) and /api/evo (populations)
   POLL   every 30 s
   PUBLISH flow diagram, one card per loop, evolution detail, feature coverage, admin controls */
(function () {
  'use strict';
  if (window.GT && GT.locked) return; // free account: shell shows the Pro card
  var G = window.GT, $ = function (s) { return document.querySelector(s); };
  var esc = G.esc, fmt = G.fmt, sgn = G.sgn;
  var L = null, E = null, EH = '1d';
  var ADMIN = false; try { ADMIN = localStorage.getItem('git-role') === 'admin'; } catch (e) { }
  var MN = { naive: 'Stays put', drift: 'Momentum', revert: 'Back to mean', signal: 'Signal (B+C)', evo: 'Evolved' };
  var GN = { price: 'Price trend', behavior: 'Crowd behavior', macro: 'Macro', signals: 'Model signals', sentiment: 'News sentiment', regulatory: 'Regulatory and policy', weather: 'Weather' };
  var CN = { price: 'Price trend', behavior: 'Crowd behavior', macro: 'Macro', sentiment: 'Sentiment', regulatory: 'Regulatory and policy', weather: 'Weather' };
  function ago(t) { return t ? G.ago(t) : 'never'; }
  function pulse(t, every) { if (!t) return '<i class="pulse"></i>'; var a = Date.now() - t; return '<i class="pulse ' + (a < every * 1.6 ? 'on' : 'late') + '"></i>'; }
  function pc(x, d) { return x == null || !isFinite(x) ? '–' : (x * 100).toFixed(d == null ? 1 : d) + '%'; }

  function flow() {
    var l = L.ledger, m = L.ml, o = L.outlook, f = L.features || {};
    var src = [['Gold spot, every minute', 'gold-api.com, 2nd-source check'], ['Markets and macro, daily', 'Yahoo, FRED, ECB, CoinGecko'], ['Positioning and filings', 'CFTC weekly, SEC Form 4'],
      ['Your news', 'YouTube + RSS, every 10 min'], ['Policy uncertainty', 'FRED EPU, daily'], ['Weather', 'Open-Meteo temps and rain']];
    var st = [['ticks', 'minute prices'], ['series_points', 'daily warehouse'], ['fx_daily', (f.n || 0) + ' feature rows'], ['news_items, insider_tx', 'text and filings'], ['forecast_log, outlook_log', 'every call, graded later']];
    var ev = E && E.pops ? E.pops['1d'] : null;
    var lps = [
      ['A', 'Forecast ledger', 'every minute', l.lastTick ? 'last tick ' + ago(l.lastTick.ts) : 'waiting for market hours', pulse(l.lastTick && l.lastTick.ts, 6e4 * 5), (l.ticksToday || 0) + ' ticks today'],
      ['B', '5-day direction model', 'every 6 h, refit weekly', m.snap ? 'p(up) ' + Math.round(m.snap.p * 100) + '%' : 'warming up', pulse(m.snap && m.snap.ts, 6 * 36e5), m.live ? Math.round(m.live.rate * 100) + '% hit, ' + m.live.n + ' graded' : 'grading pending'],
      ['C', 'Outlook', 'about every 6 h', o ? 'economy ' + o.econ + ' · gold ' + o.gold : 'warming up', pulse(o && o.ts, 6 * 36e5), o ? o.stance : ''],
      ['D', 'Evolution', '8 of every 10 min', ev ? 'gen ' + ev.gen + ' · ' + ev.evals + ' children' : 'waits for the feature table', pulse(ev ? Date.now() - 5 * 6e4 : null, 6e4 * 10), E && E.champs && E.champs['1d'] ? (E.champs['1d'].promoted ? 'champion voting' : 'champion on trial') : 'no champion yet']
    ];
    var outs = [['Outlook page', 'scores, stance, odds'], ['Ledger', 'predicted vs actual'], ['ML strip', 'on every desk'], ['Gold desk and AI page', 'model card, agents'], ['Data explorer', 'every column, CSV']];
    var col = function (title, items) { return '<div class="fcol"><h5>' + title + '</h5>' + items.map(function (x) { return '<div class="nd">' + esc(x[0]) + '<small>' + esc(x[1]) + '</small></div>'; }).join('') + '</div>'; };
    $('#flow').innerHTML = '<div class="flow">' + col('Sources', src) + '<div class="farr">→</div>' + col('Stored in D1', st) + '<div class="farr">→</div>' +
      '<div class="fcol"><h5>Loops</h5>' + lps.map(function (x) { return '<div class="lp"><span class="k">' + x[0] + '</span><b>' + x[4] + esc(x[1]) + '</b><span class="s">' + esc(x[5]) + '</span><span class="c">' + esc(x[2]) + ' · ' + esc(x[3]) + '</span></div>'; }).join('') + '</div>' +
      '<div class="farr">→</div>' + col('Outputs', outs) +
      '<div class="back">Feedback: every output is graded against the real price → errors reweight the ledger blend nightly → B refits weekly → D breeds the next networks from the winners → C is scored at 91 days</div></div>';
  }

  function loopA() {
    var l = L.ledger, w = l.weights || {}, H = ['1m', '30m', '1d', '1w', '30d'], M = ['naive', 'drift', 'revert', 'signal', 'evo'];
    var ctx = l.context;
    var h = '<div class="kv4"><div class="kpi"><label>Ticks today</label><b>' + (l.ticksToday || 0) + '</b><small>' + (l.lastTick ? '$' + fmt(l.lastTick.price, 2) + ', ' + ago(l.lastTick.ts) : 'market closed or warming up') + '</small></div>' +
      '<div class="kpi"><label>Open forecasts</label><b>' + (l.open || 0) + '</b><small>waiting for their target time</small></div>' +
      '<div class="kpi"><label>Graded today</label><b>' + (l.gradedToday || 0) + '</b><small>against the real price</small></div></div>';
    h += '<div class="secH">Blend weights by horizon, relearned nightly ' + (l.weightsAt ? '(' + ago(l.weightsAt) + ')' : '(priors until 20 graded)') + '</div>';
    h += '<div class="tbwrap"><table class="tb wt"><thead><tr><th>Horizon</th>' + M.map(function (m) { return '<th>' + MN[m] + '</th>'; }).join('') + '</tr></thead><tbody>' +
      H.map(function (hz) {
        var r = w[hz] || {}, day = hz === '1d' || hz === '1w' || hz === '30d';
        var top = M.reduce(function (a, m) { return (r[m] || 0) > (r[a] || 0) ? m : a; }, 'naive');
        return '<tr><td>' + hz + '</td>' + M.map(function (m) { var v = r[m]; var na = !day && (m === 'signal' || m === 'evo'); return '<td class="' + (m === top ? 'hi' : '') + '">' + (na ? '<span class="dim">–</span>' : v == null ? '–' : Math.round(v * 100) + '%') + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
    if (ctx) h += '<p class="note" style="font-size:13px;color:var(--mut);margin-top:10px">Day-horizon inputs right now: Loop B p(up) ' + (ctx.p == null ? '–' : Math.round(ctx.p * 100) + '%') + ', Loop C gold ' + (ctx.score == null ? '–' : fmt(ctx.score, 1) + '/10') + ', evolved champions voting: ' + (Object.keys(ctx.evo || {}).join(', ') || 'none yet') + '.</p>';
    $('#la').innerHTML = h;
  }
  function loopB() {
    var m = L.ml, s = m.snap, md = m.model && m.model.metrics;
    var h = '<div class="kv4"><div class="kpi"><label>p(gold up in 5 days)</label><b class="' + (s && s.p >= 0.5 ? 'up' : 'dn') + '">' + (s ? Math.round(s.p * 100) + '%' : '–') + '</b><small>' + (s ? 'regime ' + esc(G.sc(s.regime || '')) + ', ' + ago(s.ts) : 'first run within 6 h') + '</small></div>' +
      '<div class="kpi"><label>Walk-forward accuracy</label><b>' + (md ? pc(md.lrAcc, 0) + ' / ' + pc(md.gbsAcc, 0) : '–') + '</b><small>logistic / boosted, ' + (md ? md.walkForwardN + ' unseen days' : 'after first fit') + '</small></div>' +
      '<div class="kpi"><label>Live hit rate</label><b>' + (m.live ? pc(m.live.rate, 0) : '–') + '</b><small>' + (m.live ? m.live.n + ' graded calls' : 'grading starts after 5 trading days') + '</small></div></div>';
    h += '<div class="secH">How one prediction is made</div><p class="note" style="font-size:13px;color:var(--mut)">12 features → logistic regression + 16 boosted stumps (refit weekly on 420 days, 5-day embargo) → 3-state regime filter → 10 agents vote → 10 Bayesian evidence updates → p(up). ' + (m.model ? 'Last fit ' + ago(m.model.trainedAt) + ' on ' + md.samples + ' days.' : '') + '</p>';
    if (s && s.agents && s.agents.length) h += '<div class="agents">' + s.agents.map(function (a) { return '<span class="' + (a.p > 0.55 ? 'u' : a.p < 0.45 ? 'd' : '') + '">' + esc(G.sc(a.name)) + ' ' + Math.round(a.p * 100) + '%</span>'; }).join('') + '</div>';
    $('#lb').innerHTML = h;
  }
  function loopC() {
    var o = L.outlook, c = L.cats;
    var h = '<div class="kv4"><div class="kpi"><label>Economy</label><b>' + (o ? fmt(o.econ, 1) + '/10' : '–') + '</b><small>' + (o ? ago(o.ts) : 'first build within the hour') + '</small></div>' +
      '<div class="kpi"><label>Gold, 3–12 months</label><b>' + (o ? fmt(o.gold, 1) + '/10' : '–') + '</b><small>' + (o ? esc(o.stance) : '') + '</small></div></div>';
    h += '<div class="secH">Input weights for the Outlook score ' + (ADMIN ? '(drag, then save: the outlook rebuilds)' : '(set by your admin)') + '</div>';
    h += c.names.map(function (n) { var v = c.weights[n]; return '<div class="sl"><span>' + CN[n] + '</span>' + (ADMIN ? '<input type="range" min="0" max="2" step="0.05" value="' + v + '" data-c="' + n + '" aria-label="' + CN[n] + ' weight">' : '<span class="dots5">' + [0.4, 0.8, 1.2, 1.6, 2].map(function (t) { return '<i class="' + (v >= t - 0.2 ? 'on' : '') + '"></i>'; }).join('') + '</span>') + '<b>' + fmt(v, 2) + '×</b></div>'; }).join('');
    if (ADMIN) h += '<div class="btnrow"><button class="btn auto sm" id="saveW" type="button">Save and rebuild outlook</button><button class="btn ghost auto sm" id="resetW" type="button">Reset to 1×</button><span class="tmeta" id="wMsg" style="font-size:13px;color:var(--mut)"></span></div>';
    $('#lc').innerHTML = h;
    if (ADMIN) {
      Array.prototype.forEach.call(document.querySelectorAll('#lc input[type=range]'), function (r) { r.addEventListener('input', function () { r.parentNode.querySelector('b').textContent = fmt(+r.value, 2) + '×'; }); });
      $('#saveW').addEventListener('click', function () { saveW(false); });
      $('#resetW').addEventListener('click', function () { saveW(true); });
    }
  }
  function saveW(reset) {
    var w = {}; Array.prototype.forEach.call(document.querySelectorAll('#lc input[type=range]'), function (r) { w[r.dataset.c] = reset ? 1 : +r.value; });
    $('#wMsg').textContent = 'Rebuilding…';
    fetch('/api/admin/outlook/weights', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(w) }).then(function (r) { return r.json(); })
      .then(function (d) { $('#wMsg').textContent = d.ok ? 'Saved. Economy ' + d.econ + ', gold ' + d.gold + ' (' + d.stance + ').' : (d.error || 'Failed'); load(); })
      .catch(function () { $('#wMsg').textContent = 'Failed to save.'; });
  }
  function loopD() {
    var h = '';
    if (!E || !E.data) { $('#ld').innerHTML = '<div class="empty"><b>Waiting for the feature table.</b> The :x7 maintenance slot builds weather history, then backfills the feature table, then the first population hatches.</div>'; return; }
    var d = E.data;
    h += '<div class="kv4"><div class="kpi"><label>Feature rows</label><b>' + d.rows + '</b><small>' + esc(d.from) + ' to ' + esc(d.to) + '</small></div>';
    ['1d', '1w', '30d'].forEach(function (hz) {
      var p = E.pops[hz], c = E.champs[hz];
      h += '<div class="kpi"><label>' + hz + ' population</label><b>' + (p ? 'gen ' + p.gen : '–') + '</b><small>' + (p ? p.evals + ' children, ' + (p.evals ? Math.round(p.accepted / p.evals * 100) : 0) + '% kept' : 'hatches on the next step') + (c ? ' · champion ' + (c.vk != null ? 'validation ' + sgn(c.vk) + fmt(c.vk * 100, 1) + '%, ' : '') + 'test ' + sgn(c.hk) + fmt(c.hk * 100, 1) + '% ' + (c.promoted ? 'voting' : 'on trial') : '') + '</small></div>';
    });
    h += '</div>';
    var ft = L.ledger.firstTick, days = ft ? Math.floor((Date.now() - ft) / 864e5) : 0;
    h += '<p class="note" style="font-size:13px;color:var(--mut)">Each step: pick 2 parents by tournament → mix their weights, input mask and group gates → mutate (step size adapts per genome) → score on today\'s fixed 200-day sample → keep the child only if it beats the worst member. Nightly gate: training stops before the last ~2 months. Every genome is scored on a validation window it never trained on; the best one by validation is then checked once on a later test window. It votes in the ledger only if both beat "stays put" by 2%, so the pick is not graded on the days used to pick it.</p>' +
      '<p class="note" style="font-size:13px;color:var(--mut)">Minute horizons (1m, 30m) start evolving after 30 days of stored ticks: <b>' + Math.min(days, 30) + ' of 30</b>.</p>';
    $('#ld').innerHTML = h;
  }

  function evoDetail() {
    if (!E || !E.data) { $('#evo').innerHTML = '<div class="empty">The first population hatches once the feature table exists.</div>'; return; }
    var p = E.pops[EH], c = E.champs[EH], log = (E.log || []).filter(function (r) { return r.h === EH; });
    var h = '<div class="legend"><span class="sw"><i style="background:var(--blue)"></i>Best fitness</span><span class="sw"><i style="background:var(--dim)"></i>Median fitness</span><span class="sw"><i style="background:var(--gold);border-radius:50%"></i>Champion skill on the test window</span></div>' +
      '<div class="chartbox"><canvas id="cvEvo" aria-label="Fitness over time"></canvas><div class="tip" id="tipEvo"></div></div>';
    // learned group weights
    var popG = E.groups.map(function (_, k) { if (!p) return null; var s = 0; p.genomes.forEach(function (g) { s += g.g[k] * (g.mask.some(function (m, j) { return m && E.featGroup[j] === k; }) ? 1 : 0); }); return s / p.genomes.length; });
    var use = E.groups.map(function (_, k) { if (!c) return null; var n = 0, t = 0; c.mask.forEach(function (m, j) { if (E.featGroup[j] === k) { t++; n += m; } }); return [n, t]; });
    h += '<div class="secH" style="margin-top:16px">What the networks learned to listen to</div><div class="tbwrap"><table class="tb wt"><thead><tr><th>Input group</th><th>Designed weight</th><th>Population (gate × in use)</th><th>Champion gate</th><th>Champion inputs used</th></tr></thead><tbody>' +
      E.groups.map(function (gname, k) {
        return '<tr><td>' + GN[gname] + '</td><td>1.00</td><td>' + (popG[k] == null ? '–' : fmt(popG[k], 2)) + '</td><td>' + (c ? fmt(c.gates[k], 2) : '–') + '</td><td>' + (use[k] ? use[k][0] + ' of ' + use[k][1] : '–') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    if (p) {
      h += '<div class="secH" style="margin-top:16px">Population, best first (' + p.size + ' networks)</div><div class="tbwrap"><table class="tb"><thead><tr><th>Id</th><th class="r">Fitness</th><th class="r">Train skill</th><th class="r">Validation</th><th class="r">Test</th><th class="r">Inputs</th><th>Input mask</th><th class="r">Step σ</th><th class="r">Born gen</th><th>Parents</th></tr></thead><tbody>' +
        p.genomes.slice(0, 12).map(function (g) {
          return '<tr' + (c && c.id === g.id ? ' class="hl"' : '') + '><td>#' + g.id + '</td><td class="r">' + fmt(g.fit, 3) + '</td><td class="r">' + pc(g.sk) + '</td><td class="r">' + (g.hk == null ? '–' : pc(g.hk)) + '</td><td class="r">' + g.inputs + '</td>' +
            '<td><span class="mask" title="' + esc(E.feats.filter(function (_, j) { return g.mask[j]; }).join(', ')) + '">' + g.mask.map(function (m) { return '<i class="' + (m ? 'on' : '') + '"></i>'; }).join('') + '</span></td><td class="r">' + fmt(g.sg, 3) + '</td><td class="r">' + g.gen + '</td><td class="dim">' + (g.par.length ? '#' + g.par.join(', #') : 'seed') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    $('#evo').innerHTML = h;
    var blue = G.css('--blue'), dim = G.css('--dim'), gold = G.css('--gold');
    GK.line(document.getElementById('cvEvo'), document.getElementById('tipEvo'), {
      series: [
        { name: 'Best fitness', color: blue, width: 2, pts: log.map(function (r) { return { x: Date.parse(r.day), y: r.best_fit }; }) },
        { name: 'Median fitness', color: dim, width: 1.5, pts: log.map(function (r) { return { x: Date.parse(r.day), y: r.med_fit }; }) },
        { name: 'Champion test skill', color: gold, noLine: true, dots: true, pts: log.filter(function (r) { return r.champ_hk != null; }).map(function (r) { return { x: Date.parse(r.day), y: r.champ_hk }; }) },
      ], refs: [{ y: 0, label: 'naive', left: true }, { y: 0.02, label: 'vote line +2%', color: gold }],
      yFmt: function (v) { return fmt(v * 100, 1) + '%'; }, empty: 'One point per day after the nightly gate runs'
    });
  }
  function features() {
    if (!E) return;
    var cov = (E.data && E.data.coverage) || {};
    $('#feat').innerHTML = '<p class="note" style="font-size:13px;color:var(--mut);margin-bottom:12px">Coverage = share of stored days that have a value. Columns that only exist going forward (your news, insider filings, model signals) start near 0% and fill in daily; the networks treat a missing value as "no information".</p><div class="fgrid">' +
      E.groups.map(function (gname, k) {
        var fs = E.feats.filter(function (_, j) { return E.featGroup[j] === k; });
        return '<div class="fg"><h6>' + GN[gname] + '<span>' + fs.length + ' inputs</span></h6>' + fs.map(function (f) { var c = cov[f]; return '<div class="' + (c != null && c < 0.2 ? 'low' : '') + '"><span>' + esc(f) + '</span><b>' + (c == null ? '–' : Math.round(c * 100) + '%') + '</b></div>'; }).join('') + '</div>';
      }).join('') + '</div>';
  }
  function maint() {
    var m = L.maint || {}, last = m.last || [];
    $('#mlog').innerHTML = last.length ? last.slice(0, 10).map(function (x) { return '<div><span>' + esc(x.job) + '<br><small class="dim">' + ago(x.at) + '</small></span><span class="o">' + esc(x.out) + '</span></div>'; }).join('')
      : '<div><span class="dim">No jobs yet</span><span class="o">The first :x7 slot after deploy builds the weather history.</span></div>';
  }
  function admin() {
    if (!ADMIN) return;
    $('#l-admin').classList.remove('hide');
    var jobs = [['weather', 'Rebuild weather history'], ['backfill', 'Rebuild features (backfill)'], ['features', 'Refresh today\'s features'], ['evodata', 'Rebuild evolution data'], ['rollup', 'Ledger roll-up'], ['gate:1d', 'Gate 1d'], ['gate:1w', 'Gate 1w'], ['gate:30d', 'Gate 30d']];
    $('#jobs').innerHTML = jobs.map(function (j) { return '<button class="btn ghost auto sm" type="button" data-job="' + j[0] + '">' + j[1] + '</button>'; }).join('');
    var deep = ['yahoo:GC=F', 'yahoo:DX-Y.NYB', 'yahoo:^VIX', 'yahoo:CL=F', 'fred:DFII10', 'fred:T10Y3M', 'fred:BAA10Y', 'fred:USEPUINDXD'];
    $('#deep').innerHTML = deep.map(function (k) { return '<button class="btn ghost auto sm" type="button" data-deep="' + k + '">' + esc(k.split(':')[1]) + '</button>'; }).join('');
    $('#l-admin').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var url = b.dataset.job ? '/api/admin/maint/run' : '/api/admin/storage/deep', body = b.dataset.job ? { job: b.dataset.job } : { key: b.dataset.deep };
      b.disabled = true; $('#admMsg').textContent = 'Running ' + b.textContent + '…';
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); })
        .then(function (d) { $('#admMsg').textContent = b.textContent + ': ' + (d.out || (d.ran ? d.ran.map(function (x) { return x.key + ' ' + (x.ok ? x.rows + ' rows' : x.error); }).join('; ') : JSON.stringify(d).slice(0, 200))); load(); })
        .catch(function () { $('#admMsg').textContent = 'Request failed.'; }).then(function () { b.disabled = false; });
    }, { once: false });
  }
  $('#eh').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-h]'); if (!b) return; EH = b.dataset.h;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
    evoDetail();
  });
  var adminBound = false;
  function load() {
    Promise.all([G.getJSON('/api/loops'), G.getJSON('/api/evo').catch(function () { return null; })]).then(function (r) {
      L = r[0]; E = r[1];
      if (E && E.pops && !E.pops[EH]) { var hz = ['1d', '1w', '30d'].filter(function (x) { return E.pops[x]; })[0]; if (hz) { EH = hz; Array.prototype.forEach.call(document.querySelectorAll('#eh button'), function (x) { x.classList.toggle('on', x.dataset.h === EH); }); } }
      flow(); loopA(); loopB(); loopC(); loopD(); evoDetail(); features(); maint();
      if (!adminBound) { admin(); adminBound = true; }
      $('#asof').textContent = 'Updated ' + new Date(L.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }).catch(function () { $('#flow').innerHTML = '<div class="empty">Loop status is unavailable right now. Retrying.</div>'; });
  }
  load();
  setInterval(function () { if (!document.hidden && !document.activeElement.matches('input[type=range]')) load(); }, 30000);
})();
