/* nav additions on every page: VOL desk for everyone, ADMIN for admins.
   role comes from /api/auth/me once per tab session (cached in localStorage);
   the server enforces admin on every /api/admin/* call — this is only navigation. */
(function () {
  'use strict';
  function chip(href, txt, gold) {
    var nav = document.querySelector('.gochips');
    if (!nav || nav.querySelector('a[href="' + href + '"]')) return;
    if (location.pathname.replace(/\.html$/, '') === href.replace(/\.html$/, '')) return;
    var a = document.createElement('a');
    a.href = href; a.className = 'gchip'; a.style.textDecoration = 'none'; if (gold) a.style.color = 'var(--gold)'; a.textContent = txt;
    nav.appendChild(a);
  }
  chip('/vol.html', 'VOL', false);
  var role = null, tok = null, checked = null;
  try { role = localStorage.getItem('git-role'); tok = localStorage.getItem('git-token'); checked = sessionStorage.getItem('git-role-checked'); } catch (e) { }
  if (role === 'admin') chip('/admin.html', 'ADMIN', true);
  if (!tok || checked) return;
  fetch('/api/auth/me', { headers: { 'x-session': tok } }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d || !d.valid) return;
    try { localStorage.setItem('git-role', d.role || 'operator'); sessionStorage.setItem('git-role-checked', '1'); } catch (e) { }
    if (d.role === 'admin') chip('/admin.html', 'ADMIN', true);
  }).catch(function () { });
})();
