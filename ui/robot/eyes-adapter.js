/* Focused IP eye renderer. Geometry adapted from Agent Robot Avatar (MIT).
 * Only idle, bored, sleep, wake, affirm, waiting-spin, waiting-wave and failure.
 * Every action starts from the current displayed pose, never a reset frame.
 */
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  document.body.innerHTML = `<svg xmlns="${SVG}" viewBox="20 53 200 145" aria-hidden="true" style="width:100%;height:100%;display:block;overflow:visible"><defs></defs></svg>`;
  const svg = document.querySelector('svg');
  const make = (tag, attrs, parent) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k,v] of Object.entries(attrs)) el.setAttribute(k,String(v));
    parent.append(el); return el;
  };
  const eyes = ['left','right'].map(side => {
    const mask = make('mask',{id:side+'-lid',maskUnits:'userSpaceOnUse',x:-300,y:-300,width:600,height:600},svg.querySelector('defs'));
    mask.style.maskType='luminance';
    make('rect',{x:-300,y:-300,width:600,height:600,fill:'white'},mask);
    const top=make('rect',{x:-100,y:-236,width:200,height:200,fill:'black'},mask);
    const bottom=make('rect',{x:-100,y:36,width:200,height:200,fill:'black'},mask);
    const g=make('g',{},svg);
    const base=make('ellipse',{cx:0,cy:0,rx:18.9,ry:29,fill:'white',mask:`url(#${side}-lid)`},g);
    return {g,base,top,bottom};
  });
  const waveGroup = make('g',{opacity:0},svg);
  const bars = Array.from({length:5},(_,i)=>make('rect',{x:72+i*21,y:108,width:12,height:36,rx:6,fill:'white'},waveGroup));
  let soundMix=0;
  const baseline = () => [72,126,18.9,29,-36,36,0,0,168,126,18.9,29,-36,36,0,0];
  let current=baseline(),action='idle',start=performance.now(),last=start,frame=0,disposed=false,pending=null;
  let nextBlink=start+3500,blinkStart=-10000;
  const durations={idle:550,bored:4500,sleep:2100,wake:1200,affirm:1350,failure:1900};
  const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t)};
  const mix=(a,b,t)=>a+(b-a)*t;
  function target(now){
    const age=now-start,p=baseline();
    if(action==='waiting-spin'){
      // Isotropic radius: both eyes stay circular throughout the orbit.
      const angle=age/3200*Math.PI*4,depth=Math.sin(angle);
      p[0]=120-48*Math.cos(angle);p[8]=120+48*Math.cos(angle);
      p[1]=126+5*depth;p[9]=126-5*depth;
      p[2]=p[3]=25*(1+.07*depth);p[10]=p[11]=25*(1-.07*depth);
    }else if(action==='sleep'){
      const t=smooth(age/1700);for(const j of [0,8]){p[j+2]=mix(18.9,27,t);p[j+3]=mix(29,2.2,t);p[j+1]+=3*t;}
    }else if(action==='wake'){
      const lift=3*Math.sin(Math.PI*Math.min(1,age/850));p[1]-=lift;p[9]-=lift;
    }else if(action==='bored'){
      const phase=Math.min(1,age/4500),look=phase<.42?-12*Math.sin(phase/.42*Math.PI):phase<.84?12*Math.sin((phase-.42)/.42*Math.PI):0;
      p[0]+=look;p[8]+=look;p[4]=-16;p[12]=-16;
      const release=smooth((age-3900)/600);p[4]=p[12]=mix(-16,-36,release);
    }else if(action==='affirm'){
      const t=Math.max(0,Math.min(1,(age-250)/850)),nod=6*Math.sin(Math.PI*t)**2;
      p[1]+=nod;p[9]+=nod;
    }else if(action==='failure'){
      const intensity=smooth(age/400)*(1-smooth((age-1350)/550));
      p[4]=p[12]=mix(-36,-7,intensity);p[6]=-16*intensity;p[14]=16*intensity;
      p[1]+=5*intensity;p[9]+=5*intensity;
    }else{
      const dx=2*Math.sin(now/2400),dy=.65*Math.sin(now/1800);p[0]+=dx;p[8]+=dx;p[1]+=dy;p[9]+=dy;
    }
    if(action==='idle'||action==='bored'){
      if(now>=nextBlink){blinkStart=now;nextBlink=now+3500+Math.random()*2500;}
      const b=(now-blinkStart)/260;
      if(b>=0&&b<1){const close=Math.sin(Math.PI*b)**2;p[3]*=1-.96*close;p[11]*=1-.96*close;}
    }
    return p;
  }
  function draw(now){
    const dt=Math.min(50,Math.max(0,now-last));last=now;
    const desired=target(now),alpha=1-Math.exp(-dt/55);
    current=current.map((v,i)=>mix(v,desired[i],alpha));
    soundMix=mix(soundMix,action==='waiting-wave'?1:0,alpha);
    waveGroup.setAttribute('opacity',soundMix);
    bars.forEach((bar,i)=>{
      const middle=1-Math.abs(i-2)/2;
      const pulse=(Math.sin((now-start)/155+i*.85)+Math.sin((now-start)/245-i*.65)+2)/4;
      const height=16+middle*17+pulse*(17+middle*13);
      bar.setAttribute('height',height);bar.setAttribute('y',126-height/2);
    });
    eyes.forEach((eye,i)=>{
      const j=i*8,[x,y,rx,ry,top,bottom,ta,ba]=current.slice(j,j+8);
      eye.g.setAttribute('opacity',1-soundMix);
      eye.g.setAttribute('transform',`translate(${x} ${y})`);
      eye.base.setAttribute('rx',rx);eye.base.setAttribute('ry',ry);
      eye.top.setAttribute('y',top-200);eye.top.setAttribute('transform',`rotate(${ta} 0 ${top})`);
      eye.bottom.setAttribute('y',bottom);eye.bottom.setAttribute('transform',`rotate(${ba} 0 ${bottom})`);
    });
    svg.dataset.action=action;
    if(pending&&now-start>=durations[action]){const resolve=pending;pending=null;resolve();}
    if(!disposed)frame=requestAnimationFrame(draw);
  }
  window.applyEmotion=name=>{
    if(disposed)return Promise.resolve();
    const aliases={thinking:'waiting-spin',received:'affirm'};name=aliases[name]||name;
    if(!(name in durations)&&name!=='waiting-spin'&&name!=='waiting-wave')return Promise.resolve();
    // Resolve the interrupted promise; callers validate their own request token.
    pending?.();pending=null;action=name;start=performance.now();
    if(name==='waiting-spin'||name==='waiting-wave')return Promise.resolve();
    return new Promise(resolve=>{pending=resolve});
  };
  window.dispose=()=>{disposed=true;cancelAnimationFrame(frame);pending?.();pending=null;};
  window.ready=true;
  draw(performance.now());
})();
