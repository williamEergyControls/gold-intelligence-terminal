/* adds the ADMIN chip to the top nav for admins on every page.
   role comes from /api/auth/me once per tab session; cached in localStorage.
   the server enforces admin on every /api/admin/* call — this is only navigation. */
(function () {
  'use strict';
  function add() {
    var nav = document.querySelector('.gochips');
    if (!nav || nav.querySelector('a[href="/admin.html"]')) return;
    var a = document.createElement('a');
    a.href = '/admin.html'; a.className = 'gchip'; a.style.textDecoration = 'none'; a.style.color = 'var(--gold)'; a.textContent = 'ADMIN';
    nav.appendChild(a);
  }
  var role = null, tok = null, checked = null;
  try { role = localStorage.getItem('git-role'); tok = localStorage.getItem('git-token'); checked = sessionStorage.getItem('git-role-checked'); } catch (e) { }
  if (role === 'admin') add();
  if (!tok || checked) return;
  fetch('/api/auth/me', { headers: { 'x-session': tok } }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d || !d.valid) return;
    try { localStorage.setItem('git-role', d.role || 'operator'); sessionStorage.setItem('git-role-checked', '1'); } catch (e) { }
    if (d.role === 'admin') add();
  }).catch(function () { });
})();
