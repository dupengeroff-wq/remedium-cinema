(() => {
  const {el,api}=RC;
  const content=document.getElementById('cinemaContent');
  const menu=document.getElementById('cinemaMenu');
  menu.tabIndex=-1;
  const toggle=document.getElementById('cinemaMenuToggle');
  const scrim=document.getElementById('cinemaMenuScrim');
  const onCinema=document.body.classList.contains('cinema-page');

  // Mobile keyboards can resize the visual viewport without changing 100dvh.
  const viewport=window.visualViewport;
  if(viewport){
    const resize=()=>{
      const style=document.documentElement.style;
      if(viewport.scale===1)style.setProperty('--cinema-visible-height',viewport.height+'px');
      else style.removeProperty('--cinema-visible-height');
    };
    viewport.addEventListener('resize',resize,{passive:true});
    resize();
  }
  const entries=[
    {label:'Главная',href:'/',icon:'home',id:'cinemaLandingLink'},
    {label:'Мой профиль',href:'/profile',icon:'profile'},
    {label:'Друзья',href:'/friends',icon:'friends'},
    {label:'Сообщения',href:'/messages',icon:'send',id:'cinemaMessagesLink',badge:'directUnread'},
    {label:'Отправить послание',panel:'send-wish',icon:'mail-plus',id:'wishOpen'},
    {label:'Послания',panel:'wishInbox',icon:'book-heart',badge:'wishBadge'},
    {label:'Голосование за фильм',panel:'pollPanel',icon:'vote'},
    {label:'Кинорулетка',panel:'roulettePanel',icon:'roulette'},
    {label:'Наш список фильмов',panel:'watchlist',icon:'films'}
  ];
  const icons={
    logout:'M10 4H5v16h5 M9 12h12 M16 7l5 5-5 5',
    home:'M3 10.5 12 3l9 7.5 M5 9.5V21h14V9.5 M10 21v-6h4v6',
    profile:'M15.2 8a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0ZM5 20v-1.5a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5V20',
    friends:'M14 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM4 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1M17 5a3 3 0 0 1 0 6m3 4a4 4 0 0 1 2 4v1',
    vote:'M20.8 8.7a4.5 4.5 0 0 0-7.7-3.2L12 6.6l-1.1-1.1a4.5 4.5 0 0 0-6.4 6.4l7.5 7.5 7.5-7.5a4.5 4.5 0 0 0 1.3-3.2Z',
    roulette:'M3 6h2c5 0 7 12 13 12h3m-3-3 3 3-3 3M3 18h2c1.4 0 2.5-.8 3.5-2.2m7-7.7C16.3 6.7 17.5 6 19 6h2m-3-3 3 3-3 3',
    films:'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM7 5v14M17 5v14M3 10h4m-4 4h4m10-4h4m-4 4h4'
  };

  /* Lucide SVG paths (https://github.com/lucide-icons/lucide/tree/main/icons)
     ISC License

     Copyright (c) 2026 Lucide Icons and Contributors

     Permission to use, copy, modify, and/or distribute this software for any
     purpose with or without fee is hereby granted, provided that the above
     copyright notice and this permission notice appear in all copies.

     THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
     WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
     MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
     ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
     WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
     ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
     IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
  */
  const lucideIcons={
    send:{
      transform:'translate(.6 .6) scale(.95)',
      paths:[
        'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z',
        'm21.854 2.147-10.94 10.939'
      ]
    },
    'mail-plus':{
      transform:'translate(.6 .6) scale(.95)',
      paths:[
        'M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8',
        'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7',
        'M19 16v6',
        'M16 19h6'
      ]
    },
    'book-heart':{
      transform:'translate(.6 .6) scale(.95)',
      paths:[
        'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20',
        'M8.62 9.8A2.25 2.25 0 1 1 12 6.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a.998.998 0 0 1-1.507 0z'
      ]
    }
  };

  function icon(name) {
    const ns='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(ns,'svg');
    const lucide=lucideIcons[name];
    const isMessage=name==='send';
    svg.setAttribute('viewBox','0 0 24 24');
    svg.setAttribute('aria-hidden','true');
    svg.setAttribute('fill','none');
    svg.setAttribute('stroke','currentColor');
    svg.setAttribute('stroke-width',lucide?'1.6':'1.65');
    svg.setAttribute('stroke-linecap','round');
    svg.setAttribute('stroke-linejoin','round');
    const shape=lucide?.transform?document.createElementNS(ns,'g'):svg;
    if(shape!==svg){
      shape.setAttribute('transform',lucide.transform);
      svg.append(shape);
    }
    for(const data of lucide?.paths||[icons[name]]){
      const path=document.createElementNS(ns,'path');
      path.setAttribute('d',data);
      shape.append(path);
    }
    if(lucide){
      svg.setAttribute('class',isMessage?'message-icon':'wish-icon');
      svg.setAttribute('width','20');
      svg.setAttribute('height','20');
    }
    return svg;
  }

  const account=el('a',null,'cinema-menu-account');
  account.href='/profile';
  account.hidden=true;
  const avatar=el('span',null,'cinema-menu-avatar');
  avatar.setAttribute('aria-hidden','true');
  const identity=el('span',null,'cinema-menu-identity');
  const nickname=el('strong');
  const login=el('span',null,'cinema-menu-login');
  const presence=el('span',null,'connection-state');
  identity.append(nickname,login,presence);
  account.append(avatar,identity);
  const head=menu.querySelector('.cinema-menu-head');
  const close=el('button','×','cinema-tool-close cinema-menu-close');
  close.type='button';
  close.setAttribute('aria-label','Закрыть меню');
  close.onclick=()=>setOpen(false,true);
  head.append(close);
  const scrollArea=el('div',null,'cinema-menu-scroll');
  scrollArea.append(account,head,menu.querySelector('nav'));
  menu.append(scrollArea);

  const wide=window.matchMedia('(min-width:1100px)');
  const {key:preferenceKey,cached:lastTheme,apply:paintTheme}=CinemaAppearance;
  let accountId=null;
  let ownTheme=null;
  let revision=0;

  function applyAccountTheme(theme) {
    ownTheme=theme;
    paintTheme(theme,true);
    updateMenuTheme();
  }

  async function refreshAppearance() {
    if(!accountId){paintTheme(lastTheme());return}
    const request=++revision;
    try {
      const {user}=await api('/api/auth/me');
      if(request!==revision || !user || user.id!==accountId || user.theme===ownTheme)return;
      applyAccountTheme(user.theme);
      window.dispatchEvent(new CustomEvent('cinema-appearance',{detail:user.theme}));
    } catch { /* Keep the current palette while disconnected. */ }
  }
  window.addEventListener('storage',event=>{
    if(event.key===preferenceKey)refreshAppearance();
  });
  window.addEventListener('pageshow',event=>{if(event.persisted)refreshAppearance()});
  let pageTheme=null;
  function updateMenuTheme() {
    menu.dataset.theme=ownTheme||pageTheme||'';
    const pinned=menu.dataset.theme==='zero-two' && pageTheme==='zero-two' && wide.matches && !menu.hidden;
    if(pinned===menu.classList.contains('is-pinned')) return;
    menu.classList.toggle('is-pinned',pinned);
    document.body.classList.toggle('cinema-menu-pinned',pinned);
    setOpen(false);
  }
  wide.addEventListener('change',updateMenuTheme);

  function setProfileTheme(theme) {
    pageTheme=theme;
    updateMenuTheme();
  }

  function setUser(user) {
    revision++;
    accountId=user?.id||null;
    if(user)applyAccountTheme(user.theme);
    else {ownTheme=null;paintTheme(lastTheme());updateMenuTheme()}
    account.hidden=!user;
    const name=user?.nickname||'';
    nickname.textContent=name;
    login.textContent=user?'@'+user.login:'';
    const initial=name.slice(0,1).toUpperCase()||'✦';
    avatar.textContent=initial;
    if(user?.avatar){
      const image=el('img');
      image.alt='';
      image.src=user.avatar;
      image.onerror=()=>{if(avatar.contains(image))avatar.textContent=initial};
      avatar.replaceChildren(image);
    }
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
    const showsFilmCount=entry.panel==='watchlist'&&onCinema;
    if(entry.badge||showsFilmCount) {
      const count=el('span',null,showsFilmCount?'cinema-nav-count':'unread');
      count.id=entry.badge||'watchCount';
      count.hidden=!showsFilmCount;
      row.append(count);
    }
    const item=el('li');
    item.append(row);
    list.append(item);
  }

  const logoutGroup=el('div',null,'cinema-menu-logout');
  const logout=el('button',null,'cinema-nav-row');
  logout.type='button';
  logout.append(icon('logout'),el('span','Выход','cinema-nav-label'));
  const logoutError=el('p');
  logoutError.setAttribute('role','alert');
  logoutError.hidden=true;
  logoutGroup.append(logout,logoutError);
  scrollArea.append(logoutGroup);
  logout.onclick=async()=>{
    logout.disabled=true;
    logoutError.hidden=true;
    try {
      await api('/api/auth/logout',{method:'POST'});
    } catch(error) {
      if(error.status!==401) {
        logoutError.textContent='Не удалось выйти. Попробуй ещё раз.';
        logoutError.hidden=false;
        logout.disabled=false;
        return;
      }
    }
    window.CinemaNav.setRoom(null);
    location.replace('/');
  };

  function setRoom(id) {
    const roomUrl=id?'/?room='+encodeURIComponent(id):'/';
    const base=onCinema?'':roomUrl;
    for(const entry of entries) {
      if(entry.panel) {
        const row=document.getElementById(entry.id||'nav-'+entry.panel);
        if(row.tagName==='A') row.href=base+'#'+entry.panel;
      }
    }
  }

  function isOpen() { return menu.classList.contains('is-open'); }
  function setOpen(open,restoreFocus=false) {
    menu.classList.toggle('is-open',open);
    document.documentElement.classList.toggle('cinema-menu-open',open);
    document.body.classList.toggle('cinema-menu-open',open);
    menu.inert=!open && !menu.classList.contains('is-pinned');
    toggle.setAttribute('aria-expanded',String(open));
    toggle.setAttribute('aria-label',open?'Закрыть меню':'Меню кинозала');
    scrim.hidden=!open;
    content.inert=open;
    if(open) {
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
    if(!visible){pageTheme=null;setUser(null)}
    updateMenuTheme();
  }

  toggle.onclick=()=>setOpen(!isOpen(),true);
  scrim.onclick=()=>setOpen(false,true);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape' && isOpen()) setOpen(false,true);
  });
  menu.addEventListener('keydown',event=>{
    if(event.key!=='Tab' || scrim.hidden) return;
    const controls=menu.querySelectorAll('a[href]:not([hidden]),button:not([disabled])');
    const first=controls[0],last=controls[controls.length-1];
    if((event.shiftKey && (document.activeElement===first||document.activeElement===menu))||(!event.shiftKey && document.activeElement===last)) {
      event.preventDefault();
      (event.shiftKey?last:first).focus();
    }
  });
  const route=location.pathname;
  for(const row of list.querySelectorAll('a[href]')) {
    if(row.dataset.openPanel || row.hash) continue;
    if((row.pathname==='/' ? onCinema && row.id==='cinemaLandingLink' : row.pathname===route) ||
      (row.pathname==='/profile' && /^\/profile(?:\/|$)/.test(route)) ||
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
    function updatePresence() {
      if(observedSocket!==socket)return;
      presence.classList.toggle('is-online',socket.connected);
      presence.textContent=socket.connected?'В сети':'Не в сети';
    }
    updatePresence();
    const refresh=()=>{if(observedSocket===socket) refreshUnread()};
    socket.on('connect',updatePresence);
    socket.on('disconnect',updatePresence);
    const syncTheme=()=>{if(observedSocket===socket)refreshAppearance()};
    socket.on('connect',syncTheme);
    socket.on('appearance-changed',syncTheme);
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
    show,setOpen,setUser,setProfileTheme,watchUnread,setUnreadBadge,messageIcon:()=>icon('send'),
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
