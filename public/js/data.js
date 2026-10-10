/* DATA EXPLORER
   INIT   /api/data/tables (whitelist, columns, labels, row counts, series ids)
   POLL   on demand only (each page = one bounded D1 query)
   PUBLISH sortable, filterable column grid, per-column summary with sparklines, CSV export */
(function () {
  'use strict';
  if (window.GT && GT.locked) return; // free account: shell shows the Pro card
  var G = window.GT, $ = function (s) { return document.querySelector(s); };
  var esc = G.esc;
  var T = [], SIDS = [], cur = null, st = { order: null, dir: null, offset: 0, filters: [], cols: null };
  var qs = new URLSearchParams(location.search);

  function tdef(n) { return T.find(function (t) { return t.name === n; }); }
  function isNum(c) { return /INT|REAL|NUM|FLOAT|DOUB/.test(c.type); }
  function fmtCell(c, v) {
    if (v == null) return '<td class="nl">–</td>';
    if (isNum(c)) {
      if (/^(ts|made|target|actual_ts|published|filed|tx_date|updated|created_at|last_fetch|last_ok|trained_at|src_ts|built|at|fetched)$/.test(c.name) && v > 1e12) return '<td>' + esc(new Date(v).toISOString().replace('T', ' ').slice(0, 16)) + '</td>';
      var a = Math.abs(v), d = a >= 1000 ? 2 : a >= 1 ? 3 : 4;
      return '<td class="n">' + (Number.isInteger(v) ? v.toLocaleString('en-US') : Number(v).toLocaleString('en-US', { maximumFractionDigits: d })) + '</td>';
    }
    var s = String(v);
    if (/^https?:\/\//.test(s)) return '<td><a href="' + esc(G.safeUrl(s)) + '" target="_blank" rel="noopener noreferrer">' + esc(s.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)) + '</a></td>';
    return '<td title="' + esc(s.slice(0, 400)) + '">' + esc(s.slice(0, 160)) + '</td>';
  }
  function pick(name) {
    cur = tdef(name) || T[0]; if (!cur) return;
    st = { order: cur.key, dir: cur.dir, offset: 0, filters: [], cols: null };
    if (cur.need === 'id') {
      $('#sid').classList.remove('hide');
      var want = qs.get('id') || (SIDS.find(function (s) { return s.id === 'GOLD'; }) || SIDS[0] || {}).id;
      $('#sid').value = want; st.filters = [{ col: 'id', op: 'eq', v: want }];
    } else $('#sid').classList.add('hide');
    $('#tdesc').textContent = cur.desc;
    $('#tmeta').textContent = (cur.rows != null ? cur.rows.toLocaleString('en-US') + ' rows · ' : 'large table · ') + cur.columns.length + ' columns' + (cur.big ? ' · sorts on ' + cur.key + ' only' : '');
    $('#colbox').innerHTML = cur.columns.map(function (c) { return '<label><input type="checkbox" value="' + esc(c.name) + '" checked>' + esc(c.name) + '</label>'; }).join('');
    $('#fcol').innerHTML = cur.columns.map(function (c) { return '<option value="' + esc(c.name) + '">' + esc(c.name) + '</option>'; }).join('');
    try { history.replaceState(null, '', '/data.html?t=' + cur.name); } catch (e) { }
    load();
  }
  function selCols() { return Array.prototype.filter.call(document.querySelectorAll('#colbox input'), function (i) { return i.checked; }).map(function (i) { return i.value; }); }
  function url(fmt) {
    var p = new URLSearchParams({ t: cur.name, order: st.order, dir: st.dir, limit: fmt === 'csv' ? '5000' : $('#psize').value, offset: fmt === 'csv' ? '0' : String(st.offset), f: JSON.stringify(st.filters) });
    var c = selCols(); if (c.length && c.length < cur.columns.length) p.set('cols', c.join(','));
    if (fmt) p.set('format', fmt);
    return '/api/data/rows?' + p.toString();
  }
  function chips() {
    $('#fchips').innerHTML = st.filters.map(function (f, i) {
      if (cur.need && f.col === cur.need) return '';
      return '<span class="fchip">' + esc(f.col) + ' ' + ({ eq: '=', gt: '>', lt: '<', contains: 'contains', notnull: 'has a value' })[f.op] + ' ' + esc(f.op === 'notnull' ? '' : f.v) + '<button type="button" data-i="' + i + '" aria-label="Remove filter">×</button></span>';
    }).join('');
  }
  function load() {
    chips();
    $('#dt').innerHTML = '<div class="empty">Loading…</div>';
    G.getJSON(url()).then(function (r) {
      var cols = cur.columns.filter(function (c) { return r.cols.indexOf(c.name) >= 0; });
      if (!r.rows.length) { $('#dt').innerHTML = '<div class="empty">No rows match. ' + (st.filters.length ? 'Try removing a filter.' : 'This table fills as the loops run.') + '</div>'; $('#stats').innerHTML = ''; }
      else {
        $('#dt').innerHTML = '<table><thead><tr>' + cols.map(function (c) {
          return '<th class="' + (c.sortable ? 's' : '') + '" data-c="' + esc(c.name) + '">' + esc(c.name) + (r.order === c.name ? '<span class="ar">' + (r.dir === 'ASC' ? '↑' : '↓') + '</span>' : '') + (c.label ? '<small>' + esc(c.label) + '</small>' : '') + '</th>';
        }).join('') + '</tr></thead><tbody>' + r.rows.map(function (row) { return '<tr>' + cols.map(function (c) { return fmtCell(c, row[c.name]); }).join('') + '</tr>'; }).join('') + '</tbody></table>';
        stats(cols, r.rows);
      }
      $('#prev').disabled = st.offset === 0; $('#next').disabled = !r.more;
      $('#pinfo').textContent = r.rows.length ? 'Rows ' + (st.offset + 1).toLocaleString('en-US') + '–' + (st.offset + r.rows.length).toLocaleString('en-US') : '';
    }).catch(function (e) { $('#dt').innerHTML = '<div class="empty">Could not load: ' + esc(e.message) + '</div>'; });
  }
  function spark(vals) {
    if (vals.length < 2) return '';
    var w = 176, h = 28, lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), rg = (hi - lo) || 1;
    var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + (i * (w - 2) / (vals.length - 1) + 1).toFixed(1) + ',' + (h - 2 - (v - lo) / rg * (h - 4)).toFixed(1); }).join('');
    return '<svg width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  }
  function stats(cols, rows) {
    var ordered = st.dir === 'DESC' ? rows.slice().reverse() : rows;
    $('#stats').innerHTML = cols.filter(function (c) { return isNum(c) && !/^(ts|made|target|actual_ts|published|filed|updated|src_ts|line|id)$/.test(c.name); }).map(function (c) {
      var v = ordered.map(function (r) { return r[c.name]; }).filter(function (x) { return x != null && isFinite(x); });
      var nulls = rows.length - v.length;
      if (!v.length) return '<div class="sc"><b>' + esc(c.name) + '</b><div class="lb">' + esc(c.label || '') + '</div>No values on this page</div>';
      var mean = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
      var f = function (x) { var a = Math.abs(x); return Number(x).toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 1 : a >= 1 ? 2 : 4 }); };
      return '<div class="sc"><b>' + esc(c.name) + '</b><div class="lb">' + esc(c.label || ' ') + '</div>' + spark(v) +
        'min ' + f(Math.min.apply(null, v)) + ' · mean ' + f(mean) + ' · max ' + f(Math.max.apply(null, v)) + (nulls ? ' · ' + Math.round(nulls / rows.length * 100) + '% empty' : '') + '</div>';
    }).join('') || '<div class="empty">No numeric columns selected.</div>';
  }

  $('#tsel').addEventListener('change', function () { pick(this.value); });
  $('#sid').addEventListener('change', function () { st.filters = st.filters.filter(function (f) { return f.col !== 'id'; }); st.filters.unshift({ col: 'id', op: 'eq', v: this.value }); st.offset = 0; load(); });
  $('#psize').addEventListener('change', function () { st.offset = 0; load(); });
  $('#colbox').addEventListener('change', function () { load(); });
  $('#fadd').addEventListener('click', function () {
    var op = $('#fop').value, v = $('#fval').value.trim();
    if (op !== 'notnull' && !v) { $('#fval').focus(); return; }
    st.filters.push({ col: $('#fcol').value, op: op, v: v }); st.offset = 0; $('#fval').value = ''; load();
  });
  $('#fval').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#fadd').click(); });
  $('#fchips').addEventListener('click', function (e) { var b = e.target.closest('button[data-i]'); if (!b) return; st.filters.splice(+b.dataset.i, 1); st.offset = 0; load(); });
  $('#dt').addEventListener('click', function (e) {
    var th = e.target.closest('th.s'); if (!th) return;
    var c = th.dataset.c; if (st.order === c) st.dir = st.dir === 'ASC' ? 'DESC' : 'ASC'; else { st.order = c; st.dir = 'DESC'; }
    st.offset = 0; load();
  });
  $('#prev').addEventListener('click', function () { st.offset = Math.max(0, st.offset - +$('#psize').value); load(); });
  $('#next').addEventListener('click', function () { st.offset += +$('#psize').value; load(); });
  $('#csv').addEventListener('click', function () {
    var b = this; b.disabled = true; b.textContent = 'Exporting…';
    fetch(url('csv')).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then(function (blob) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = cur.name + (st.filters.length ? '-filtered' : '') + '.csv'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }).catch(function (e) { alert('Export failed: ' + e.message); }).then(function () { b.disabled = false; b.textContent = 'Export CSV'; });
  });

  G.getJSON('/api/data/tables').then(function (d) {
    T = d.tables || []; SIDS = d.seriesIds || [];
    $('#tsel').innerHTML = T.map(function (t) { return '<option value="' + esc(t.name) + '">' + esc(t.label) + '</option>'; }).join('');
    $('#sid').innerHTML = SIDS.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.label ? s.id + ' · ' + s.label : s.id) + '</option>'; }).join('');
    var want = qs.get('t'); if (want && tdef(want)) $('#tsel').value = want;
    pick($('#tsel').value);
  }).catch(function () { $('#dt').innerHTML = '<div class="empty">The data explorer is unavailable right now.</div>'; });
})();
