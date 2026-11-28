/* One geometry source for both themes and every page. Never infer identity or
   override user zoom. CSS vh/dvh fallback remains if VisualViewport is absent. */
(() => {
  const root=document.documentElement;
  function measure(v,layoutHeight,layoutWidth){
    if(!v || !Number.isFinite(v.scale) || Math.abs(v.scale-1)>.015 ||
       !Number.isFinite(v.height)||!Number.isFinite(v.width)||v.height<=0||v.width<=0)return null;
    const top=Math.max(0,Number(v.offsetTop)||0),left=Math.max(0,Number(v.offsetLeft)||0);
    const height=Math.max(1,Math.min(v.height,layoutHeight||v.height));
    const width=Math.max(1,Math.min(v.width,layoutWidth||v.width));
    return {height,width,top,left,bottom:Math.max(0,layoutHeight-top-height),right:Math.max(0,layoutWidth-left-width)};
  }
  const properties=['--rc-visible-height','--rc-visible-width','--rc-visible-top','--rc-visible-left','--rc-visible-bottom','--rc-visible-right','--cinema-visible-height','--chat-viewport'];
  let queued=0,previousHeight=null;
  const vv=window.visualViewport;
  const editable=node=>node?.matches?.('textarea,input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]),[contenteditable="true"]');
  function update(){
    queued=0;
    const geometry=measure(vv,window.innerHeight,window.innerWidth);
    if(!geometry){
      for(const prop of properties)root.style.removeProperty(prop);
      previousHeight=null;delete root.dataset.viewportShort;
      return;
    }
    const composer=document.activeElement?.closest?.('.direct-compose,.chatinput');
    const stream=composer?.closest('.direct-room,#cinemaChat')?.querySelector('.direct-stream,.messages');
    const wasAtBottom=stream&&stream.scrollHeight-stream.clientHeight-stream.scrollTop<75;
    const shrank=previousHeight!==null&&previousHeight-geometry.height>12;
    const changed=previousHeight!==geometry.height;
    const values=[geometry.height,geometry.width,geometry.top,geometry.left,geometry.bottom,geometry.right,geometry.height,geometry.height];
    for(let i=0;i<properties.length;i++){
      const next=values[i]+'px';if(root.style.getPropertyValue(properties[i])!==next)root.style.setProperty(properties[i],next);
    }
    root.toggleAttribute('data-viewport-short',geometry.height<=480);
    previousHeight=geometry.height;
    // Keep the compose area reachable without scrolling the page on every
    // visualViewport scroll or forcing a reader off older chat messages.
    if(changed&&composer&&editable(document.activeElement)){
      if(wasAtBottom&&stream)stream.scrollTop=stream.scrollHeight;
      if(shrank){
        const r=composer.getBoundingClientRect();
        if((r.bottom>geometry.top+geometry.height-8||r.top<geometry.top+8)&&typeof composer.scrollIntoView==='function')
          composer.scrollIntoView({block:'nearest',inline:'nearest',behavior:'auto'});
      }
    }
  }
  function schedule(){if(!queued)queued=requestAnimationFrame(update);}
  if(vv){
    vv.addEventListener('resize',schedule,{passive:true});
    vv.addEventListener('scroll',schedule,{passive:true});
    window.addEventListener('resize',schedule,{passive:true});
    window.addEventListener('orientationchange',schedule,{passive:true});
    window.addEventListener('pageshow',schedule);
    update();
  }
  function refresh(){if(queued){cancelAnimationFrame(queued);queued=0;}update();}
  window.CinemaViewport=Object.freeze({measure,schedule,refresh});
})();
