<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GIT/4 - OPERATOR LOGIN</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/terminal.css">
<style>
body{display:flex;align-items:center;justify-content:center;min-height:100dvh}
.lbox{width:380px;max-width:92vw}
.lhead{text-align:center;margin-bottom:14px}
.lhead .lx{width:16px;height:16px;background:var(--gold);display:inline-block;margin-bottom:10px}
.lhead h1{font:700 15px var(--disp);letter-spacing:.24em;color:#f0f5f8}
.lhead p{font:9.5px var(--mono);color:var(--dim);letter-spacing:.18em;margin-top:5px}
.lfield{margin-bottom:10px}
.lfield label{display:block;font:600 8.5px var(--mono);letter-spacing:.16em;color:var(--dim);margin-bottom:4px}
.lfield input{width:100%;background:var(--panel3);border:1px solid var(--line);color:var(--txt);font:13px var(--mono);padding:9px 10px;outline:none}
.lfield input:focus{border-color:var(--gold)}
.lbtn{width:100%;margin-top:6px}
.lnote{font:8.5px var(--mono);color:var(--dim);letter-spacing:.06em;line-height:1.7;margin-top:14px;text-align:center}
.lerr{font:10px var(--mono);color:var(--dn);margin-top:8px;text-align:center;min-height:14px}
</style>
</head>
<body>
<div class="lbox">
  <div class="lhead">
    <span class="lx"></span>
    <h1>GOLD INTELLIGENCE TERMINAL</h1>
    <p>OPERATOR ACCESS - GIT/4.2.26</p>
  </div>
  <div class="panel sig">
    <div class="p-hd"><span class="sq"></span><span class="ttl">Operator Sign-In</span></div>
    <div class="p-bd">
      <div class="lfield"><label>OPERATOR NAME</label><input id="lname" maxlength="24" autocomplete="off"></div>
      <div class="lfield"><label>ACCESS PIN (4-8 DIGITS)</label><input id="lpin" type="password" maxlength="8" inputmode="numeric"></div>
      <button class="runbtn lbtn" id="lgo">SIGN IN</button>
      <div class="lerr" id="lerr"></div>
      <div class="lnote">FIRST TIME? ENTER ANY NAME + PIN TO CREATE YOUR DESK PROFILE.<br>PROFILE + BASKET SAVED ON THIS DEVICE ONLY.<br>PRIVACY SCREEN - NOT BANK-GRADE SECURITY.</div>
    </div>
  </div>
</div>
<script>
(function(){
'use strict';
/* session helpers (shared key names with home.js) */
function sess(){ try { return JSON.parse(localStorage.getItem('git-session')||'null'); } catch(e){ return null; } }
function hash(s){ var h=5381; for(var i=0;i<s.length;i++){ h=((h<<5)+h+s.charCodeAt(i))>>>0; } return h.toString(36); }
function go(){ var s=sess(); if(s && Date.now()-s.ts < 30*864e5){ location.href='/'; } }
go();
var name=document.getElementById('lname'), pin=document.getElementById('lpin'), err=document.getElementById('lerr');
function submit(){
  var n=name.value.trim(), p=pin.value.trim();
  if(n.length<2){ err.textContent='ENTER OPERATOR NAME (2+ CHARS)'; return; }
  if(!/^\d{4,8}$/.test(p)){ err.textContent='PIN MUST BE 4-8 DIGITS'; return; }
  var existing=null;
  try{ existing=JSON.parse(localStorage.getItem('git-cred')||'null'); }catch(e){}
  if(existing && existing.name===n){
    if(existing.ph!==hash(n+p)){ err.textContent='PIN DOES NOT MATCH THIS OPERATOR'; return; }
  } else if(existing && existing.name!==n){
    if(!confirm('A DIFFERENT OPERATOR EXISTS ON THIS DEVICE. REPLACE WITH '+n.toUpperCase()+'? (WATCHLIST/PROFILE WILL RESET)')) return;
    localStorage.removeItem('git-profile'); localStorage.removeItem('git-watch');
  }
  localStorage.setItem('git-cred', JSON.stringify({name:n, ph:hash(n+p)}));
  localStorage.setItem('git-session', JSON.stringify({name:n, ts:Date.now()}));
  var pf={}; try{ pf=JSON.parse(localStorage.getItem('git-profile')||'{}'); }catch(e){}
  pf.name=n; localStorage.setItem('git-profile', JSON.stringify(pf));
  location.href='/';
}
document.getElementById('lgo').addEventListener('click', submit);
pin.addEventListener('keydown', function(e){ if(e.key==='Enter') submit(); });
name.addEventListener('keydown', function(e){ if(e.key==='Enter') pin.focus(); });
})();
</script>
</body>
</html>
