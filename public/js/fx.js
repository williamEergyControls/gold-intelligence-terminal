(function(){
'use strict';
const $=s=>document.querySelector(s);
const fmt=(n,d=2)=>(n==null||isNaN(n))?'--':Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const sgn=n=>(n>0?'+':'');
const cls=v=>(v??0)>=0?'up':'dn';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl=u=>{try{const x=new URL(String(u));return(x.protocol==='http:'||x.protocol==='https:')?x.href:'#';}catch{return'#';}};
async function getJSON(u,h){const r=await fetch(u,h?{headers:h}:undefined);if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
const TOKEN=localStorage.getItem('git-token')||'';
if(!TOKEN){location.replace('/login.html');return;}
const AH={'x-session':TOKEN};

let B=null,CH=[];
setInterval(()=>{$('#clock').textContent=new Date().toLocaleTimeString('en-GB');},1000);
 $('#clock').textContent=new Date().toLocaleTimeString('en-GB');

function renderHero(){
  const g=B.dxy;
  $('#dxyPx').textContent=fmt(g.price);
  const p=g.changePct??0;
  const bc=$('#dxyChg');bc.className='bigchg '+cls(p);
  bc.innerHTML=(p>=0?'UP +':'DN ')+fmt(Math.abs(g.change))+'  ('+sgn(p)+fmt(p)+'%)';
  $('#dxySrc').textContent=String(g.source).toUpperCase();
  const c=$('#dxyChip');c.textContent=g.delay==='simulated'?'SIM':'NEAR LIVE';c.className='chip '+(g.delay==='simulated'?'ai':'near');
  const up=B.fx.filter(q=>(q.changePct??0)>0).length;
  const dn=B.fx.filter(q=>(q.changePct??0)<0).length;
  $('#dxySummary').innerHTML='DXY '+fmt(g.price)+' '+(p>=0?'UP':'DOWN')+'<br>'+B.fx.length+' MAJORS: '+up+' USD-WEAK / '+dn+' USD-STRONG<br><br>'+
    (B.fx||[]).map(q=>(q.symbol.includes('/')&&q.symbol.startsWith('USD')?'':'')+q.symbol+' '+sgn(q.changePct)+fmt(q.changePct,2)+'%').join('<br>');
}
function renderFX(){
  $('#fxTable').innerHTML=(B.fx||[]).map(q=>{
    const ch=q.changePct??0;
    const pos=q.wkHigh&&q.wkLow?Math.round((q.price-q.wkLow)/((q.wkHigh-q.wkLow)||1)*100):50;
    return '<div class="fxrow"><span class="sym">'+esc(q.symbol)+'</span><span class="rngbar"><i style="left:'+pos+'%"></i></span><span class="price">'+fmt(q.price)+'</span><span class="chg '+cls(ch)+'">'+sgn(ch)+fmt(ch,2)+'%</span><span class="src">ECB</span></div>';
  }).join('');
  const up=B.fx.filter(q=>(q.changePct??0)>0).length;
  $('#strengthMap').innerHTML='<div class="bi"><span class="n">USD STRONG vs</span><span class="up">'+up+' pairs</span></div>'+
    '<div class="bi"><span class="n">USD WEAK vs</span><span class="dn">'+(B.fx.length-up)+' pairs</span></div>'+
    '<div class="bi neg"><span class="n">EUR/USD</span><span class="'+cls(B.fx.find(q=>q.symbol==='EUR/USD')?.changePct??0)+'">'+fmt(B.fx.find(q=>q.symbol==='EUR/USD')?.price)+'</span></div>'+
    '<div class="footnote">ECB REFERENCE RATES - DAILY - NOT LIVE FX<br>GOLD CORRELATION: DXY UP = GOLD HEADWIND (TYPICALLY)</div>';
}
function renderNews(){
  $('#nwList').innerHTML=((B.news&&B.news.macro)||[]).slice(0,8).map(n=>{
    const sc=n.sentiment==='bull'?'b':(n.sentiment==='bear'?'s':'n');
    const st=n.sentiment==='bull'?'BULL':(n.sentiment==='bear'?'BEAR':'NEUT');
    const link=(n.url&&n.url!=='#')?'<a href="'+esc(safeUrl(n.url))+'" target="_blank" rel="noopener">OPEN</a>':'SIM';
    return '<li><time>'+new Date(n.publishedTs).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+'</time><span class="tag">'+esc(n.source)+'</span><p>'+esc(n.title)+'</p><span class="sent '+sc+'">'+st+'</span><div class="sum">// '+esc(n.sentimentNote)+' - '+link+'</div></li>';
  }).join('');
}
function renderTape(){
  const h=(B.tape||[]).map(t=>{
    const ch=t.changePct??0,dg=t.price>500?1:(t.price>20?2:3);
    return '<span class="tg"><span class="k">'+esc(t.symbol)+'</span><span class="v">'+fmt(t.price,dg)+'</span><span class="c '+cls(ch)+'">'+(ch>=0?'UP ':'DN ')+sgn(ch)+fmt(Math.abs(ch),2)+'%</span></span>';
  }).join('');
  $('#tapeA').innerHTML=h;$('#tapeB').innerHTML=h;
}
function renderAll(){renderTape();renderHero();renderFX();renderNews();}

/* chart */
function fit(cv){const r=cv.getBoundingClientRect();const d=Math.min(window.devicePixelRatio||1,2);cv.width=Math.max(1,Math.round(r.width*d));cv.height=Math.max(1,Math.round(r.height*d));const ctx=cv.getContext('2d');ctx.setTransform(d,0,0,d,0,0);return[ctx,r.width,r.height];}
let hoverX=-1;
function drawChart(){
  const cv=$('#chCv');if(!cv||cv.getBoundingClientRect().width<10)return;
  const f=fit(cv),ctx=f[0],W=f[1],H=f[2];ctx.clearRect(0,0,W,H);
  const cs=getComputedStyle(document.body);
  const gold=cs.getPropertyValue('--gold').trim(),up=cs.getPropertyValue('--up').trim(),dn=cs.getPropertyValue('--dn').trim(),grid=cs.getPropertyValue('--grid').trim(),mut=cs.getPropertyValue('--mut').trim();
  const d=CH,n=d.length;if(!n)return;
  const padL=6,padR=58,padT=8,axB=16,volH=40;
  const plotH=H-padT-axB-volH;
  let lo=Infinity,hi=-Infinity;d.forEach(k=>{lo=Math.min(lo,k.l);hi=Math.max(hi,k.h);});
  const pad=(hi-lo)*.05;lo-=pad;hi+=pad;
  const py=v=>padT+(hi-v)/(hi-lo)*plotH,cw=(W-padL-padR)/n,bw=Math.max(1.5,cw*.62);
  const ma=a=>a.map((_,i)=>i<19?null:a.slice(i-19,i+1).reduce((s,v)=>s+v,0)/20);
  const m20=ma(d.map(k=>k.c));
  ctx.font='9px IBM Plex Mono';ctx.textBaseline='middle';ctx.textAlign='left';
  ctx.setLineDash([3,3]);ctx.strokeStyle=grid;ctx.fillStyle=mut;
  for(let g=0;g<=4;g++){const v=hi-(hi-lo)*g/4,y=py(v);ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();ctx.fillText(fmt(v,1),W-padR+5,y);}
  ctx.setLineDash([]);
  let vmax=1;d.forEach(k=>vmax=Math.max(vmax,k.v||0));
  d.forEach((k,i)=>{const h=(k.v||0)/vmax*(volH-8),x=padL+cw*i+(cw-bw)/2;ctx.fillStyle=k.c>=k.o?'rgba(19,217,126,.3)':'rgba(255,79,94,.3)';ctx.fillRect(x,H-axB-h,bw,h);});
  d.forEach((k,i)=>{const x=padL+cw*i+cw/2,u=k.c>=k.o;ctx.strokeStyle=ctx.fillStyle=u?up:dn;ctx.beginPath();ctx.moveTo(x,py(k.h));ctx.lineTo(x,py(k.l));ctx.stroke();ctx.fillRect(x-bw/2,py(Math.max(k.o,k.c)),bw,Math.max(1,py(Math.min(k.o,k.c))-py(Math.max(k.o,k.c))));});
  ctx.beginPath();let st=false;m20.forEach((v,i)=>{if(v==null)return;const x=padL+cw*i+cw/2;st?ctx.lineTo(x,py(v)):ctx.moveTo(x,py(v));st=true;});ctx.strokeStyle='#2fd6e8';ctx.lineWidth=1.1;ctx.stroke();ctx.lineWidth=1;
  const last=d[n-1].c,ly=py(last);
  ctx.setLineDash([5,4]);ctx.strokeStyle='rgba(255,179,0,.8)';ctx.beginPath();ctx.moveTo(padL,ly);ctx.lineTo(W-padR,ly);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle=gold;ctx.fillRect(W-padR+1,ly-8,padR-4,16);ctx.fillStyle='#000';ctx.fillText(fmt(last,1),W-padR+5,ly);
}
document.addEventListener('mousemove',e=>{const cv=$('#chCv');if(!cv)return;const r=cv.getBoundingClientRect();hoverX=(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom)?e.clientX-r.left:-1;drawChart();});

/* tf buttons */
document.querySelectorAll('[data-tf]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-tf]').forEach(x=>x.classList.remove('on'));b.classList.add('on');
  getJSON('/api/candles?sym=DXY&tf='+b.dataset.tf,AH).then(r=>{CH=r.candles||[];drawChart();}).catch(()=>{});
}));

/* init */
(async function(){
  try{
    B=await getJSON('/api/bootstrap?tf=1D',AH);
    renderAll();
  }catch(e){$('#status .mid').textContent='API ERROR - '+String(e&&e.message||e);}
  try{
    const r=await getJSON('/api/candles?sym=DXY&tf=1D',AH);
    CH=r.candles||[];drawChart();
  }catch(e){}
})();
setInterval(async()=>{
  if(document.hidden||!B)return;
  try{B=await getJSON('/api/bootstrap?tf=1D',AH);renderAll();}catch(e){}
},60000);

/* theme */
(function(){
  let mode=localStorage.getItem('git-theme')||'auto';
  const isDay=()=>mode==='day'||(mode==='auto'&&matchMedia('(prefers-color-scheme: light)').matches);
  const apply=()=>{
    document.body.classList.toggle('day',isDay());
    const b=document.getElementById('themeBtn');if(b)b.textContent=mode==='auto'?'AUTO':mode.toUpperCase();
  };
  const b=document.getElementById('themeBtn');
  if(b)b.addEventListener('click',()=>{mode=mode==='auto'?'day':(mode==='day'?'night':'auto');localStorage.setItem('git-theme',mode);apply();});
  try{matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{if(mode==='auto')apply();});}catch(e){}
  apply();
})();
})();
