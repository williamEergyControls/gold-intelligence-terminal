(function(){
'use strict';
var $=function(s){return document.querySelector(s)};
var fmt=function(n,d){if(n==null||isNaN(n))return'--';d=d==null?0:d;return Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d})};
var sgn=function(n){return n>0?'+':''};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
setInterval(function(){$('#clock').textContent=new Date().toLocaleTimeString('en-GB')},1000);
 $('#clock').textContent=new Date().toLocaleTimeString('en-GB');

/* reference data - USDA NASS publishes annually */
var REGIONS=[
  {name:'CORN BELT',value:9100,chg:5.2},
  {name:'PLAINS',value:2480,chg:7.1},
  {name:'LAKE STATES',value:6350,chg:4.8},
  {name:'NORTHEAST',value:5800,chg:3.9},
  {name:'SOUTHEAST',value:4450,chg:5.5},
  {name:'DELTA',value:3800,chg:6.2},
  {name:'MOUNTAIN',value:1650,chg:8.0},
  {name:'PACIFIC',value:7200,chg:3.5}
];

var avg=REGIONS.reduce(function(s,r){return s+r.value},0)/REGIONS.length;
var avgChg=REGIONS.reduce(function(s,r){return s+r.chg},0)/REGIONS.length;

 $('#landPx').textContent='$'+fmt(avg,0)+'/ACRE';
var c=$('#landChg');c.className='bigchg '+(avgChg>=0?'up':'dn');
c.textContent='UP +'+fmt(avgChg,1)+'% YoY (ESTIMATE)';

 $('#landSummary').innerHTML='US AVERAGE FARM REAL ESTATE VALUE<br>ESTIMATED: $'+fmt(avg,0)+'/ACRE<br>YoY CHANGE: +'+fmt(avgChg,1)+'%<br><br>SOURCE: USDA NASS - LAND VALUES SUMMARY<br>PUBLISHED ANNUALLY (AUGUST) - 2025 LATEST<br><br>NOTE: THESE ARE REFERENCE ESTIMATES<br>ACTUAL PRICES VARY BY COUNTY AND PARCEL';

var fh='';
REGIONS.forEach(function(r){
  fh+='<div class="lrow"><span class="name">'+r.name+'</span><span class="val">$'+fmt(r.value,0)+'</span><span class="'+(r.chg>=0?'up':'dn')+'" style="justify-self:end;font-size:10px">'+sgn(r.chg)+fmt(r.chg,1)+'%</span></div>';
});
fh+='<div class="footnote">USDA NASS FARM REAL ESTATE VALUES - $/ACRE - ANNUAL<br>LAST PUBLISHED: AUGUST 2025</div>';
 $('#farmBody').innerHTML=fh;

var RENTS=[
  {name:'CORN BELT',cash:255,crop:295},
  {name:'PLAINS',cash:65,crop:78},
  {name:'LAKE STATES',cash:165,crop:195},
  {name:'NORTHEAST',cash:85,crop:102},
  {name:'SOUTHEAST',cash:95,crop:112},
  {name:'DELTA',cash:115,crop:135},
  {name:'MOUNTAIN',cash:38,crop:45},
  {name:'PACIFIC',cash:145,crop:175}
];
var rh='';
RENTS.forEach(function(r){
  rh+='<div class="lrow"><span class="name">'+r.name+'</span><span class="val">$'+r.cash+'</span><span class="dim" style="justify-self:end">$'+r.crop+' crop</span></div>';
});
rh+='<div class="footnote">CASH RENT = $/ACRE CASH - CROP SHARE = $/ACRE EQUIVALENT<br>USDA NASS - CASH RENTS SURVEY - ANNUAL</div>';
 $('#rentBody').innerHTML=rh;

fetch('/api/bootstrap?tf=1D').then(function(r){return r.json()}).then(function(b){
  if(b.gold){
    var ratio=b.gold.price/avg;
    $('#ratioBody').innerHTML='<div class="lrow"><span class="name">GOLD PRICE</span><span class="val">$'+fmt(b.gold.price,0)+'</span><span class="dim">/OZ</span></div>'+
      '<div class="lrow"><span class="name">AVG FARMLAND</span><span class="val">$'+fmt(avg,0)+'</span><span class="dim">/ACRE</span></div>'+
      '<div class="lrow"><span class="name">GOLD / ACRE</span><span class="val">'+fmt(ratio,1)+'</span><span class="dim">OZ PER ACRE</span></div>'+
      '<div class="footnote">HOW MANY OUNCES OF GOLD BUY ONE ACRE OF US FARMLAND<br>HISTORICAL RANGE: 5-25 OZ/ACRE OVER 50 YEARS</div>';
  }
  if(b.news){
    $('#nwList').innerHTML=(b.news.macro||[]).filter(function(n){return n.title.toLowerCase().includes('land')||n.title.toLowerCase().includes('farm')||n.title.toLowerCase().includes('agricultur')}).slice(0,8).map(function(n){
      return '<li><time>'+new Date(n.publishedTs).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+'</time><span class="tag">'+esc(n.source)+'</span><p>'+esc(n.title)+'</p></li>';
    }).join('')||'<li><span class="dim">NO LAND NEWS TODAY</span></li>';
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
