(function(){
'use strict';
var $=function(s){return document.querySelector(s)};
var fmt=function(n,d){if(n==null||isNaN(n))return'--';d=d==null?2:d;return Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d})};
var sgn=function(n){return n>0?'+':''};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
setInterval(function(){$('#clock').textContent=new Date().toLocaleTimeString('en-GB')},1000);
 $('#clock').textContent=new Date().toLocaleTimeString('en-GB');

var D=null;
fetch('/api/page/agri').then(function(r){return r.json()}).then(function(d){D=d;render();}).catch(function(e){console.error(e)});

function render(){
  if(!D)return;
  if(D.water){
    if(D.water.nqH2o){
      $('#nqh2oPx').textContent=fmt(D.water.nqH2o.value,0)+' $/AF';
      var chg=D.water.nqH2o.value-D.water.nqH2o.prior;
      var c=$('#nqh2oChg');c.className='bigchg '+(chg>=0?'up':'dn');
      c.textContent=(chg>=0?'UP ':'DN ')+sgn(chg)+fmt(Math.abs(chg),0)+' $/AF';
      $('#waterSummary').innerHTML='CALIFORNIA WATER INDEX: '+fmt(D.water.nqH2o.value,0)+' $/ACRE-FOOT<br>PRIOR: '+fmt(D.water.nqH2o.prior,0)+' $/AF<br>AS OF: '+esc(D.water.nqH2o.asOf)+'<br><br>SOURCE: FRED / NASDAQ VELES';
    } else {
      $('#waterSummary').textContent='NQH2O DATA PENDING - VERIFY SERIES ID AT fred.stlouisfed.org';
    }
    var gh='';
    (D.water.levels||[]).forEach(function(l){
      gh+='<div class="wrow"><span class="name">'+esc(l.name)+'</span><span class="val">'+fmt(l.gageFt,2)+' ft</span><div class="gauge-bar"><i style="width:'+Math.min(100,l.gageFt*10)+'%"></i></div></div>';
    });
    gh+='<div class="footnote">USGS NWIS INSTANTANEOUS VALUES - RIVER STAGE IN FEET<br>GAUGE HEIGHT IS AN INDICATOR, NOT LAKE CAPACITY</div>';
    $('#gaugeList').innerHTML=gh;
  }
  var ph='';
  ph+='<div class="lrow"><span class="name">CO RIVER WATER RIGHTS</span><span class="val">REF</span><span class="dim">SENIOR/JUNIOR PRIORITY SYSTEM</span></div>';
  ph+='<div class="lrow"><span class="name">CA SWP ALLOCATION</span><span class="val">REF</span><span class="dim">STATE WATER PROJECT</span></div>';
  ph+='<div class="lrow"><span class="name">CENTRAL AZ PROJECT</span><span class="val">REF</span><span class="dim">CAP ALLOCATION</span></div>';
  ph+='<div class="footnote">WATER RIGHTS ARE LOCATION AND PRIORITY SPECIFIC<br>NO LIVE TRADING MARKET EXISTS FOR MOST RIGHTS<br>NQH2O IS THE ONLY TRADEABLE INDEX</div>';
  $('#pricingList').innerHTML=ph;
  var dh='Drought conditions update weekly (USDM).<br><br>For real-time drought data, see:<br>droughtmonitor.unl.edu<br><br>This panel will show automated drought data in a future update.';
  $('#droughtBody').innerHTML=dh;
  if(D.news){
    $('#nwList').innerHTML=D.news.filter(function(n){return n.topic==='macro'||n.title.toLowerCase().includes('water')||n.title.toLowerCase().includes('drought')}).slice(0,8).map(function(n){
      return '<li><time>'+new Date(n.publishedTs).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+'</time><span class="tag">'+esc(n.source)+'</span><p>'+esc(n.title)+'</p><span class="sent '+(n.sentiment==='bull'?'b':n.sentiment==='bear'?'s':'n')+'">'+(n.sentiment==='bull'?'BULL':n.sentiment==='bear'?'BEAR':'NEUT')+'</span></li>';
    }).join('')||'<li><span class="dim">NO WATER NEWS TODAY</span></li>';
  }
}

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
