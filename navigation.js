(() => {
  const {el,api}=RC;
  const content=document.getElementById('cinemaContent');
  const menu=document.getElementById('cinemaMenu');
  const toggle=document.getElementById('cinemaMenuToggle');
  const scrim=document.getElementById('cinemaMenuScrim');
  const close=document.getElementById('cinemaMenuClose');
  const desktop=matchMedia('(min-width: 1025px)');
  const onCinema=document.body.classList.contains('cinema-page');
  const entries=[
    {label:'Мой профиль',href:'/profile',icon:'profile'},
    {label:'Друзья',href:'/friends',icon:'friends'},
    {label:'Сообщения',href:'/messages',icon:'messages',id:'cinemaMessagesLink'},
    {label:'Кинозал',href:'/',icon:'home',id:'cinemaHomeLink'},
    {label:'Отправить послание',panel:'send-wish',icon:'write',id:'wishOpen'},
    {label:'Послания',panel:'wishInbox',icon:'inbox'},
    {label:'Голосование за фильм',panel:'pollPanel',icon:'vote'},
    {label:'Кинорулетка',panel:'roulettePanel',icon:'roulette'},
    {label:'Наш список фильмов',panel:'watchlist',icon:'films'}
  ];
  const icons={
    home:'M3 10.5 12 3l9 7.5 M5 9.5V21h14V9.5 M10 21v-6h4v6',
    profile:'M15.2 8a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0ZM5 20v-1.5a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5V20',
    friends:'M14 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM4 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1M17 5a3 3 0 0 1 0 6m3 4a4 4 0 0 1 2 4v1',
    messages:'M19 14a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2ZM21 9v8a3 3 0 0 1-3 3h-5',
    write:'m3 10 18-6-6 17-3.5-7.5L3 10Zm8.5 3.5L21 4',
    inbox:'M6 5h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Zm-2 2 8 6 8-6',
    vote:'M20.8 8.7a4.5 4.5 0 0 0-7.7-3.2L12 6.6l-1.1-1.1a4.5 4.5 0 0 0-6.4 6.4l7.5 7.5 7.5-7.5a4.5 4.5 0 0 0 1.3-3.2Z',
    roulette:'M3 6h2c5 0 7 12 13 12h3m-3-3 3 3-3 3M3 18h2c1.4 0 2.5-.8 3.5-2.2m7-7.7C16.3 6.7 17.5 6 19 6h2m-3-3 3 3-3 3',
    films:'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM7 5v14M17 5v14M3 10h4m-4 4h4m10-4h4m-4 4h4'
  };

  function icon(name) {
    const ns='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(ns,'svg');
    const path=document.createElementNS(ns,'path');
    svg.setAttribute('viewBox','0 0 24 24');
    svg.setAttribute('aria-hidden','true');
    svg.setAttribute('fill','none');
    svg.setAttribute('stroke','currentColor');
    svg.setAttribute('stroke-width','1.65');
    svg.setAttribute('stroke-linecap','round');
    svg.setAttribute('stroke-linejoin','round');
    path.setAttribute('d',icons[name]);
    svg.append(path);
    return svg;
  }

  const list=menu.querySelector('ul');
  for(const entry of entries) {
    const row=el(onCinema && entry.id==='wishOpen'?'button':'a',null,'cinema-nav-row');
    if(row.tagName==='A') row.href=entry.href||(onCinema?'':'/')+'#'+entry.panel;
    else row.type='button';
    if(entry.id||entry.panel) row.id=entry.id||'nav-'+entry.panel;
    if(entry.panel && onCinema) {
      const panelId=entry.panel==='send-wish'?'wishCompose':entry.panel;
      row.dataset.openPanel=panelId;
      row.setAttribute('aria-controls',panelId);
      row.setAttribute('aria-haspopup','dialog');
      row.setAttribute('aria-expanded','false');
    }
    row.title=entry.label;
    row.append(icon(entry.icon),el('span',entry.label,'cinema-nav-label'));
    if(entry.icon==='messages'||entry.icon==='inbox'||(entry.icon==='films'&&onCinema)) {
      const count=el('span',null,entry.icon==='films'?'cinema-nav-count':'unread');
      count.id={messages:'directUnread',inbox:'wishBadge',films:'watchCount'}[entry.icon];
      count.hidden=entry.icon!=='films';
      row.append(count);
    }
    const item=el('li');
    item.append(row);
    list.append(item);
  }

  function setRoom(id) {
    const roomUrl=id?'/?room='+encodeURIComponent(id):'/';
    const base=onCinema?'':roomUrl;
    for(const entry of entries) {
      if(entry.panel) {
        const row=document.getElementById(entry.id||'nav-'+entry.panel);
        if(row.tagName==='A') row.href=base+'#'+entry.panel;
      }
    }
    document.getElementById('cinemaHomeLink').href=roomUrl;
  }

  function isOpen() { return menu.classList.contains('is-open'); }
  function setOpen(open,restoreFocus=false) {
    const overlay=open && !desktop.matches;
    menu.classList.toggle('is-open',open);
    document.body.classList.toggle('cinema-menu-open',open);
    menu.inert=!open && !desktop.matches;
    toggle.setAttribute('aria-expanded',String(open));
    toggle.setAttribute('aria-label',open?'Закрыть меню':'Меню кинозала');
    scrim.hidden=!overlay;
    content.inert=overlay;
    if(overlay) {
      menu.setAttribute('role','dialog');
      menu.setAttribute('aria-modal','true');
      close.focus({preventScroll:true});
    } else {
      menu.removeAttribute('role');
      menu.removeAttribute('aria-modal');
      if(restoreFocus) toggle.focus({preventScroll:true});
    }
  }

  function show(visible) {
    setOpen(false);
    menu.hidden=toggle.hidden=!visible;
    document.body.classList.toggle('cinema-account',visible);
  }

  toggle.onclick=()=>setOpen(!isOpen(),true);
  scrim.onclick=close.onclick=()=>setOpen(false,true);
  desktop.addEventListener('change',()=>setOpen(isOpen()));
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape' && isOpen()) setOpen(false,true);
  });
  menu.addEventListener('keydown',event=>{
    if(event.key!=='Tab' || scrim.hidden) return;
    const controls=menu.querySelectorAll('a[href],button:not([disabled])');
    const first=controls[0],last=controls[controls.length-1];
    if((event.shiftKey && document.activeElement===first)||(!event.shiftKey && document.activeElement===last)) {
      event.preventDefault();
      (event.shiftKey?last:first).focus();
    }
  });
  const route=location.pathname;
  for(const row of list.querySelectorAll('a[href]')) {
    if(row.dataset.openPanel || row.hash) continue;
    if((row.id==='cinemaHomeLink' && onCinema) || row.pathname===route ||
      (row.pathname==='/messages' && /^\/messages(?:\/|$)/.test(route))) row.setAttribute('aria-current','page');
  }

  function setUnreadBadge(node,count) {
    node.hidden=!count;
    node.textContent=count>99?'99+':count?'+'+count:'';
    if(count) node.setAttribute('aria-label','Непрочитанных: '+count);
    else node.removeAttribute('aria-label');
  }

  const unread=document.getElementById('directUnread');
  const menuUnread=document.getElementById('cinemaMenuUnread');
  let observedSocket;
  let refreshId=0;
  function setUnread(count) {
    setUnreadBadge(unread,count);
    setUnreadBadge(menuUnread,count);
    if(count) toggle.setAttribute('aria-describedby',menuUnread.id);
    else toggle.removeAttribute('aria-describedby');
  }
  async function refreshUnread() {
    const id=++refreshId;
    try {
      const {unread:total}=await api('/api/dialogs/unread');
      if(id===refreshId) setUnread(Number(total)||0);
    } catch(error) {
      if(id===refreshId && error.status===401) setUnread(0);
    }
  }
  function watchUnread(socket) {
    observedSocket=socket;
    const refresh=()=>{if(observedSocket===socket) refreshUnread()};
    socket.on('connect',refresh);
    socket.on('direct-update',refresh);
    socket.on('direct-unread',refresh);
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden && observedSocket?.connected) refreshUnread()});
  window.addEventListener('pageshow',event=>{
    if(event.persisted && observedSocket?.connected) refreshUnread();
  });

  let previousRoom=null;
  try { previousRoom=sessionStorage.getItem('remediumCinemaRoom'); } catch {}
  if(/^[\w-]{3,80}$/.test(previousRoom||'')) setRoom(previousRoom);
  window.CinemaNav={
    show,setOpen,watchUnread,setUnreadBadge,
    setRoom(id) {
      setRoom(id);
      try {
        if(id) sessionStorage.setItem('remediumCinemaRoom',id);
        else sessionStorage.removeItem('remediumCinemaRoom');
      } catch {}
    },
    clearUnread() { refreshId++; setUnread(0); }
  };
})();
