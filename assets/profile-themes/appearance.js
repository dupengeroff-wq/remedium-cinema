// No anonymous or cross-account first-paint cache. The server supplies the
// authenticated user's preference, or the owner of the currently displayed profile.
(() => {
  const contract=window.CinemaThemeContract || {defaultTheme:'none',choices:{none:'Default'},legacyDisplay:{}};
  const defaultTheme=contract.defaultTheme;
  const choices=Object.freeze({...contract.choices});
  const legacy=Object.freeze({...contract.legacyDisplay});
  function normalize(theme) {
    if(typeof theme!=='string')return defaultTheme;
    if(Object.hasOwn(choices,theme))return theme;
    return Object.hasOwn(legacy,theme)?legacy[theme]:defaultTheme;
  }
  function keyFor(userId) { return typeof userId==='string' && userId ? 'remediumAppearance:'+userId : null; }
  function remember(userId,theme) {
    const key=keyFor(userId);
    if(!key)return;
    // Synchronization hint only; never used as the source for painting.
    try { const value=normalize(theme);if(localStorage.getItem(key)!==value)localStorage.setItem(key,value); } catch {}
  }
  function apply(theme) {
    const selected=normalize(theme);
    const root=document.documentElement;
    if(selected===defaultTheme)delete root.dataset.siteTheme;
    else root.dataset.siteTheme=selected;
    return selected;
  }
  // Presentation only. Never read a theme from storage. One original art decode
  // per document; a generation guard prevents a late decode revealing another owner.
  let paintGeneration=0,artPromise=null,artReady=false;
  const artUrl='/assets/profile-themes/zero-two-original.jpeg';
  function presentation(){if(typeof window.dispatchEvent==='function'&&typeof CustomEvent==='function')window.dispatchEvent(new CustomEvent('cinema-presentation'));}
  let deviceQuality='full',qualityLoaded=false;
  const qualityKey='remediumGlassQuality';
  function quality() {
    if(!qualityLoaded){
      qualityLoaded=true;
      try { deviceQuality=localStorage.getItem(qualityKey)==='light'?'light':'full'; } catch {}
    }
    return deviceQuality;
  }
  function setGlassQuality(value) {
    qualityLoaded=true;deviceQuality=value==='light'?'light':'full';
    if(deviceQuality==='light')document.documentElement.dataset.glassQuality='light';
    else delete document.documentElement.dataset.glassQuality;
    try{localStorage.setItem(qualityKey,deviceQuality)}catch{}
    presentation();
  }
  function syncQuality() {
    if(quality()==='light')document.documentElement.dataset.glassQuality='light';
    else delete document.documentElement.dataset.glassQuality;
  }
  function pending() {
    paintGeneration++;
    const root=document.documentElement;
    delete root.dataset.appearanceRevealed;
    root.dataset.appearancePhase='identity';
    root.dataset.appearancePending='';
    window.CinemaBoot?.arm();
    presentation();
  }
  function loadZeroArt() {
    if(artReady)return Promise.resolve(true);
    if(artPromise)return artPromise;
    if(typeof Image!=='function')return Promise.resolve(false);
    let settle;
    const task=new Promise(resolve=>{settle=resolve});
    artPromise=task;
    const img=new Image();
    let settled=false, decoding=false;
    const done=(ready,terminal=true)=>{
      if(ready)artReady=true;
      if(!settled){settled=true;clearTimeout(timer);settle(ready);}
      if(terminal&&artPromise===task)artPromise=null;
    };
    // Deadline only releases the UI; never claims the file decoded.
    const timer=setTimeout(()=>done(false,false),3500);
    img.onload=()=>{
      if(decoding)return;decoding=true;
      if(typeof img.decode==='function')Promise.resolve(img.decode()).then(()=>done(true),()=>done(false));
      else done(img.naturalWidth>0);
    };
    img.onerror=()=>done(false);
    if('fetchPriority' in img)img.fetchPriority='high';
    img.src=artUrl;
    if(img.complete&&img.naturalWidth>0)img.onload();
    return task;
  }
  function prepare(theme) {
    if(normalize(theme)==='zero-two')return loadZeroArt();
    return Promise.resolve(true);
  }
  function reveal(theme) {
    syncQuality();
    const root=document.documentElement;
    const selected=normalize(theme);
    const wasPending=Object.hasOwn(root.dataset,'appearancePending');
    const changed=(root.dataset.siteTheme||defaultTheme)!==selected;
    if(!wasPending&&!changed){presentation();return selected;}
    if(changed&&!wasPending)pending();
    apply(selected);
    const generation=++paintGeneration;
    root.dataset.appearancePhase='art';
    const finish=()=>{
      if(generation!==paintGeneration)return;
      delete root.dataset.appearancePending;
      delete root.dataset.appearancePhase;
      root.dataset.appearanceRevealed='';
      window.CinemaBoot?.finish();
      presentation();
    };
    if(selected==='zero-two'&&!artReady){
      root.dataset.appearancePending='';
      loadZeroArt().then(finish);
    } else finish();
    return selected;
  }
  function createPageState(isProfile) {
    let accountId=null, accountTheme=defaultTheme, ownerTheme=isProfile?defaultTheme:null;
    const effective=()=>ownerTheme??accountTheme;
    return {
      setAccount(user) {
        const next=user?.id||null;
        if(next!==accountId || !next)ownerTheme=isProfile?defaultTheme:null;
        accountId=next;
        accountTheme=next?normalize(user.theme):defaultTheme;
        if(next)remember(next,user.theme);
        return effective();
      },
      setOwner(theme) {ownerTheme=isProfile?(accountId?normalize(theme):defaultTheme):null;return effective();},
      effective
    };
  }
  apply(defaultTheme);
  window.CinemaAppearance=Object.freeze({defaultTheme,choices,normalize,keyFor,remember,apply,createPageState,pending,reveal,prepare,quality,setGlassQuality});
})();
