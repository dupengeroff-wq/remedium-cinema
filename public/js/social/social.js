(() => {
  const {el,button,link,field,api,date,duration,codesPanel}=RC;
  const main=document.getElementById('socialMain');
  const modal=document.getElementById('socialDialog');
  const detail=document.getElementById('socialDialogContent');
  const segment=location.pathname.split('/').filter(Boolean);
  const options=new URLSearchParams(location.search);
  let viewer;
  let socket;
  let reconnect;
  let accountGeneration=0;
  let directRefresh;
  let refreshDialogList;
  let friendRefresh;
  let disposeMessageView;
  let profileId;
  let displayedProfile=null;
  window.addEventListener('cinema-appearance',event=>{
    const change=event.detail;
    if(!viewer || change.userId!==viewer.id)return;
    viewer.theme=change.theme;
    viewer.themeKey=change.themeKey;
    // A preference update for the visitor must never change another owner's page.
    if(!displayedProfile || displayedProfile.person.id!==viewer.id)return;
    displayedProfile.theme=change.theme;
    displayedProfile.themeKey=change.themeKey;
    applyProfileTheme(displayedProfile.theme);
    const frame=main.querySelector('.profile-avatar-frame');
    if(frame)fillProfileAvatar(frame,displayedProfile.person,displayedProfile.theme);
    for(const choice of detail.querySelectorAll('.profile-theme-card')){
      const selected=choice.dataset.theme===displayedProfile.theme;
      choice.setAttribute('aria-pressed',String(selected));
      const marker=choice.querySelector('.profile-theme-marker');
      marker.replaceChildren();
      if(selected)marker.append(icon('check'),el('span','Выбрана'));
    }
  });
  let cancelCoverSearch;
  let openProfileHistory;
  let profileRender=0;

  const navigation=document.getElementById('socialNav');
  if(segment[0]==='messages'){
    const previous=document.referrer?new URL(document.referrer):null;
    const previousPage=previous?.pathname;
    const canReturn=previous?.origin===location.origin && (
      previousPage==='/' || previousPage==='/index.html' ||
      /^\/(profile|friends)(\/|$)/.test(previousPage) ||
      (segment[1] && previousPage==='/messages')
    );
    const back=canReturn?previousPage+previous.search:(segment[1]?'/messages':'/');
    navigation.append(link('← Назад',back,'social-back'));
  }

  const empty=text=>el('p',text,'social-note');
  const profileThemes=CinemaAppearance.choices;
  const sharedVideoPrefix='Видео из кинозала\n';
  function sharedVideoUrl(body) {
    if (!body.startsWith(sharedVideoPrefix)) return null;
    try {
      const url=new URL(body.slice(sharedVideoPrefix.length));
      if (['https:','http:'].includes(url.protocol) && !url.username && !url.password) return url;
    } catch {}
    return null;
  }
  const iconPaths={
    king:'M3 7l5 4 4-7 4 7 5-4-2 11H5L3 7zm2.5 14h13 M12 2v3 M10.5 3.5h3',
    queen:'M3 8l4 5 2-7 3 5 3-5 2 7 4-5-2.5 10h-13L3 8zm3 13h12 M11 3l1-1 1 1-1 1z',
    clock:'M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
    film:'M4 8h16v12H4zM4 8l-1-4 16-2 1 6M8 3l2 4m3-4 2 4',
    calendar:'M4 6h16v15H4zM8 3v5m8-5v5M4 11h16',
    people:'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2',
    edit:'M14 5l5 5M4 20l1.1-5L16.5 3.6a2 2 0 0 1 2.8 0l1.1 1.1a2 2 0 0 1 0 2.8L9 19Z',
    brush:'M11.6 11.8C14.7 7.7 18.5 3.4 21 2.1c.8-.4 1.3.2.9 1.1-1.2 2.9-4.4 7.8-7.5 11.2Z M10.3 13.8c-2.3-.7-4.3.7-4.9 3.2-.4 1.8-1.4 3.3-3.4 3.9 4.3 1.4 8.9.6 10.1-2.2.7-1.7.1-3.4-1.8-4.9Z',
    bow:'M9 9.5 4.8 6.8A2.4 2.4 0 0 0 1 8.8v6.4a2.4 2.4 0 0 0 3.8 2L9 14.5m6-5 4.2-2.7a2.4 2.4 0 0 1 3.8 2v6.4a2.4 2.4 0 0 1-3.8 2L15 14.5M9 12a3 3 0 1 1 6 0 3 3 0 0 1-6 0Z',
    heart:'M12 20.5 3.8 12.3a4.8 4.8 0 0 1 6.8-6.8L12 7l1.4-1.5a4.8 4.8 0 0 1 6.8 6.8Z',
    check:'m5 12 4 4L19 6',
    trash:'M4 7h16m-10 4v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3',
    userPlus:'M14 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM3 21v-2a5 5 0 0 1 5-5h5a5 5 0 0 1 5 5v2M20 8v6m-3-3h6',
    lock:'M7 11V7a5 5 0 0 1 10 0v4M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM12 16v2',
    chevron:'m9 6 6 6-6 6'
  };
  function icon(name) {
    const ns='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 24 24');
    svg.setAttribute('class','social-icon');
    svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(ns,'path');
    path.setAttribute('d',iconPaths[name]);
    path.setAttribute('fill','none');
    path.setAttribute('stroke','currentColor');
    path.setAttribute('stroke-width','1.65');
    path.setAttribute('stroke-linecap','round');
    path.setAttribute('stroke-linejoin','round');
    svg.append(path);
    return svg;
  }
  function panel(title,cls='') {
    const node=el('section',null,('social-panel '+cls).trim());
    if(title) node.append(el('h2',title));
    return node;
  }
  function showModal(title,content) {
    cancelCoverSearch?.();
    cancelCoverSearch=null;
    const heading=el('h2',title);
    heading.id='socialDialogTitle';
    detail.replaceChildren(heading,content);
    modal.scrollTop=0;
    if(!modal.open) modal.showModal();
  }
  modal.addEventListener('close',()=>{
    if(modal.open) return;
    cancelCoverSearch?.();
    cancelCoverSearch=null;
  });
  function failure(error,node=main) {
    if(error.status===401){
      accountGeneration++;profileRender++;
      reconnect?.suspend();
      displayedProfile=null;viewer=null;
      const previous=socket;socket=null;previous?.disconnect();
      disposeMessageView?.();disposeMessageView=null;
      directRefresh=refreshDialogList=friendRefresh=null;
      if(modal.open)modal.close();
      document.body.classList.remove('profile-page');
      applyProfileTheme('none');
      CinemaNav.show(false);
      CinemaNav.clearUnread();
      const form=panel('Войди в REMEDIUM CINEMA','social-auth');
      main.replaceChildren(form);
      RC.mount(form,start);
      return;
    }
    if(!displayedProfile && document.documentElement.hasAttribute('data-appearance-pending'))CinemaAppearance.reveal(CinemaAppearance.defaultTheme);
    node.replaceChildren(empty(error.message||'Действие не удалось.'));
    if(node===main)node.append(button('Повторить',initAccount));
  }
  function run(node,work,after) {
    return async ()=>{
      node.disabled=true;
      try { const result=await work(); if(after) await after(result); }
      catch(error){ showModal('Действие не выполнено',empty(error.message)); }
      finally { node.disabled=false; }
    };
  }
  function action(label,work,after) {
    const b=button(label);
    b.onclick=run(b,work,after);
    return b;
  }
  function avatar(person,large=false) {
    const node=el('span',null,'social-avatar'+(large?' large':''));
    if(person.avatar) {
      const image=el('img');
      image.alt='';image.decoding='async';if(!large)image.loading='lazy';
      image.src=person.avatar;
      image.onerror=()=>{node.replaceChildren(document.createTextNode(person.nickname.slice(0,1).toUpperCase()||'✦'))};
      node.append(image);
    } else node.textContent=person.nickname.slice(0,1).toUpperCase()||'✦';
    return node;
  }
  const profileLink=(person,label=person.nickname)=>link(label,'/profile/'+person.id,'');
  function personRow(person,tools=[]) {
    const row=el('div',null,'person-row');
    const desc=el('div',null,'grow');
    desc.append(profileLink(person),el('div','@'+person.login,'muted'));
    const photo=profileLink(person,'');
    photo.setAttribute('aria-label','Профиль '+person.nickname);
    photo.append(avatar(person));
    row.append(photo,desc);
    if(tools.length) {
      const controls=el('div',null,'row-actions');
      controls.append(...tools);
      row.append(controls);
    }
    return row;
  }

  const statLabels={seconds:'Время просмотра',films:'Фильмы',sessions:'Сеансы',days:'Дни просмотра',
    last:'Последний просмотр',shared_count:'Совместные сеансы',first:'Первый просмотр'};
  const statIcons={seconds:'clock',films:'film',sessions:'film',days:'calendar',last:'clock',shared_count:'people',first:'calendar'};
  const jointLabels={...statLabels,seconds:'Вместе',sessions:'Совместные сеансы'};
  const jointIcons={...statIcons,sessions:'people'};
  function stats(values,labels=statLabels,icons=statIcons) {
    const grid=el('div',null,'stat-grid');
    for(const [key,value] of Object.entries(values)){
      if(!labels[key])continue;
      const card=el('div',null,'stat');
      const formatted=key==='seconds'?duration(value).replace(/ (ч|мин|с)(?= |$)/g,'\u00a0$1')
        :['first','last'].includes(key)?date(value):String(value);
      const info=el('div',null,'grow');
      info.append(el('strong',formatted),el('span',labels[key]));
      card.append(icon(icons[key]),info);
      grid.append(card);
    }
    return grid;
  }

  function profileStats(values,joint=false) {
    const featured=joint?['seconds','films','sessions']:['seconds','films','sessions','days'];
    const primary={},secondary={};
    for(const [key,value] of Object.entries(values)){
      const group=featured.includes(key)?primary:secondary;
      group[key]=value;
    }
    const labels=joint?jointLabels:statLabels;
    const icons=joint?jointIcons:statIcons;
    if(!Object.keys(primary).length)return stats(values,labels,icons);
    const content=el('div',null,'profile-stat-group');
    content.append(stats(primary,labels,icons));
    if(Object.keys(secondary).length){
      const more=el('details',null,'profile-more-stats');
      more.append(el('summary','Другие показатели'),stats(secondary,labels,icons));
      content.append(more);
    }
    return content;
  }

  function profileBow(className) {
    const bow=el('span',null,className);
    bow.setAttribute('aria-hidden','true');
    bow.append(icon('bow'),el('span',null,'profile-theme-glyph'));
    return bow;
  }

  function profileHeading(title) {
    const heading=el('h2',title);
    heading.append(profileBow('profile-heading-ribbon'));
    return heading;
  }

  function applyProfileTheme(theme) {
    const selected=CinemaAppearance.normalize(theme);
    document.body.dataset.profileTheme=selected;
    CinemaNav.setProfileTheme(selected);
    document.body.classList.toggle('profile-themed',selected!=='none' && selected!=='zero-two');
    document.body.classList.toggle('profile-kitty',selected==='hello-kitty-pink');
  }

  function fillProfileAvatar(frame,person,_theme) {
    // The theme decorates the profile; it must not replace its owner's identity.
    frame.replaceChildren(avatar(person,true));
  }

  function showThemePicker(data,trigger) {
    const picker=el('div',null,'profile-theme-picker');
    const grid=el('div',null,'profile-theme-grid');
    const status=el('p',null,'form-status');
    status.setAttribute('role','status');
    const qualityLabel=el('label','Облегчённые эффекты на этом устройстве','glass-quality-option');
    const qualityToggle=el('input');qualityToggle.type='checkbox';qualityToggle.checked=CinemaAppearance.quality()==='light';
    qualityToggle.onchange=()=>CinemaAppearance.setGlassQuality(qualityToggle.checked?'light':'full');
    qualityLabel.append(qualityToggle);
    picker.append(el('p','Выберите тему для своего профиля','profile-theme-description'),grid,status,qualityLabel);
    let saving=false;
    const choices=Object.entries(profileThemes).map(([theme,label])=>{
      const chosen=theme===(data.theme||'none');
      const option=button('',()=>save(theme));
      option.className='profile-theme-card';
      option.dataset.theme=theme;
      option.setAttribute('aria-pressed',String(chosen));
      const sample=el('span',null,'profile-theme-sample');
      sample.setAttribute('aria-hidden','true');
      sample.append(el('span',null,'profile-theme-glyph'));
      const marker=el('span',null,'profile-theme-marker');
      if(chosen) marker.append(icon('check'),el('span','Выбрана'));
      option.append(sample,el('strong',label),marker);
      return option;
    });

    async function save(theme) {
      if(saving) return;
      if(theme===(data.themeKey??data.theme??'none')){modal.close();return}
      saving=true;
      trigger.disabled=true;
      choices.forEach(choice=>choice.disabled=true);
      status.textContent='Сохраняем…';
      try {
        const ownerId=data.person.id;
        const saved=await api('/api/profile/theme',{method:'PATCH',body:{theme,userId:ownerId}});
        if(viewer?.id!==ownerId || displayedProfile!==data)return;
        data.theme=saved.theme;
        data.themeKey=saved.themeKey;
        viewer.theme=saved.theme;
        viewer.themeKey=saved.themeKey;
        CinemaNav.setUser(viewer);
        applyProfileTheme(saved.theme);
        const frame=main.querySelector('.profile-avatar-frame');
        if(frame) fillProfileAvatar(frame,data.person,saved.theme);
        if(modal.open&&picker.isConnected) modal.close();
      } catch(error) {
        status.textContent=historyRequestError(error);
      } finally {
        saving=false;
        trigger.disabled=false;
        choices.forEach(choice=>choice.disabled=false);
        if(!modal.open&&trigger.isConnected) trigger.focus({preventScroll:true});
      }
    }

    grid.addEventListener('keydown',event=>{
      const index=choices.indexOf(event.target);
      if(index<0)return;
      const target={ArrowLeft:index-1,ArrowRight:index+1,Home:0,End:choices.length-1}[event.key];
      if(target===undefined)return;
      event.preventDefault();
      choices[Math.max(0,Math.min(choices.length-1,target))].focus();
    });
    grid.append(...choices);
    showModal('Выбор темы профиля',picker);
    const selected=choices.find(choice=>choice.getAttribute('aria-pressed')==='true');
    if(selected){
      grid.scrollLeft=selected.offsetLeft-(grid.clientWidth-selected.offsetWidth)/2;
      selected.focus({preventScroll:true});
    }
  }

  modal.addEventListener('click',event=>{
    if(event.target!==modal||!detail.querySelector('.profile-theme-picker')) return;
    const rect=modal.getBoundingClientRect();
    if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom) modal.close();
  });

  function displayMovieTitle(item) {
    const title=item.movie_title?.trim();
    return title&&!/^(?:youtube|vk видео|rutube|видео)$/i.test(title)?title:'';
  }

  function posterSource(key) {
    if(typeof key!=='string')return null;
    if(/^posters\/[a-z0-9-]+\.webp$/i.test(key))return '/'+key;
    try {
      const url=new URL(key);
      if(url.protocol==='https:'&&!url.username&&!url.password)return url.href;
    } catch {}
    return null;
  }

  function historyPoster(item) {
    const poster=el('div','✦','history-poster');
    const source=posterSource(item.poster_key);
    if(source){
      const img=el('img');
      img.alt='';
      img.loading='lazy';img.decoding='async';
      img.referrerPolicy='no-referrer';
      img.src=source;
      img.onerror=()=>{poster.textContent='✦'};
      poster.replaceChildren(img);
    }
    poster.setAttribute('aria-hidden','true');
    return poster;
  }

  function personalCatalogCover(name) {
    try{
      const items=JSON.parse(localStorage.getItem('remediumCinemaPersonalWatchV1'));
      const key=name.toLocaleLowerCase('ru');
      const match=Array.isArray(items)&&items.find(entry=>typeof entry?.name==='string'&&entry.name.trim().toLocaleLowerCase('ru')===key&&posterSource(entry.poster));
      return match?{title:match.name,poster_key:match.poster}:null;
    }catch{return null}
  }

  function coverEditor(item,options,back) {
    const editor=el('div',null,'history-cover-editor');
    const status=el('p',null,'form-status');
    status.setAttribute('role','status');
    const results=el('div',null,'history-list');
    const initialTitle=displayMovieTitle(item);
    const title=field('Название фильма','title',{value:initialTitle,maxLength:120,required:true});
    const searchForm=el('form',null,'history-cover-form');
    const search=el('button','Найти обложку','btn');
    search.type='submit';
    searchForm.append(title.group,search);
    const manualForm=el('form',null,'history-cover-form');
    const initialAddress=item.custom_poster_url?.startsWith('https://')?item.custom_poster_url:'';
    const address=field('HTTPS-ссылка на обложку','poster',{type:'url',maxLength:1200,value:initialAddress});
    const saveManual=el('button','Сохранить обложку по ссылке','btn');
    saveManual.type='submit';
    manualForm.append(address.group,saveManual);
    const base='/api/watch-history/'+item.id;
    let saving=false;
    let searchRequest;
    const isOpen=()=>modal.open&&editor.isConnected;

    async function save(values,control) {
      if(saving)return;
      saving=true;
      control.disabled=true;
      status.textContent='Сохраняем…';
      let saved=false;
      try{
        await api(base+'/cover',{method:'PATCH',body:{revision:item.poster_revision??null,...values}});
        saved=true;
        await renderProfile(editor);
      }catch(error){
        if(isOpen()) status.textContent=saved?'Изменения сохранены. Не удалось обновить историю.':historyRequestError(error);
      }finally{
        saving=false;
        control.disabled=false;
      }
    }

    function filmRow(film,control) {
      const row=el('div',null,'history-row');
      const info=el('div',null,'grow');
      info.append(el('strong',film.title+(film.release_year?' ('+film.release_year+')':'')),control);
      row.append(historyPoster(film),info);
      return row;
    }

    function showFilms(films) {
      results.replaceChildren(...films.map(film=>filmRow(film,button('Выбрать',()=>{
        const confirm=button('Подтвердить обложку',()=>{
          const values=film.id?{filmId:film.id}:{poster:film.poster_key,title:film.title};
          save(values,confirm);
        },true);
        results.replaceChildren(filmRow(film,confirm),button('Назад к результатам',()=>showFilms(films)));
      }))));
    }

    searchForm.onsubmit=async event=>{
      event.preventDefault();
      const name=title.input.value.trim();
      if(name.length<2){status.textContent='Введи название фильма.';return}
      searchRequest?.abort();
      const request=new AbortController();
      searchRequest=request;
      search.disabled=true;
      status.textContent='Ищем обложки…';
      results.replaceChildren();
      const custom=personalCatalogCover(name);
      try {
        const signal=AbortSignal.any([request.signal,AbortSignal.timeout(12000)]);
        const {films}=await api(base+'/cover-search?title='+encodeURIComponent(name),{signal});
        if(request!==searchRequest||!isOpen())return;
        const candidates=custom?[custom,...films.filter(film=>film.poster_key!==custom.poster_key)]:films;
        showFilms(candidates);
        status.textContent=candidates.length?'':options.searchAvailable
          ?'Обложки не найдены.'
          :'В каталоге сайта обложка не найдена. Можно указать ссылку вручную.';
      }catch(error){
        if(request===searchRequest&&!request.signal.aborted&&isOpen()){
          if(custom)showFilms([custom]);
          status.textContent=historyRequestError(error);
        }
      }finally{
        if(request===searchRequest){
          searchRequest=null;
          search.disabled=false;
        }
      }
    };
    manualForm.onsubmit=event=>{
      event.preventDefault();
      const values={};
      const name=title.input.value.trim();
      const poster=address.input.value.trim();
      if(name&&name!==initialTitle) values.title=name;
      if(poster!==initialAddress||(!values.title&&!poster&&item.custom_poster_url)) values.poster=poster;
      if(!Object.keys(values).length){status.textContent='Укажи новое название или ссылку на обложку.';return}
      save(values,saveManual);
    };
    editor.append(button('Назад к истории',back),searchForm,results,manualForm,status);
    if(options.searchAvailable||item.release_year){
      const credits=el('details',null,'profile-more-stats');
      const logo=el('img',null,'tmdb-attribution-logo');
      logo.src='https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg';
      logo.alt='TMDB';
      logo.loading='lazy';
      const attribution=link('','https://www.themoviedb.org','');
      attribution.append(logo);
      credits.append(el('summary','Источник данных'),attribution,
        empty('This product uses the TMDB API but is not endorsed or certified by TMDB.'));
      editor.append(credits);
    }
    showModal('Обложка фильма',editor);
    cancelCoverSearch=()=>searchRequest?.abort();
    title.input.focus();
  }

  function historyRequestError(error) {
    return error.name==='TimeoutError'?'Сервер не ответил вовремя. Попробуй снова.':error.message;
  }

  function confirmWatchDeletion(item,back) {
    const content=el('div',null,'history-delete-confirm');
    const actions=el('div',null,'history-delete-actions');
    const status=el('p',null,'form-status');
    status.setAttribute('role','status');
    let deleting=false,deleted=false;
    const confirm=button('Удалить',async ()=>{
      if(deleting)return;
      deleting=true;
      confirm.disabled=true;
      status.textContent=deleted?'Обновляем историю…':'Удаляем просмотр…';
      try{
        if(!deleted){
          await api('/api/watch-history/'+item.id,{method:'DELETE'});
          deleted=true;
        }
        await renderProfile(content);
      }catch(error){
        if(modal.open&&content.isConnected){
          status.textContent=deleted?'Просмотр удалён. Не удалось обновить историю.':historyRequestError(error);
          if(deleted)confirm.textContent='Обновить список';
        }
      }finally{
        deleting=false;
        confirm.disabled=false;
      }
    },true);
    actions.append(button('Отмена',back),confirm);
    content.append(el('p','Вы действительно хотите удалить эту запись из истории просмотров?'),actions,status);
    showModal('Удалить просмотр?',content);
    actions.firstElementChild.focus();
  }

  // Refresh only visible history blocks, through the same privacy-checked route
  // that supplied them. An open cover editor keeps its draft and original revision.
  function createHistoryReadBatch(fetcher) {
    const requests=new Map();
    // This map lives for one dispatch only. Never share a result across a later
    // event, account generation, or explicit user action.
    return path=>{
      if(!requests.has(path))requests.set(path,Promise.resolve().then(()=>fetcher(path)));
      return requests.get(path);
    };
  }
  function profileHistoryPath(id,query,offset=0,filters={},own=false){
    const params=new URLSearchParams(query);
    params.set('historyOnly','1');
    if(offset>0)params.set('offset',String(offset));
    if(filters.q)params.set('q',filters.q);
    if(filters.status&&filters.status!=='all')params.set('status',filters.status);
    if(own&&filters.rated&&filters.rated!=='all')params.set('rated',filters.rated);
    return '/api/profiles/'+id+'?'+params;
  }
  function latestStoredMessage(stored){
    let latest=null,lastId=0n;
    for(const message of stored.values()){
      const id=BigInt(message.id);
      if(!latest||id>lastId){latest=message;lastId=id}
    }
    return latest;
  }
  function bindHistoryUpdates(node,items,load,draw) {
    node.classList.add('live-watch-history');
    let generation=0;
    node.addEventListener('watch-history-refresh',async event=>{
      if(event.detail?.id && !items.some(item=>item.id===event.detail.id))return;
      const account=accountGeneration;
      const request=++generation;
      try{
        const value=await load(event.detail?.read||api);
        if(account!==accountGeneration||request!==generation||!node.isConnected)return;
        items=value.history||[];
        draw(items,value);
      }catch(error){
        if(account===accountGeneration&&request===generation&&node.isConnected&&[401,403,404].includes(error.status))draw([]);
      }
    });
  }

  function refreshVisibleHistory(id=null) {
    const account=accountGeneration;
    const read=createHistoryReadBatch(path=>account===accountGeneration&&viewer?api(path):Promise.reject(new Error('Account changed')));
    for(const node of document.querySelectorAll('.live-watch-history')){
      const dialog=node.closest('dialog');
      if(dialog&&!dialog.open)continue;
      node.dispatchEvent(new CustomEvent('watch-history-refresh',{detail:{id,read}}));
    }
  }

  if(segment[0]==='profile'){
    document.addEventListener('visibilitychange',()=>{
      if(!document.hidden&&socket?.connected)refreshVisibleHistory();
    });
  }

  const decimalRating=value=>Number(value).toLocaleString('ru-RU',{maximumFractionDigits:1});
  function ratingBadge(item){
    return item.rating?.score==null?'Оценить фильм':decimalRating(item.rating.score)+' / 10 · Изменить оценку';
  }
  function ratingEditor(item,back) {
    const ownerId=viewer?.id;
    const content=el('div',null,'rating-editor');
    content.append(el('strong',displayMovieTitle(item)||'Без названия','rating-film-title'));
    content.append(el('p','Одна личная оценка на фильм. Повторные просмотры не создают новую оценку.','social-note'));
    let score=item.rating?.score??null;
    const scale=el('div',null,'rating-scale');scale.setAttribute('role','group');scale.setAttribute('aria-label','Оценка от 1 до 10');
    const value=el('p',score===null?'Выбери оценку':decimalRating(score)+' / 10','rating-value');value.setAttribute('aria-live','polite');
    const choices=[];
    for(let i=1;i<=10;i++){
      const choice=button(String(i),()=>{score=i;draw()});
      choice.setAttribute('aria-label',i+' из 10');choices.push(choice);scale.append(choice);
    }
    const share=el('input');share.type='checkbox';share.checked=item.rating?.shareWithPartners===true;
    const shareLabel=el('label',null,'rating-opt-in');shareLabel.append(share,el('span','Показывать совместную оценку с теми, с кем смотрели этот фильм'));
    const note=el('p','Только если оба поделились оценкой и настройки приватности разрешают историю и совместную статистику. По умолчанию оценка личная.','social-note');
    const status=el('p',null,'form-status');status.setAttribute('role','status');
    const actions=el('div',null,'rating-actions');
    let saving=false;
    function draw(){
      for(let i=0;i<choices.length;i++)choices[i].setAttribute('aria-pressed',String(score===i+1));
      value.textContent=score===null?'Без оценки':decimalRating(score)+' / 10';
      save.disabled=score===null||saving;share.disabled=score===null||saving;
    }
    const save=button('Сохранить оценку',()=>submit(score),true);
    const clear=button('Снять оценку',()=>submit(null));
    async function submit(next){
      if(saving||!viewer||viewer.id!==ownerId||!modal.open||!content.isConnected)return;
      saving=true;draw();clear.disabled=true;for(const b of choices)b.disabled=true;
      status.textContent='Сохраняем…';
      let persisted=false;
      try{
        await api('/api/watch-history/'+item.id+'/rating',{method:'PUT',body:{userId:ownerId,score:next,shareWithPartners:next!==null&&share.checked}});
        persisted=true;
        if(viewer?.id!==ownerId||!content.isConnected)return;
        await renderProfile(content);
      }catch(error){
        if(content.isConnected&&viewer?.id===ownerId)status.textContent=persisted?'Оценка сохранена. Не удалось обновить историю.':historyRequestError(error);
      }finally{saving=false;draw();clear.disabled=false;for(const b of choices)b.disabled=false}
    }
    actions.append(button('Назад',back));
    if(item.rating?.score!=null)actions.append(clear);
    actions.append(save);
    content.append(value,scale,shareLabel,note,actions,status);
    draw();showModal('Оценка фильма',content);
    choices[(score??1)-1]?.focus();
  }

  function ratingSummaryBlock(summary,shared=false){
    const box=el('div',null,'rating-summary');
    box.setAttribute('aria-label',shared?'Совместные оценки':'Личные оценки');
    const rated=Number(summary?.rated)||0;
    box.append(el('span',shared?'Совместные оценки':'Оценки фильмов','rating-summary-label'));
    const values=el('div',null,'rating-summary-values');
    values.append(el('strong',rated?String(rated):'0'),el('span',shared?'— оценено обоими':'из '+(Number(summary?.films)||0)+' доступных для оценки'));
    if(rated&&summary.average!=null)values.append(el('strong',decimalRating(summary.average)+' / 10'),el('span','средняя оценка'));
    else values.append(el('span',shared?'Нет общих опубликованных оценок':'Пока нет оценок'));
    box.append(values);
    return box;
  }

  function sharedHistoryView(value,loadHistory,companion){
    const content=el('div',null,'history-list profile-history-details');
    const summary=el('div');if(value.pairRatingSummary)summary.append(ratingSummaryBlock(value.pairRatingSummary,true));
    const companionLink=companion?profileLink(companion,'Профиль · '+companion.nickname):null;
    if(companionLink)content.append(companionLink);
    content.append(summary,historyList(value.history,null,loadHistory,updated=>{
      summary.replaceChildren();if(updated.pairRatingSummary)summary.append(ratingSummaryBlock(updated.pairRatingSummary,true));
    }));
    return content;
  }

  function historyList(items,actions=null,load=null,onUpdate=null) {
    const list=el('div',null,'history-list');
    if(!items.length) list.append(empty('Пока нет просмотров.'));
    for(const item of items) {
      const row=el('div',null,'history-row');
      const info=el('div',null,'grow');
      const source={youtube:'YouTube',vk:'VK Видео',rutube:'Rutube',video:'MP4 / WebM'}[item.media_type];
      const state={running:'Идёт',interrupted:'Прерван',completed:'Завершён'}[item.status];
      const year=item.release_year?' ('+item.release_year+')':'';
      const title=el('strong',(displayMovieTitle(item)||'Без названия')+year);
      if(actions&&item.can_edit_cover){
        const label=item.poster_key?'Заменить обложку':'Добавить обложку';
        const edit=button('',()=>actions.edit(item));
        edit.classList.add('history-cover-edit');
        edit.setAttribute('aria-label',label);
        edit.title=label;
        edit.append(icon('edit'));
        const remove=button('',()=>actions.remove(item));
        remove.classList.add('history-cover-edit','history-delete-button');
        remove.setAttribute('aria-label','Удалить просмотр');
        remove.title='Удалить просмотр';
        remove.append(icon('trash'));
        const controls=el('div',null,'history-item-actions');
        controls.append(edit,remove);
        const heading=el('div',null,'history-movie-heading');
        heading.append(title,controls);
        info.append(heading);
      } else {
        info.append(title);
      }
      info.append(el('div',[source,item.started_at&&date(item.started_at),duration(item.credited_seconds),state].filter(Boolean).join(' · '),'muted'));
      if(item.ended_at) info.append(el('div','До '+date(item.ended_at),'muted'));
      if(item.participants?.length){
        const together=el('div','Смотрели вместе: '+item.participants.map(p=>p.nickname).join(', '),'history-companions');
        together.prepend(icon('people'));
        info.append(together);
      }
      if(actions?.rate&&item.canRate){
        const rate=button(ratingBadge(item),()=>actions.rate(item));rate.classList.add('rating-history-button');
        rate.setAttribute('aria-haspopup','dialog');info.append(rate);
      }else if(actions?.rate&&item.rating?.score!=null){
        info.append(el('span','Личная оценка: '+decimalRating(item.rating.score)+' / 10','rating-history-badge'));
      }
      if(item.pairRating){
        info.append(el('span','Вместе: '+decimalRating(item.pairRating.average)+' / 10 · Ты '+item.pairRating.own+' · Партнёр '+item.pairRating.partner,'rating-history-badge'));
      }
      row.append(historyPoster(item),info);
      list.append(row);
    }
    if(load)bindHistoryUpdates(list,items,load,(rows,value)=>{
      list.replaceChildren(...historyList(rows,actions).children);
      if(value)onUpdate?.(value);else onUpdate?.({});
    });
    return list;
  }

  function paginatedHistory(items,loadPage,actions,initial={}) {
    const content=el('div',null,'history-list profile-history-details');
    const filter=el('form',null,'history-filter');
    const search=el('input');search.className='field';search.type='search';search.maxLength=120;search.placeholder='По сохранённому названию';search.setAttribute('aria-label','Поиск фильма по сохранённому названию');
    const select=(label,choices)=>{
      const node=el('select');node.className='field';node.setAttribute('aria-label',label);
      for(const [key,caption] of choices){const opt=el('option',caption);opt.value=key;node.append(opt)}return node;
    };
    const status=select('Статус просмотра',[['all','Все сеансы'],['completed','Завершённые'],['interrupted','Прерванные'],['running','Текущие']]);
    const rated=actions?.rate?select('Наличие оценки',[['all','Все оценки'],['rated','Оценённые'],['unrated','Без оценки']]):null;
    const submit=el('button','Найти','btn primary');submit.type='submit';
    filter.append(search,status);if(rated)filter.append(rated);filter.append(submit);
    const result=el('div',null,'history-filter-results');const notice=el('p',null,'form-status');notice.setAttribute('role','status');
    content.append(filter,notice,result);
    let generation=0,busy=false;
    let current={q:initial.q||'',status:initial.status||'all',rated:initial.rated||'all'};
    search.value=current.q;status.value=current.status;if(rated)rated.value=current.rated;
    function draw(rows,filters){
      result.replaceChildren();let offset=rows.length;
      const appendPage=(page,start)=>result.append(historyList(page,actions,read=>loadPage(start,filters,read)));
      if(rows.length)appendPage(rows,0);else result.append(empty(filters.q||filters.rated!=='all'||filters.status!=='all'?'Нет просмотров по фильтрам.':'Пока нет просмотров.'));
      if(offset===50){
        const more=button('Показать ещё');
        more.onclick=async()=>{
          if(more.disabled)return;more.disabled=true;
          try{const {history}=await loadPage(offset,filters);
            if(!more.isConnected)return;
            if(history?.length){const start=offset;offset+=history.length;result.insertBefore(historyList(history,actions,read=>loadPage(start,filters,read)),more)}
            if(history?.length!==50)more.remove();
          }catch(error){if(more.isConnected)notice.textContent=historyRequestError(error)}
          finally{more.disabled=false}
        };result.append(more);
      }
    }
    async function apply(){
      const request=++generation;busy=true;submit.disabled=true;notice.textContent='Ищем…';
      const filters={q:search.value.trim(),status:status.value,rated:rated?.value||'all'};
      try{const data=await loadPage(0,filters);
        if(request!==generation||!content.isConnected)return;
        current=filters;draw(data.history||[],filters);notice.textContent='';
      }catch(error){if(request===generation&&content.isConnected)notice.textContent=historyRequestError(error)}
      finally{if(request===generation){busy=false;submit.disabled=false}}
    }
    filter.onsubmit=event=>{event.preventDefault();if(!busy)apply()};
    if(current.q||current.status!=='all'||current.rated!=='all')queueMicrotask(apply);
    else draw(items,current);
    return content;
  }

  function profileHistory(items,loadPage,options,reopen) {
    const section=el('section',null,'profile-section');
    const title=profileHeading('История просмотров');
    const header=el('div',null,'profile-history-heading');
    const back=()=>openProfileHistory?.();
    const actions=options?{
      edit:item=>coverEditor(item,options,back),
      remove:item=>confirmWatchDeletion(item,back),
      rate:item=>ratingEditor(item,back)
    }:null;
    const showHistory=(filters={})=>{
      showModal('История просмотров',paginatedHistory(items,loadPage,actions,filters));
    };
    openProfileHistory=showHistory;
    if(!items.length){
      section.append(title,empty('Пока нет просмотров.'));
      if(reopen)showHistory();
      return section;
    }
    const all=button('Все',showHistory);
    all.setAttribute('aria-haspopup','dialog');
    all.setAttribute('aria-label','Вся история просмотров');
    all.append(icon('chevron'));
    header.append(title,all);
    const gallery=el('div',null,'profile-history-gallery');
    function makeTile(item){
      const editable=options&&item.can_edit_cover;
      const label=displayMovieTitle(item)||'Обложка просмотра';
      const tile=editable?button('',()=>actions.edit(item)):el('div');
      tile.className='profile-history-tile';
      tile.append(historyPoster(item));
      const caption=el('div',null,'stage5-history-caption');
      caption.append(el('strong',label),el('span',duration(item.credited_seconds),'muted'));
      if(options&&item.rating?.score!=null)caption.append(el('span','Оценка '+decimalRating(item.rating.score)+' / 10','rating-history-badge'));
      tile.append(caption);
      if(editable){
        tile.setAttribute('aria-haspopup','dialog');
        tile.setAttribute('aria-label',(item.poster_key?'Изменить обложку: ':'Добавить обложку: ')+label);
      }else{
        tile.setAttribute('role','img');
        tile.setAttribute('aria-label',label);
      }
      return tile;
    }
    const draw=rows=>{
      items=rows;
      gallery.replaceChildren(...items.slice(0,4).map(makeTile));
    };
    draw(items);
    bindHistoryUpdates(gallery,items,read=>loadPage(0,{},read),draw);
    section.append(header,gallery);
    if(reopen)showHistory();
    return section;
  }

  const sendFriendRequest=id=>api('/api/friends/'+id,{method:'POST'});
  const answerFriendRequest=(id,response)=>api('/api/friends/'+id,{method:'PATCH',body:{action:response}});

  function friendRequestButton(data) {
    const pending=data.relationship==='outgoing';
    const incoming=data.relationship==='incoming';
    const label=pending?'Заявка отправлена':incoming?'Принять заявку':'Добавить в друзья';
    const control=action(label,()=>incoming?answerFriendRequest(data.person.id,'accept'):sendFriendRequest(data.person.id),renderProfile);
    control.classList.add('primary');
    control.disabled=pending||data.preview;
    control.prepend(icon('userPlus'));
    return control;
  }

  async function renderProfile(historyView=null) {
    const render=++profileRender;
    const id=profileId||viewer.id;
    const preview=options.get('view')==='friend';
    const friend=options.get('friend');
    const query=preview?'?view=friend'+(friend?'&friend='+encodeURIComponent(friend):''):'';
    const data=await api('/api/profiles/'+id+query);
    if(render!==profileRender || !viewer) return;
    const reopenHistory=historyView instanceof Element&&modal.open&&
      (detail.contains(historyView)||detail.querySelector('.profile-history-details'));
    const {person}=data;
    displayedProfile=data;
    if(data.self){viewer.theme=data.theme;viewer.themeKey=data.themeKey;}
    applyProfileTheme(data.theme);
    const isFriend=data.preview?!!data.previewFriend:data.relationship==='friend';
    const isHidden=data.profileHidden===true;
    document.title=person.nickname+' · REMEDIUM CINEMA';
    const profile=el('div',null,'profile-view');
    const card=panel(null,'profile-card');
    const atmosphere=el('div',null,'zero-atmosphere');
    atmosphere.setAttribute('aria-hidden','true');
    profile.append(card,atmosphere);
    const header=el('section');
    const hero=el('div',null,'profile-hero');
    const info=el('div',null,'profile-details');
    const name=el('h1',person.nickname);
    if(person.crown){
      const crown=el('span',null,'profile-crown');
      crown.setAttribute('role','img');
      crown.setAttribute('aria-label',person.crown==='queen'?'Корона Евы':'Корона владельца');
      crown.append(icon(person.crown));
      name.append(crown);
    }
    const heart=el('span',null,'profile-name-heart');
    heart.setAttribute('aria-hidden','true');
    heart.append(icon('heart'));
    name.append(heart);
    info.append(name,el('p','@'+person.login,'muted'));
    if(person.registeredAt) info.append(el('p','С '+new Date(person.registeredAt).toLocaleDateString('ru-RU',{dateStyle:'long'}),'muted'));
    if(Object.hasOwn(person,'online') || data.self){
      const connected=data.self ? socket?.connected : person.online;
      const presence=el('p',connected?'В сети':'Не в сети','connection-state');
      presence.classList.toggle('is-online',Boolean(connected));
      if(data.self)presence.id='ownProfilePresence';
      info.append(presence);
    }
    if(!data.self&&Number.isInteger(data.friendCount)){
      info.append(el('p','Друзья · '+data.friendCount,'muted'));
    }
    if(person.bio) info.append(el('p',person.bio));
    const avatarFrame=el('div',null,'profile-avatar-frame');
    fillProfileAvatar(avatarFrame,person,data.theme);
    hero.append(avatarFrame,info);
    header.append(hero);
    if(data.self){
      CinemaNav.setUser({...person,theme:data.theme,themeKey:data.themeKey});
      const tools=el('div',null,'profile-tools');
      const edit=button('',()=>settings(data));
      edit.className='profile-edit profile-edit-action';
      edit.setAttribute('aria-label','Редактировать профиль');
      edit.setAttribute('aria-haspopup','dialog');
      edit.title='Редактировать профиль';
      edit.append(icon('edit'));
      const theme=button('',()=>showThemePicker(data,theme));
      theme.className='profile-edit profile-theme-toggle';
      theme.setAttribute('aria-label','Выбор темы профиля');
      theme.setAttribute('aria-haspopup','dialog');
      theme.title='Выбор темы профиля';
      theme.append(icon('brush'));
      tools.append(edit,theme);
      // Keep historical theme tools; approved modes expose the same actions in one row.
      const friends=link('','/friends','profile-edit profile-friends-action');
      friends.title='Друзья';friends.setAttribute('aria-label','Друзья');
      friends.append(icon('people'));tools.append(friends);
      card.classList.add('own-profile-card');
      header.append(tools);
      const approvedActions=el('div',null,'profile-actions approved-own-actions');
      const editAction=button('Редактировать профиль',()=>settings(data));
      editAction.setAttribute('aria-haspopup','dialog');
      const friendsAction=link('Друзья','/friends','btn');
      friendsAction.prepend(icon('people'));
      approvedActions.append(editAction,friendsAction);
      header.append(approvedActions);
    } else {
      const buttons=el('div',null,'profile-actions');
      buttons.append(isFriend?messageButton(person,data.preview):friendRequestButton(data));
      if(isFriend){
        let friends=el('span','В друзьях','btn');
        if(!isHidden){
          friends=data.canSeeFriends?button('Друзья',async()=>{
            try{
              const params=data.preview?'?view=friend'+(data.previewFriend?'&friend='+encodeURIComponent(data.previewFriend):''):'';
              const {friends:people}=await api('/api/profiles/'+person.id+'/friends'+params);
              if(displayedProfile!==data || !viewer)return;
              const list=el('div',null,'person-list');
              list.append(...(people.length?people.map(p=>personRow(p)):[empty('Общих друзей пока нет.')]));
              showModal('Общие друзья',list);
            }catch(error){
              if(displayedProfile!==data || !viewer)return;
              if(error.status===401)failure(error);
              else showModal('Друзья',empty(error.message||'Список недоступен.'));
            }
          }):friends;
        }
        friends.classList.add('profile-friend-status');
        friends.prepend(icon('userPlus'));
        buttons.append(friends);
      }
      buttons.classList.toggle('single',buttons.childElementCount===1);
      header.append(buttons);
    }
    if(data.preview) header.append(link('Вернуться в свой профиль','/profile','btn preview-return'));
    card.append(header,profileBow('profile-card-bow'));
    if(isHidden){
      const notice=panel(null,'profile-card profile-locked');
      const copy=el('div');
      copy.append(el('h2','Этот пользователь скрыл свой профиль'),
        empty('Информация, история просмотров и активность недоступны для просмотра'));
      notice.append(icon('lock'),copy);
      profile.append(notice);
      document.body.classList.add('profile-page');
      main.replaceChildren(profile);
      return;
    }
    if(data.mutualFriends?.length){
      const mutual=el('section',null,'profile-section mutual-friends');
      const list=el('div',null,'person-list');
      list.append(...data.mutualFriends.map(p=>personRow(p)));
      mutual.append(el('h2','Общие друзья'),list);
      profile.append(mutual);
    }
    if(data.personalHidden){profile.append(empty('Личная статистика скрыта'));}
    else if(Object.keys(data.personal).length) {
      const personal=el('section',null,'profile-section');
      personal.append(profileHeading('Личная статистика'),profileStats(data.personal));
      if(data.self&&data.ratingSummary){
        const widget=el('div',null,'rating-widget');
        function draw(summary){
          widget.replaceChildren(ratingSummaryBlock(summary));
          if(summary.films>0){
            const open=button('Мои оценки',()=>openProfileHistory?.({rated:'rated'}));
            open.setAttribute('aria-haspopup','dialog');widget.append(open);
          }
        }
        draw(data.ratingSummary);
        let serial=0;
        widget.classList.add('live-watch-history');
        widget.addEventListener('watch-history-refresh',async event=>{
          const request=++serial;
          try{
            const fresh=await (event.detail?.read||api)(profileHistoryPath(id,query,0,{},true));
            if(request===serial&&widget.isConnected&&viewer?.id===id&&fresh.self&&fresh.ratingSummary)draw(fresh.ratingSummary);
          }catch{}
        });
        personal.append(widget);
      }
      profile.append(personal);
    }
    if(data.shared!==null){
      const shared=el('section',null,'profile-section profile-shared');
      shared.append(profileHeading('Совместная статистика'));
      if(!data.shared.length && !data.sharedTotal?.sessions)shared.append(empty('Пока нет совместных просмотров.'));
      for(const {person:companion,...metrics} of data.shared) {
        const ownHistory=data.self||data.preview;
        const partner=ownHistory?companion.id:person.id;
        const historyPath=ownHistory?'/api/profile/shared/':'/api/shared/';
        const loadHistory=(read=api)=>read(historyPath+partner+(data.preview?'?view=friend':''));
        const inspect=action('Совместные сеансы',loadHistory,value=>
          showModal('Совместные сеансы',sharedHistoryView(value,loadHistory,companion)));
        inspect.classList.add('profile-shared-history');
        inspect.setAttribute('aria-label','Совместные сеансы');
        inspect.replaceChildren(icon('chevron'));
        shared.append(personRow(companion,[inspect]));
        if(data.self)shared.append(profileStats(metrics,true));
      }
      if(data.sharedTotal?.sessions)shared.append(profileStats(data.sharedTotal,true));
      profile.append(shared);
    }
    if(data.historyHidden){profile.append(empty('История просмотров скрыта'));}
    else if(data.history!==null){
      const loadPage=(offset,filters={},read=api)=>read(profileHistoryPath(id,query,offset,filters,data.self));
      profile.append(profileHistory(data.history,loadPage,data.coverEditor,Boolean(reopenHistory)));
    }
    document.body.classList.add('profile-page');
    main.replaceChildren(profile);
    if(options.get('edit')==='1'&&data.self&&!modal.open) settings(data);
  }

  function form(label,groups,submit,done) {
    const node=el('form',null,'settings-form');
    node.append(...groups);
    const go=el('button',label,'btn primary');
    go.type='submit';
    const status=el('p',null,'form-status');
    status.setAttribute('role','status');
    node.append(go,status);
    node.onsubmit=async event=>{
      event.preventDefault();
      if(go.disabled)return;
      go.disabled=true;
      status.textContent='';
      try { const result=await submit(Object.fromEntries(new FormData(node))); await done?.(result); status.textContent='Сохранено.'; }
      catch(error){status.textContent=error.message}
      finally{go.disabled=false}
    };
    return node;
  }

  async function avatarImage(file) {
    if(file.size>25*1024*1024) throw new Error('Выбери фото размером до 25 МБ.');
    if(!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)){
      throw new Error('Выбери фото в формате JPEG, PNG, WebP или HEIC.');
    }
    const url=URL.createObjectURL(file);
    try{
      const image=new Image();
      image.src=url;
      try { await image.decode(); }
      catch { throw new Error('Не удалось открыть фото. Попробуй сохранить его как JPEG и выбери снова.'); }
      const side=Math.min(image.naturalWidth,image.naturalHeight);
      const canvas=el('canvas');
      canvas.width=canvas.height=512;
      const context=canvas.getContext('2d');
      if(!side || !context) throw new Error('Не удалось подготовить фото.');
      context.drawImage(image,(image.naturalWidth-side)/2,(image.naturalHeight-side)/2,side,side,0,0,512,512);
      const result=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.9));
      if(!result) throw new Error('Не удалось подготовить фото.');
      return result;
    }finally{
      URL.revokeObjectURL(url);
    }
  }

  function avatarSettings(data,redraw) {
    const box=el('div',null,'settings-section');
    const controls=el('div',null,'avatar-tools');
    const picker=el('label',data.person.avatar?'Выбрать новое фото':'Добавить фото','btn avatar-picker');
    const photo=el('input',null,'avatar-file');
    photo.type='file';
    photo.accept='image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif';
    photo.setAttribute('aria-label','Фото профиля');
    picker.append(photo);
    const filename=el('span',null,'avatar-name');
    const status=el('p',null,'form-status');
    status.setAttribute('role','status');
    const upload=button('Загрузить фото',async ()=>{
      const file=photo.files[0];
      if(!file) return;
      photo.disabled=upload.disabled=true;
      status.textContent='Загружаем фото…';
      try{
        const body=await avatarImage(file);
        await api('/api/profile/avatar',{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body});
        await redraw();
      }catch(error){
        status.textContent=error.message;
      }finally{
        photo.disabled=false;
        upload.disabled=!photo.files.length;
      }
    },true);
    upload.disabled=true;
    photo.onchange=()=>{
      upload.disabled=!photo.files.length;
      filename.textContent=photo.files[0]?.name||'';
      status.textContent='';
    };
    controls.append(picker,upload,filename);
    if(data.person.avatar) controls.append(action('Удалить фото',()=>api('/api/profile/avatar',{method:'DELETE'}),redraw));
    box.append(el('h3','Фото профиля'),controls,status);
    return box;
  }

  function settings(data) {
    const root=el('div',null,'profile-settings');
    const redraw=async()=>{await renderProfile();modal.close()};
    root.append(avatarSettings(data,redraw));
    root.append(form('Сохранить профиль',[
      field('Ник','nickname',{required:true,maxLength:40,value:data.person.nickname}).group,
      field('Описание','bio',{multiline:true,maxLength:240,value:data.person.bio}).group
    ],body=>api('/api/profile',{method:'PATCH',body}),redraw));
    const toggles={watchTime:'Время просмотра',films:'Количество фильмов',sessions:'Количество сеансов',
      shared:'Совместная статистика',registration:'Дата регистрации',history:'История просмотров',
      friends:'Общие друзья',presence:'Статус присутствия',hideStats:'Скрыть всю статистику',hideProfile:'Скрыть профиль целиком'};
    const inputs={};
    const controls=Object.entries(toggles).map(([key,label])=>{
      const row=el('label',label,'privacy-row');
      const input=el('input');
      input.type='checkbox';
      input.checked=!!data.privacy[key];
      inputs[key]=input;
      row.append(input);
      return row;
    });
    root.append(form('Сохранить приватность',[el('h3','Приватность'),...controls],()=>api('/api/profile/privacy',{
      method:'PATCH',body:Object.fromEntries(Object.entries(inputs).map(([key,input])=>[key,input.checked]))
    })),action('Посмотреть мой профиль глазами друга',()=>api('/api/profile/friend-preview'),({friends})=>{
      if(!friends.length){location.href='/profile?view=friend';return}
      const list=el('div',null,'person-list');
      for(const friend of friends) list.append(personRow(friend,[link('Посмотреть','/profile?view=friend&friend='+friend.id)]));
      showModal('Посмотреть глазами друга',list);
    }));
    root.append(form('Изменить пароль',[
      el('h3','Пароль'),field('Текущий пароль','currentPassword',{type:'password',autocomplete:'current-password',required:true}).group,
      field('Новый пароль','password',{type:'password',autocomplete:'new-password',required:true}).group,
      field('Подтверждение','confirmation',{type:'password',autocomplete:'new-password',required:true}).group
    ],body=>api('/api/auth/password',{method:'POST',body}),result=>{
      codesPanel(detail,result.recoveryCodes,()=>location.reload());
    }));
    root.append(form('Выпустить новые резервные коды',[
      field('Текущий пароль','password',{type:'password',autocomplete:'current-password',required:true}).group
    ],body=>api('/api/auth/recovery-codes',{method:'POST',body}),result=>{
      codesPanel(detail,result.recoveryCodes,()=>settings(data));
    }));
    root.append(action('Активные сеансы',()=>api('/api/auth/sessions'),({sessions})=>{
      const list=el('div',null,'person-list');
      for(const item of sessions){
        const row=el('div',null,'person-row');
        row.append(el('div',(item.current?'Текущий сеанс · ':'')+date(item.created_at)+' · '+(item.user_agent||'Браузер'),'grow'),
          action('Завершить',()=>api('/api/auth/sessions/'+item.id,{method:'DELETE'}),()=>item.current?location.reload():row.remove()));
        list.append(row);
      }
      showModal('Активные сеансы',list);
    }),link('Скачать мои данные','/api/export'),
    action('Выйти из аккаунта',()=>api('/api/auth/logout',{method:'POST'}),()=>{CinemaNav.setUser(null);location.href='/'}));
    showModal('Редактировать профиль',root);
  }

  function messageButton(person,preview=false) {
    const control=action('Сообщение',()=>api('/api/dialogs',{method:'POST',body:{userId:person.id}}),
      ({id})=>{location.href='/messages/'+id});
    control.classList.add('primary');
    control.disabled=preview;
    control.prepend(CinemaNav.messageIcon());
    return control;
  }

  async function renderFriends() {
    const generation=accountGeneration;
    const {people}=await api('/api/friends');
    if(generation!==accountGeneration || !viewer)return;
    const section=panel('Друзья','friends-panel');
    section.append(empty('Твой код друга: '+viewer.friendCode));
    const search=el('form',null,'inline-tools');
    search.method='get';
    const input=el('input',null,'field');
    input.placeholder='Логин или код друга';
    input.setAttribute('aria-label','Логин или код друга');
    const go=el('button','Найти','btn primary');go.type='submit';
    search.append(input,go);
    const results=el('div',null,'person-list');
    search.onsubmit=async event=>{
      event.preventDefault();
      go.disabled=true;
      try{
        const found=(await api('/api/people?q='+encodeURIComponent(input.value))).people;
        const labels={friend:'Уже в друзьях',incoming:'Входящая заявка',outgoing:'Заявка отправлена'};
        results.replaceChildren(...(found.length?found.map(p=>{
          const status=labels[p.relationship];
          const control=status?el('span',status,'muted'):action('Добавить в друзья',()=>sendFriendRequest(p.id),
            async ()=>{await renderFriends()});
          return personRow(p,[control]);
        }):[empty('Никого не нашли.')]));
      }catch(error){failure(error,results)}
      finally{go.disabled=false}
    };
    section.append(search,results);
    const list=panel('Список и заявки','friends-panel');
    const remove=id=>api('/api/friends/'+id,{method:'DELETE'});
    for(const p of people){
      const controls=[];
      if(p.relationship==='friend') controls.push(messageButton(p),
        action('В кинозал',()=>api('/api/friends/'+p.id+'/invite',{method:'POST'}),({id})=>{location.href='/messages/'+id}),
        action('Удалить',()=>remove(p.id),renderFriends));
      if(p.relationship==='incoming') controls.push(...[['Принять','accept'],['Отклонить','decline']].map(([label,a])=>
        action(label,()=>answerFriendRequest(p.id,a),renderFriends)));
      if(p.relationship==='outgoing') controls.push(el('span','Заявка отправлена','muted'),action('Отменить',()=>remove(p.id),renderFriends));
      list.append(personRow(p,controls));
    }
    if(!people.length) list.append(empty('Пока нет друзей и заявок.'));
    main.replaceChildren(section,list);
    friendRefresh=()=>renderFriends().catch(error=>{if(generation===accountGeneration)failure(error)});
  }

  async function renderMessages() {
    const generation=accountGeneration;
    const active=()=>generation===accountGeneration&&!!viewer;
    const id=segment[1];
    const layout=el('div',null,'social-panel dialogs-layout'+(id?' open':''));
    const left=panel('Сообщения','dialog-list');
    const search=el('input',null,'field');
    search.placeholder='Поиск по диалогам';
    search.setAttribute('aria-label','Поиск по диалогам');
    const list=el('div');
    left.append(search,list);
    const right=panel(null,'direct-room');
    layout.append(left,right);
    main.replaceChildren(layout);
    let dialogListRequest=0;
    async function dialogs() {
      const request=++dialogListRequest;
      const {dialogs}=await api('/api/dialogs?q='+encodeURIComponent(search.value));
      if(request!==dialogListRequest || !active()) return;
      list.replaceChildren();
      if(!dialogs.length) list.append(empty('Диалогов пока нет. Открой профиль друга, чтобы написать.'));
      for(const item of dialogs){
        const row=link('', '/messages/'+item.id,'dialog-row');
        if(item.id===id) row.setAttribute('aria-current','page');
        const desc=el('div',null,'grow');
        desc.append(el('strong',item.person.nickname),el('div',item.preview||'Открыть диалог','muted'));
        if(item.at) desc.append(el('time',date(item.at),'muted'));
        row.append(avatar(item.person),desc);
        if(item.unread) {
          const badge=el('span',null,'unread');
          CinemaNav.setUnreadBadge(badge,item.unread);
          row.append(badge);
        }
        list.append(row);
      }
    }
    refreshDialogList=()=>dialogs().catch(error=>{if(active())failure(error,list)});
    let searchTimer,readTimer,onVisibility;
    disposeMessageView=()=>{clearTimeout(searchTimer);clearTimeout(readTimer);if(onVisibility)document.removeEventListener('visibilitychange',onVisibility)};
    search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(active())dialogs().catch(error=>{if(active())failure(error,list)})},220)};
    await dialogs();
    if(!active())return;
    if(!id) {right.append(empty('Выбери диалог.'));directRefresh=()=>dialogs();return}
    const head=el('header',null,'direct-head');
    const stream=el('div',null,'direct-stream');
    stream.setAttribute('role','log');
    const composer=el('form',null,'direct-compose');
    composer.method='post';
    const input=el('textarea',null,'field');
    input.rows=1;
    input.maxLength=2000;
    input.placeholder='Написать сообщение…';
    input.setAttribute('aria-label','Сообщение');
    const submit=el('button',null,'btn direct-send');
    submit.type='submit';
    submit.setAttribute('aria-label','Отправить');
    submit.append(CinemaNav.messageIcon());
    composer.append(input,submit);
    const status=el('p',null,'form-status');
    status.setAttribute('role','status');
    right.append(head,stream,composer,status);
    const stored=new Map();
    let canSend=false,readByOther='0',more=false,initial=true,marking=false,sending=false,pendingId,markedThrough=0n;
    const order=(a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0;
    const nearBottom=()=>stream.scrollHeight-stream.scrollTop-stream.clientHeight<75;
    async function markRead(){
      if(!active()||!layout.isConnected)return;
      const last=latestStoredMessage(stored);
      if(!last || BigInt(last.id)<=markedThrough || marking || document.hidden || !nearBottom())return;
      marking=true;
      try {
        await api('/api/dialogs/'+id+'/read',{method:'POST',body:{through:last.id}});
        if(active())markedThrough=BigInt(last.id);
      }
      finally{marking=false}
      if(active()&&[...stored.keys()].some(messageId=>BigInt(messageId)>markedThrough)) await markRead();
    }
    function paint(scroll='keep'){
      if(!active()||!layout.isConnected)return;
      const position=stream.scrollTop, priorHeight=stream.scrollHeight;
      stream.replaceChildren();
      const ordered=[...stored.values()].sort(order);
      if(more&&ordered.length)stream.append(action('Ранее',()=>api('/api/dialogs/'+id+'/messages?before='+ordered[0].id),data=>{
        for(const m of data.messages)stored.set(m.id,m);
        more=data.more;
        paint('prepend');
      }));
      if(!ordered.length) stream.append(empty('Начало переписки.'));
      for(const m of ordered){
        const mine=m.senderId===viewer.id;
        const video=m.deleted||m.invite?null:sharedVideoUrl(m.body);
        const body=m.deleted?'Сообщение удалено':video?'Видео из кинозала':m.body;
        const bubble=el('article',body,'direct-bubble'+(mine?' mine':''));
        if(m.invite&&!m.deleted) bubble.append(el('br'),link('Открыть кинозал','/?room='+encodeURIComponent(m.invite.room)+'&invite='+encodeURIComponent(m.invite.code)));
        if(video){
          const open=link('Открыть видео · '+video.hostname,video.href);
          open.target='_blank';
          open.rel='noopener noreferrer';
          bubble.append(el('br'),open);
        }
        const meta=el('div',date(m.createdAt)+(mine&&BigInt(readByOther)>=BigInt(m.id)?' · Прочитано':''),'direct-meta');
        if(mine&&!m.deleted)meta.append(action('Удалить',()=>api('/api/dialogs/'+id+'/messages/'+m.id,{method:'DELETE'}),()=>{
          stored.set(m.id,{...m,deleted:true,body:'',invite:null});
          return refresh();
        }));
        bubble.append(meta);
        stream.append(bubble);
      }
      if(scroll==='bottom') stream.scrollTop=stream.scrollHeight;
      else if(scroll==='prepend') stream.scrollTop=position+stream.scrollHeight-priorHeight;
      else stream.scrollTop=position;
    }
    let messageRefresh=0;
    async function refresh(scroll=false){
      if(!active()||!layout.isConnected)return;
      const request=++messageRefresh;
      const stick=initial||scroll||nearBottom();
      const data=await api('/api/dialogs/'+id+'/messages');
      if(!active()||!layout.isConnected||request!==messageRefresh)return;
      if(initial){
        const title=el('div',null,'grow');
        title.append(profileLink(data.person),el('div','@'+data.person.login,'muted'));
        head.append(avatar(data.person),title,
          action('Скрыть',()=>api('/api/dialogs/'+id,{method:'DELETE'}),()=>{location.href='/messages'}));
        initial=false;
        more=data.more;
      }
      if(stored.size && data.more && !data.messages.some(m=>stored.has(m.id))) {
        stored.clear();
        more=true;
      }
      for(const m of data.messages)stored.set(m.id,m);
      canSend=data.canSend;
      readByOther=data.readByOther;
      input.disabled=!canSend;
      submit.disabled=!canSend||sending;
      input.placeholder=canSend?'Написать сообщение…':'Отправка доступна друзьям';
      paint(stick?'bottom':'keep');
      await markRead();
    }
    composer.onsubmit=async event=>{
      event.preventDefault();
      const body=input.value.trim();
      if(!active()||!layout.isConnected||!body||sending||!canSend)return;
      if(pendingId?.body!==body)pendingId={body,clientId:crypto.randomUUID()};
      sending=true;
      submit.disabled=true;
      status.textContent='';
      try{
        const result=await api('/api/dialogs/'+id+'/messages',{method:'POST',body:pendingId});
        if(!active()||!layout.isConnected)return;
        stored.set(result.message.id,result.message);
        if(input.value.trim()===body)input.value='';
        pendingId=null;
        paint('bottom');
      }catch(error){status.textContent=error.message}
      finally{sending=false;submit.disabled=!canSend}
    };
    stream.addEventListener('scroll',()=>{
      clearTimeout(readTimer);
      readTimer=setTimeout(()=>markRead().catch(()=>{}),140);
    },{passive:true});
    onVisibility=()=>{if(active()&&layout.isConnected)markRead().catch(()=>{})};
    document.addEventListener('visibilitychange',onVisibility);
    directRefresh=async event=>{
      if(!event||event.conversationId===id) {
        const removed=stored.get(event?.deletedId);
        if(removed) stored.set(removed.id,{...removed,deleted:true,body:'',invite:null});
        await refresh();
      }
      await dialogs();
    };
    friendRefresh=()=>refresh().catch(error=>{if(active())failure(error,right)});
    await refresh(true);
  }

  async function start(user) {
    const generation=++accountGeneration;
    profileRender++;
    reconnect?.suspend();
    const old=socket;socket=null;old?.disconnect();
    disposeMessageView?.();disposeMessageView=null;
    directRefresh=refreshDialogList=friendRefresh=null;
    displayedProfile=null;viewer=user;
    main.replaceChildren(empty('Загружаем…'));
    const onProfile=segment[0]==='profile';
    const current=io({autoConnect:false,auth:{accountId:user.id,...(onProfile?{historyProfile:segment[1]||user.id}:{})}});
    socket=current;
    const active=()=>socket===current && viewer?.id===user.id && accountGeneration===generation;
    reconnect=CinemaReconnect.create({
      socket:current,getAccount:()=>active()?viewer:null,verify:()=>api('/api/auth/me'),
      onInvalid:()=>{if(active())failure({status:401});},
      onChanged:()=>{if(active()){failure({status:401});location.reload();}}
    });
    CinemaNav.setUser(user,{invalidateOwner:onProfile});
    CinemaNav.show(true);
    CinemaNav.watchUnread(current);
    function refreshPresence(){
      if(!active())return;
      const status=document.getElementById('ownProfilePresence');
      if(!status)return;
      status.classList.toggle('is-online',current.connected);
      status.textContent=current.connected?'В сети':'Не в сети';
    }
    const handleError=error=>{if(active())failure(error)};
    current.on('connect',()=>{if(active()){reconnect.connected();refreshPresence();}});
    if(onProfile){
      current.on('watch-history-updated',event=>{if(active())refreshVisibleHistory(event.id)});
      current.on('film-rating-updated',()=>{if(active()&&displayedProfile?.self)refreshVisibleHistory()});
      current.on('connect',()=>{if(active())refreshVisibleHistory()});
    }
    current.on('disconnect',()=>{if(active()){refreshPresence();reconnect.schedule()}});
    current.on('connect_error',()=>{if(active())reconnect.schedule()});
    current.on('direct-update',event=>{if(active())directRefresh?.(event).catch(handleError)});
    current.on('direct-read',event=>{if(active())directRefresh?.(event).catch(handleError)});
    current.on('direct-unread',()=>{if(active())refreshDialogList?.()});
    current.on('friends-update',()=>{if(active())friendRefresh?.()});
    current.on('connect',()=>{if(active()&&directRefresh)directRefresh().catch(handleError)});
    current.connect();
    try {
      if(segment[0]==='friends') await renderFriends();
      else if(segment[0]==='messages') await renderMessages();
      else { profileId=segment[1]; await renderProfile(); }
    }catch(error){handleError(error)}
  }

  window.addEventListener('pagehide',()=>{disposeMessageView?.();disposeMessageView=null;reconnect?.suspend();socket?.disconnect()});
  window.addEventListener('pageshow',event=>{
    if(event.persisted){initAccount();}
  });
  async function initAccount(){
    CinemaAppearance.pending();
    const generation=++accountGeneration;
    try{
      const {user}=await RC.initialAccount();
      if(generation!==accountGeneration)return;
      if(user)await start(user);else failure({status:401});
    }catch(error){
      if(generation!==accountGeneration)return;
      if(error.status===401)failure(error);
      else {
        accountGeneration++;profileRender++;reconnect?.suspend();
        displayedProfile=null;viewer=null;const previous=socket;socket=null;previous?.disconnect();
        disposeMessageView?.();disposeMessageView=null;
      directRefresh=refreshDialogList=friendRefresh=null;
        CinemaNav.show(false);CinemaNav.clearUnread();
        document.body.classList.remove('profile-page');applyProfileTheme('none');
        main.replaceChildren(empty(error.message||'Связь недоступна.'),button('Повторить',initAccount));
      }
    }
  }
  main.append(empty('Загружаем…'));
  initAccount();
})();
