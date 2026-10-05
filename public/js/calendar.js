/* ================================================================
   CALENDAR — month grid + agenda from /api/calendar
   Cal.mount(el, { scope: 'gold'|'energy'|'agri'|'water'|'land'|'fx'|'all' })
   times arrive as UTC ms and are shown in the viewer's own time zone.
   confirmed dates (FRED, Fed, ECB, USDA) vs weekly rules (marked "est.")
   ================================================================ */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var IMP = { h: 'High', m: 'Medium', l: 'Low' };
  var SCOPES = {
    gold: function (e) { return has(e, 'gold') || has(e, 'macro') || has(e, 'fx'); },
    fx: function (e) { return has(e, 'fx') || (has(e, 'macro') && e.imp !== 'l'); },
    energy: function (e) { return has(e, 'energy') || (has(e, 'macro') && e.imp === 'h'); },
    agri: function (e) { return has(e, 'agri') || has(e, 'water') || (has(e, 'macro') && e.imp === 'h'); },
    water: function (e) { return has(e, 'water') || has(e, 'agri') && e.imp !== 'l'; },
    land: function (e) { return has(e, 'land') || has(e, 'agri') && e.imp === 'h' || e.kind === 'fomc'; },
    all: function () { return true; }
  };
  function has(e, s) { return e.scope && e.scope.indexOf(s) >= 0; }
  function key(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function tm(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function dayLabel(ts) { return new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); }
  function until(ts) {
    var s = Math.max(0, (ts - Date.now()) / 1000);
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? d + ' d ' + h + ' h' : h ? h + ' h ' + m + ' min' : m + ' min';
  }

  function mount(el, o) {
    if (!el) return;
    o = o || {};
    var pass = SCOPES[o.scope] || SCOPES.all;
    var EV = [], byDay = {}, notes = [];
    var view = new Date(); view.setDate(1);
    var sel = null, onlyHigh = false;
    el.innerHTML = '<div class="empty">Loading calendar…</div>';

    function bucket() {
      byDay = {};
      EV.forEach(function (e) { var k = key(new Date(e.ts)); (byDay[k] = byDay[k] || []).push(e); });
    }
    function grid() {
      var y = view.getFullYear(), m = view.getMonth();
      var first = new Date(y, m, 1), start = new Date(y, m, 1 - ((first.getDay() + 6) % 7)); // weeks start Monday
      var today = key(new Date());
      var h = '<div class="calm-h"><b>' + first.toLocaleDateString([], { month: 'long', year: 'numeric' }) + '</b>' +
        '<button class="iconbtn" data-nav="-1" aria-label="Previous month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg></button>' +
        '<button class="iconbtn" data-nav="1" aria-label="Next month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></button></div>';
      h += '<div class="calm">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) { return '<span class="dw">' + d + '</span>'; }).join('');
      for (var i = 0; i < 42; i++) {
        var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        if (i >= 35 && d.getMonth() !== m) break;
        var k = key(d), evs = (byDay[k] || []).filter(function (e) { return !onlyHigh || e.imp === 'h'; });
        var dots = evs.slice().sort(function (a, b) { return 'hml'.indexOf(a.imp) - 'hml'.indexOf(b.imp); }).slice(0, 3).map(function (e) { return '<i class="' + e.imp + '"></i>'; }).join('');
        var cls = 'd' + (d.getMonth() !== m ? ' o' : '') + (k === today ? ' t' : '') + (k === sel ? ' sel' : '');
        h += '<button type="button" class="' + cls + '" data-k="' + k + '" aria-label="' + d.toDateString() + (evs.length ? ', ' + evs.length + ' events' : '') + '">' + d.getDate() + '<span class="dots">' + dots + '</span></button>';
      }
      return h + '</div>';
    }
    function agenda() {
      var now = Date.now(), list, label;
      if (sel) {
        list = (byDay[sel] || []).slice(); label = new Date(sel + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
      } else {
        list = EV.filter(function (e) { return e.ts >= now - 3600000 && (!onlyHigh || e.imp === 'h'); }).slice(0, o.limit || 9); label = 'Coming up';
      }
      if (onlyHigh) list = list.filter(function (e) { return e.imp === 'h'; });
      var next = EV.filter(function (e) { return e.imp === 'h' && e.ts > now; })[0];
      var h = next ? '<div class="cd" title="' + esc(next.src) + '"><span>Next high-impact</span><b>' + esc(next.title) + '</b><span>in ' + until(next.ts) + ', ' + dayLabel(next.ts) + ' ' + tm(next.ts) + '</span></div>' : '';
      h += '<div class="row" style="justify-content:space-between;margin:2px 0 4px"><h5 style="margin:0">' + esc(label) + '</h5>' +
        '<div class="tgrp"><button type="button" data-f="all" class="' + (onlyHigh ? '' : 'on') + '">All</button><button type="button" data-f="h" class="' + (onlyHigh ? 'on' : '') + '">High impact</button></div></div>';
      if (!list.length) h += '<div class="empty">' + (sel ? 'No scheduled releases on this day.' : 'Nothing scheduled.') + '</div>';
      list.forEach(function (e) {
        h += '<div class="cal-ev" title="' + esc(e.src) + (e.est ? ' — estimated from the weekly schedule' : '') + '">' +
          '<span class="w">' + tm(e.ts) + (sel ? '' : '<small>' + new Date(e.ts).toLocaleDateString([], { weekday: 'short', day: 'numeric' }) + '</small>') + '</span>' +
          '<span class="e">' + esc(e.title) + '<small>' + esc(e.detail) + (e.last ? ' · ' + esc(e.last) : '') + (e.est ? ' · est.' : '') + '</small></span>' +
          '<span class="imp ' + e.imp + '">' + IMP[e.imp] + '</span></div>';
      });
      if (notes.length) h += '<p class="footnote">' + esc(notes.join(' ')) + '</p>';
      return h;
    }
    function paint() {
      if (o.compact) { el.innerHTML = '<div class="cal-ag">' + agenda() + '</div>'; return; }
      el.innerHTML = '<div class="calx"><div class="cal-g">' + grid() + '</div><div class="cal-ag">' + agenda() + '</div></div>';
    }
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || !el.contains(b)) return;
      if (b.dataset.nav) { view = new Date(view.getFullYear(), view.getMonth() + Number(b.dataset.nav), 1); paint(); return; }
      if (b.dataset.k) { sel = sel === b.dataset.k ? null : b.dataset.k; paint(); return; }
      if (b.dataset.f) { onlyHigh = b.dataset.f === 'h'; paint(); }
    });
    fetch('/api/calendar').then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); }).then(function (d) {
      EV = (d.events || []).filter(pass); notes = d.notes || [];
      bucket(); paint();
      setInterval(function () { if (!document.hidden) { var a = el.querySelector('.cal-ag'); if (a) a.innerHTML = agenda(); } }, 60000);
    }).catch(function () { el.innerHTML = '<div class="empty">Calendar is unavailable right now.</div>'; });
  }
  window.Cal = { mount: mount };
})();
