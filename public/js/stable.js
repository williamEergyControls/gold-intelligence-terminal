(function(){
'use strict';
var $=function(s){return document.querySelector(s)};
var fmt=function(n,d){if(n==null||isNaN(n))return'–';d=d==null?4:d;return Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d})};
var sgn=function(n){return n>0?'+':''};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};

/* server-side now: /api/markets/stablecoins reads the D1 warehouse (CoinGecko ingested hourly,
   no browser → CoinGecko calls, no per-viewer rate limits). chart: /api/series deviation in bp. */
var PEGCLS=function(bp){var a=Math.abs(bp||0);return a<10?'up':a<50?'mut':'dn'};
var PEGTXT=function(bp){var a=Math.abs(bp||0);return a<10?'TIGHT':a<50?'NORMAL':a<100?'WIDE':'SEVERE'};
var LAST=null;
function money(mc){return mc==null?'--':mc>1e11?'$'+fmt(mc/1e9,0)+'B':mc>1e8?'$'+fmt(mc/1e6,0)+'M':'$'+fmt(mc,0)}
function load(){
  fetch('/api/markets/stablecoins').then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})}).then(function(res){
    if(!res.ok){$('#stableList').innerHTML='<div class="footnote">DATA TEMPORARILY UNAVAILABLE - '+esc(res.d.detail||res.d.error||'')+'<br>SOURCE: COINGECKO VIA D1 WAREHOUSE - RETRYING</div>';return;}
    var d=res.d;LAST=d;
    var list='',pm='';
    d.coins.forEach(function(c){
      var bp=c.devBp,pos=Math.max(0,Math.min(100,((c.price||1)-0.995)/0.01*100));
      list+='<div class="srow"><span class="sym">'+esc(c.id)+'</span><span class="name">'+esc(c.label)+'</span><span class="price">$'+fmt(c.price,4)+'</span><span class="peg '+PEGCLS(bp)+'">'+sgn(bp)+fmt(bp,1)+'bp</span><div class="peg-bar"><i style="left:'+pos+'%"></i></div></div>';
      pm+='<div class="lrow"><span class="name">'+esc(c.id)+'</span><span class="val '+PEGCLS(bp)+'">'+sgn(bp)+fmt(bp,1)+' bp</span><span class="dim" style="justify-self:end">'+PEGTXT(bp)+' · 90D MAX '+fmt(c.max90Bp,0)+'</span></div>';
      if(c.id==='USDT'){
        $('#usdtPx').textContent='$'+fmt(c.price,4);
        var ch=$('#usdtChg');ch.className='bigchg '+(Math.abs(bp||0)<10?'up':'dn');
        ch.textContent=(c.chg1dBp>=0?'+':'−')+fmt(Math.abs(c.chg1dBp||0),1)+' bp today · '+day(c.lastTs);
        $('#pegHealth').innerHTML='PEG DEVIATION: <b class="'+PEGCLS(bp)+'">'+sgn(bp)+fmt(bp,1)+' bp</b><br>STATUS: <b class="'+PEGCLS(bp)+'">'+PEGTXT(bp)+'</b> · REGIME '+esc(c.regime)+'<br>30D MAX |DEV|: '+fmt(c.max30Bp,1)+' bp · 90D MAX: '+fmt(c.max90Bp,1)+' bp<br>PEG VOL: '+fmt(c.volBpDay,2)+' bp/day · DAYS &gt;10bp (90D): '+(c.daysOver10bp90==null?'--':c.daysOver10bp90)+'<br><br>1 BP = $0.0001 · &gt;50 BP IS NOTABLE · &gt;100 BP IS SEVERE';
        $('#marketCap').textContent=money(c.mcap)+(c.mcapChg30d!=null?' ('+sgn(c.mcapChg30d)+fmt(c.mcapChg30d,1)+'% 30D)':'');
      }
    });
    list+='<div class="footnote">'+esc(d.source)+'<br>'+esc(d.frequency)+' · RETRIEVED '+esc(String(d.retrievedAt).slice(0,16).replace('T',' '))+' UTC<br>TOTAL TRACKED MCAP '+money(d.totalMcap)+'<br>PEG BAR SCALE = $0.995 TO $1.005</div>';
    $('#stableList').innerHTML=list;
    $('#pegMap').innerHTML=pm+'<div class="footnote">PEG DEVIATION MAP · BP FROM $1.00<br>TIGHT &lt;10 · NORMAL &lt;50 · WIDE &lt;100 · SEVERE ≥100</div>';
    renderRatio();
  }).catch(function(e){console.error(e);$('#stableList').innerHTML='<div class="footnote">DATA TEMPORARILY UNAVAILABLE - RETRYING</div>';});
}
function day(ts){return ts?new Date(ts).toISOString().slice(0,10):'--'}
function drawChart(){
  if(!window.GK)return;
  var wrap=document.querySelector('#s-charts .ch-wrap');
  if(wrap&&!document.getElementById('chTip')){var t=document.createElement('div');t.id='chTip';t.className='tip';t.style.cssText='position:absolute;pointer-events:none;background:var(--panel2);border:1px solid var(--line);padding:5px 7px;font:400 12.5px/1.5 var(--sans);white-space:nowrap;z-index:5;display:none';wrap.appendChild(t);}
  Promise.all(['USDT','USDC'].map(function(id){return fetch('/api/series?id='+id+'&days=90').then(function(r){return r.ok?r.json():null}).catch(function(){return null})})).then(function(ds){
    var cols=[GK.css('--gold'),GK.css('--cyan')],series=[];
    ds.forEach(function(d,i){if(d&&d.devBp)series.push({name:d.id+' DEV (BP)',pts:d.devBp.map(function(p){return{x:p.t,y:p.v}}),color:cols[i],width:i?1.5:2});});
    GK.line(document.getElementById('chCv'),document.getElementById('chTip'),{series:series,refs:[{y:0,label:'$1.00',left:true}],yFmt:function(v){return fmt(v,1)+' bp'},empty:'WAREHOUSE WARMING - CHART FILLS AFTER FIRST COINGECKO INGEST'});
    var rd=document.getElementById('chRead');if(rd)rd.textContent=series.length?'GOLD = USDT · CYAN = USDC · DAILY CLOSE + LATEST PRINT · COINGECKO VIA D1':'NO DATA YET';
  });
}
drawChart();
load();
setInterval(function(){if(!document.hidden){load();}},120000);
setInterval(function(){if(!document.hidden){drawChart();}},600000);

var BOOT=null;
function renderRatio(){
  if(!BOOT||!BOOT.gold||!LAST)return;
  var u=(LAST.coins||[]).filter(function(c){return c.id==='USDT'})[0];
  var usdt=u&&u.price?u.price:null;if(!usdt)return;
  var ratio=BOOT.gold.price/usdt;
  $('#goldRatio').innerHTML='<div class="lrow"><span class="name">GOLD PRICE</span><span class="val">$'+fmt(BOOT.gold.price,0)+'</span><span class="dim">/OZ · '+esc(String(BOOT.gold.source).toUpperCase())+'</span></div>'+
    '<div class="lrow"><span class="name">USDT PRICE</span><span class="val">$'+fmt(usdt,4)+'</span><span class="dim">COINGECKO</span></div>'+
    '<div class="lrow"><span class="name">GOLD IN USDT</span><span class="val">'+fmt(ratio,0)+'</span><span class="dim">USDT/OZ</span></div>'+
    '<div class="footnote">GOLD PRICED IN TETHER (CALC)<br>IF USDT DEPEGS, THIS RATIO SHIFTS</div>';
}
fetch('/api/bootstrap?tf=1D').then(function(r){return r.json()}).then(function(b){
  if(b.gold){BOOT=b;renderRatio();}
  if(b.news){
    $('#nwList').innerHTML=(b.news.macro||[]).filter(function(n){return n.title.toLowerCase().includes('stablecoin')||n.title.toLowerCase().includes('tether')||n.title.toLowerCase().includes('crypto')||n.title.toLowerCase().includes('usdt')}).slice(0,8).map(function(n){
      return '<li><time>'+new Date(n.publishedTs).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+'</time><span class="tag">'+esc(n.source)+'</span><p>'+esc(n.title)+'</p></li>';
    }).join('')||'<li><span class="dim">NO STABLECOIN NEWS TODAY</span></li>';
  }
}).catch(function(e){console.error(e)});

/* theme */
(function(){
  var mode=localStorage.getItem('git-theme')||'auto';
  var isDay=function(){return mode==='day'||(mode==='auto'&&matchMedia('(prefers-color-scheme: light)').matches)};
  var apply=function(){document.body.classList.toggle('day',isDay());var b=document.getElementById('themeBtn');if(b)b.textContent=mode==='auto'?'AUTO':mode.toUpperCase();};
  var b=document.getElementById('themeBtn');
  if(b)b.addEventListener('click',function(){mode=mode==='auto'?'day':(mode==='day'?'night':'auto');localStorage.setItem('git-theme',mode);apply();});
  apply();
})();
})();
