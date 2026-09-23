(function(){
'use strict';
var $=function(s){return document.querySelector(s)};
var fmt=function(n,d){if(n==null||isNaN(n))return'--';d=d==null?4:d;return Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d})};
var sgn=function(n){return n>0?'+':''};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
setInterval(function(){$('#clock').textContent=new Date().toLocaleTimeString('en-GB')},1000);
 $('#clock').textContent=new Date().toLocaleTimeString('en-GB');

var STABLES=[
  {id:'tether',sym:'USDT',name:'Tether'},
  {id:'usd-coin',sym:'USDC',name:'USD Coin'},
  {id:'dai',sym:'DAI',name:'Dai'},
  {id:'first-digital-usd',sym:'FDUSD',name:'First Digital USD'},
  {id:'true-usd',sym:'TUSD',name:'TrueUSD'},
  {id:'frax',sym:'FRAX',name:'Frax'}
];

function load(){
  var ids=STABLES.map(function(s){return s.id}).join(',');
  fetch('https://api.coingecko.com/api/v3/simple/price?ids='+ids+'&vs_currencies=usd&include_24hr_change=true&include_market_cap=true')
    .then(function(r){return r.json()})
    .then(function(data){
      var list='';
      STABLES.forEach(function(s){
        var d=data[s.id];
        if(!d)return;
        var chg=d.usd_24h_change||0;
        var peg=((d.usd-1)*100).toFixed(3);
        var pos=Math.max(0,Math.min(100,((d.usd-0.995)/0.01)*100));
        list+='<div class="srow"><span class="sym">'+s.sym+'</span><span class="name">'+s.name+'</span><span class="price">$'+fmt(d.usd,4)+'</span><span class="peg '+(Math.abs(peg)<0.1?'up':Math.abs(peg)<0.5?'mut':'dn')+'">'+sgn(peg)+peg+'%</span><div class="peg-bar"><i style="left:'+pos+'%"></i></div></div>';
        if(s.sym==='USDT'){
          $('#usdtPx').textContent='$'+fmt(d.usd,4);
          var c=$('#usdtChg');c.className='bigchg '+(chg>=0?'up':'dn');
          c.textContent=(chg>=0?'UP +':'DN ')+fmt(Math.abs(chg),2)+'% 24H';
          var pegPct=((d.usd-1)*100).toFixed(3);
          var healthy=Math.abs(pegPct)<0.05;
          var stressed=Math.abs(pegPct)>0.2;
          $('#pegHealth').innerHTML='PEG DEVIATION: <b class="'+(healthy?'up':stressed?'dn':'mut')+'">'+sgn(pegPct)+pegPct+'%</b><br>STATUS: <b class="'+(healthy?'up':stressed?'dn':'mut')+'">'+(healthy?'HEALTHY':stressed?'STRESSED':'NORMAL')+'</b><br><br>USDT SHOULD TRADE AT $1.0000<br>DEVIATION > 0.2% IS NOTABLE<br>DEVIATION > 1% IS SEVERE';
          var mc=d.usd_market_cap||0;
          $('#marketCap').textContent=mc>1e11?'$'+fmt(mc/1e9,0)+'B':mc>1e8?'$'+fmt(mc/1e6,0)+'M':'$'+fmt(mc,0);
        }
      });
      list+='<div class="footnote">COINGECKO - LIVE - NO API KEY REQUIRED<br>PEG = % DEVIATION FROM $1.00<br>GREEN BAR POSITION ON SCALE = $0.995 TO $1.005</div>';
      $('#stableList').innerHTML=list;
      var pm='';
      STABLES.forEach(function(s){
        var d=data[s.id];
        if(!d)return;
        var peg=((d.usd-1)*100).toFixed(3);
        var col=Math.abs(peg)<0.05?'up':Math.abs(peg)>0.2?'dn':'mut';
        pm+='<div class="lrow"><span class="name">'+s.sym+'</span><span class="val '+col+'">'+sgn(peg)+peg+'%</span><span class="dim" style="justify-self:end">'+(Math.abs(peg)<0.05?'TIGHT':Math.abs(peg)>0.2?'WIDE':'NORMAL')+'</span></div>';
      });
      $('#pegMap').innerHTML=pm+'<div class="footnote">PEG DEVIATION MAP - ALL MAJOR STABLECOINS<br>TIGHT = <0.05% / WIDE = >0.2%</div>';
    })
    .catch(function(e){
      console.error('CoinGecko error',e);
      $('#stableList').innerHTML='<div class="footnote">COINGECKO UNREACHABLE - RETRYING<br>FREE TIER: NO KEY, RATE LIMITED TO ~10/MIN</div>';
    });
}
load();
setInterval(function(){if(!document.hidden)load()},60000);

fetch('/api/bootstrap?tf=1D').then(function(r){return r.json()}).then(function(b){
  if(b.gold){
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd')
      .then(function(r){return r.json()})
      .then(function(d){
        var usdt=d.tether?d.tether.usd:1;
        var ratio=b.gold.price/usdt;
        $('#goldRatio').innerHTML='<div class="lrow"><span class="name">GOLD PRICE</span><span class="val">$'+fmt(b.gold.price,0)+'</span><span class="dim">/OZ</span></div>'+
          '<div class="lrow"><span class="name">USDT PRICE</span><span class="val">$'+fmt(usdt,4)+'</span><span class="dim">CRYPTO</span></div>'+
          '<div class="lrow"><span class="name">GOLD IN USDT</span><span class="val">'+fmt(ratio,0)+'</span><span class="dim">USDT/OZ</span></div>'+
          '<div class="footnote">GOLD PRICED IN TETHER<br>IF USDT DEPEGS, THIS RATIO SHIFTS<br>USEFUL FOR CRYPTO-GOLD ARBITRAGE MONITORING</div>';
      });
  }
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
