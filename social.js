(() => {
  const {el,button,link,field,api,date,duration,codesPanel}=RC;
  const main=document.getElementById('socialMain');
  const modal=document.getElementById('socialDialog');
  const detail=document.getElementById('socialDialogContent');
  const segment=location.pathname.split('/').filter(Boolean);
  const options=new URLSearchParams(location.search);
  let viewer;
  let socket;
  let directRefresh;
  let refreshDialogList;
  let friendRefresh;
  let profileId;

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
    clock:'M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
    film:'M4 8h16v12H4zM4 8l-1-4 16-2 1 6M8 3l2 4m3-4 2 4',
    calendar:'M4 6h16v15H4zM8 3v5m8-5v5M4 11h16',
    people:'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2',
    edit:'M14 5l5 5M4 20l1.1-5L16.5 3.6a2 2 0 0 1 2.8 0l1.1 1.1a2 2 0 0 1 0 2.8L9 19Z',
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
    detail.replaceChildren(el('h2',title),content);
    modal.scrollTop=0;
    if(!modal.open) modal.showModal();
  }
  function failure(error,node=main) {
    if(error.status===401){
      socket?.disconnect();
      document.body.classList.remove('profile-page');
      CinemaNav.show(false);
      CinemaNav.clearUnread();
      const form=panel('Войди в REMEDIUM CINEMA','social-auth');
      main.replaceChildren(form);
      RC.mount(form,start);
      return;
    }
    node.replaceChildren(empty(error.message||'Действие не удалось.'));
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
      image.alt='';
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
      img.loading='lazy';
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
    const title=field('Название фильма','title',{value:displayMovieTitle(item),maxLength:120,required:true});
    const searchForm=el('form',null,'history-cover-form');
    const search=el('button','Найти обложку','btn');
    search.type='submit';
    searchForm.append(title.group,search);
    const manualForm=el('form',null,'history-cover-form');
    const address=field('HTTPS-ссылка на обложку','poster',{
      type:'url',maxLength:1200,required:true,
      value:item.poster_key?.startsWith('https://')?item.poster_key:''
    });
    const saveManual=el('button','Сохранить обложку по ссылке','btn');
    saveManual.type='submit';
    manualForm.append(address.group,saveManual);
    const base='/api/watch-history/'+item.id;
    let saving=false;
    let searchVersion=0;

    async function save(values,control) {
      if(saving)return;
      saving=true;
      control.disabled=true;
      status.textContent='';
      try{
        await api(base+'/cover',{method:'PATCH',body:{revision:item.poster_revision??null,...values}});
        await renderProfile(modal.open&&editor.isConnected);
      }catch(error){
        status.textContent=error.message;
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
        ++searchVersion;
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
      const version=++searchVersion;
      search.disabled=true;
      status.textContent='Ищем обложки…';
      results.replaceChildren();
      const custom=personalCatalogCover(name);
      try {
        const {films}=await api(base+'/cover-search?title='+encodeURIComponent(name));
        if(version!==searchVersion||!editor.isConnected)return;
        const candidates=custom?[custom,...films.filter(film=>film.poster_key!==custom.poster_key)]:films;
        showFilms(candidates);
        status.textContent=candidates.length?'':options.searchAvailable
          ?'Обложки не найдены.'
          :'В каталоге сайта обложка не найдена. Можно указать ссылку вручную.';
      }catch(error){
        if(version===searchVersion){
          if(custom)showFilms([custom]);
          status.textContent=error.message;
        }
      }finally{
        search.disabled=false;
      }
    };
    manualForm.onsubmit=event=>{
      event.preventDefault();
      save({poster:address.input.value.trim(),title:title.input.value.trim()},saveManual);
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
    title.input.focus();
  }

  function historyList(items,editCover) {
    const list=el('div',null,'history-list');
    if(!items.length) list.append(empty('Пока нет просмотров.'));
    for(const item of items) {
      const row=el('div',null,'history-row');
      const info=el('div',null,'grow');
      const source={youtube:'YouTube',vk:'VK Видео',rutube:'Rutube',video:'MP4 / WebM'}[item.media_type];
      const state={running:'Идёт',interrupted:'Прерван',completed:'Завершён'}[item.status];
      const year=item.release_year?' ('+item.release_year+')':'';
      const title=el('strong',(displayMovieTitle(item)||'Без названия')+year);
      if(editCover&&item.can_edit_cover){
        const label=item.poster_key?'Заменить обложку':'Добавить обложку';
        const edit=button('',()=>editCover(item));
        edit.classList.add('history-cover-edit');
        edit.setAttribute('aria-label',label);
        edit.title=label;
        edit.append(icon('edit'));
        const heading=el('div',null,'history-movie-heading');
        heading.append(title,edit);
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
      row.append(historyPoster(item),info);
      list.append(row);
    }
    return list;
  }

  function paginatedHistory(items,loadPage,editCover) {
    const content=el('div',null,'history-list profile-history-details');
    content.append(historyList(items,editCover));
    let offset=items.length;
    if(offset===50){
      const more=button('Показать ещё');
      more.onclick=run(more,()=>loadPage(offset),({history})=>{
        if(history?.length){
          offset+=history.length;
          content.insertBefore(historyList(history,editCover),more);
        }
        if(history?.length!==50)more.remove();
      });
      content.append(more);
    }
    return content;
  }

  function profileHistory(items,loadPage,options,reopen) {
    const section=el('section',null,'profile-section');
    const title=el('h2','История просмотров');
    if(!items.length){
      section.append(title,paginatedHistory(items,loadPage));
      return section;
    }
    const header=el('div',null,'profile-history-heading');
    let historyContent;
    const showHistory=()=>{
      historyContent??=paginatedHistory(items,loadPage,options?item=>coverEditor(item,options,showHistory):null);
      showModal('История просмотров',historyContent);
    };
    const all=button('Все',showHistory);
    all.setAttribute('aria-haspopup','dialog');
    all.setAttribute('aria-label','Вся история просмотров');
    all.append(icon('chevron'));
    header.append(title,all);
    const gallery=el('div',null,'profile-history-gallery');
    for(const item of items.slice(0,4)){
      const editable=options&&item.can_edit_cover;
      const label=displayMovieTitle(item)||'Обложка просмотра';
      const tile=editable?button('',()=>coverEditor(item,options,showHistory)):el('div');
      tile.className='profile-history-tile';
      tile.append(historyPoster(item));
      if(editable){
        tile.setAttribute('aria-haspopup','dialog');
        tile.setAttribute('aria-label',(item.poster_key?'Изменить обложку: ':'Добавить обложку: ')+label);
      }else{
        tile.setAttribute('role','img');
        tile.setAttribute('aria-label',label);
      }
      gallery.append(tile);
    }
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

  async function renderProfile(reopenHistory=false) {
    const id=profileId||viewer.id;
    const preview=options.get('view')==='friend';
    const friend=options.get('friend');
    const query=preview?'?view=friend'+(friend?'&friend='+encodeURIComponent(friend):''):'';
    const data=await api('/api/profiles/'+id+query);
    const {person}=data;
    const isFriend=data.preview?!!data.previewFriend:data.relationship==='friend';
    const isHidden=data.profileHidden===true;
    document.title=person.nickname+' · REMEDIUM CINEMA';
    const profile=el('div',null,'profile-view');
    const card=panel(null,'profile-card');
    profile.append(card);
    const header=el('section');
    const hero=el('div',null,'profile-hero');
    const info=el('div',null,'profile-details');
    const name=el('h1',person.nickname);
    if(person.role==='creator'){
      const crown=el('span','♛','profile-crown');
      crown.setAttribute('aria-label','Создатель');
      name.append(crown);
    }
    info.append(name,el('p','@'+person.login,'muted'));
    if(person.registeredAt) info.append(el('p','С '+new Date(person.registeredAt).toLocaleDateString('ru-RU',{dateStyle:'long'}),'muted'));
    if(Object.hasOwn(person,'online') || data.self){
      const connected=data.self ? socket?.connected : person.online;
      const presence=el('p',connected?'В сети':'Не в сети','connection-state');
      presence.classList.toggle('is-online',Boolean(connected));
      if(data.self)presence.id='ownProfilePresence';
      info.append(presence);
    }
    if(Number.isInteger(data.friendCount))info.append(el('p','Друзья · '+data.friendCount,'muted'));
    if(person.bio) info.append(el('p',person.bio));
    hero.append(avatar(person,true),info);
    header.append(hero);
    if(data.self){
      CinemaNav.setUser(person);
      const edit=button('',()=>settings(data));
      edit.className='profile-edit';
      edit.setAttribute('aria-label','Редактировать профиль');
      edit.setAttribute('aria-haspopup','dialog');
      edit.title='Редактировать профиль';
      edit.append(icon('edit'));
      card.classList.add('own-profile-card');
      header.append(edit);
    } else {
      const buttons=el('div',null,'profile-actions');
      buttons.append(isFriend?messageButton(person,data.preview):friendRequestButton(data));
      if(isFriend){
        let friends=el('span','Друзья','btn');
        if(!isHidden){
          friends=data.canSeeFriends?button('Друзья',()=>{
            const list=el('div',null,'person-list');
            list.append(...(data.mutualFriends?.length?data.mutualFriends.map(p=>personRow(p)):[empty('Общих друзей пока нет.')]));
            showModal('Общие друзья',list);
          }):link('Друзья','/friends');
        }
        friends.classList.add('profile-friend-status');
        friends.prepend(icon('userPlus'));
        buttons.append(friends);
      }
      buttons.classList.toggle('single',buttons.childElementCount===1);
      header.append(buttons);
    }
    if(data.preview) header.append(link('Вернуться в свой профиль','/profile','btn preview-return'));
    card.append(header);
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
    if(!data.personalHidden && Object.keys(data.personal).length) {
      const personal=el('section',null,'profile-section');
      personal.append(el('h2','Личная статистика'),profileStats(data.personal));
      profile.append(personal);
    }
    if(data.shared!==null){
      const shared=el('section',null,'profile-section profile-shared');
      shared.append(el('h2','Совместная статистика'));
      if(!data.shared.length && !data.sharedTotal?.sessions)shared.append(empty('Пока нет совместных просмотров.'));
      for(const {person:companion,...metrics} of data.shared) {
        const ownHistory=data.self||data.preview;
        const partner=ownHistory?companion.id:person.id;
        const historyPath=ownHistory?'/api/profile/shared/':'/api/shared/';
        const inspect=action('Совместные сеансы',()=>api(historyPath+partner),value=>showModal('Совместные сеансы',historyList(value.history)));
        inspect.classList.add('profile-shared-history');
        inspect.setAttribute('aria-label','Совместные сеансы');
        inspect.replaceChildren(icon('chevron'));
        shared.append(personRow(companion,[inspect]));
        if(data.self)shared.append(profileStats(metrics,true));
      }
      if(data.sharedTotal?.sessions)shared.append(profileStats(data.sharedTotal,true));
      profile.append(shared);
    }
    if(!data.historyHidden && data.history!==null){
      const loadPage=offset=>api('/api/profiles/'+id+(query?query+'&':'?')+'offset='+offset);
      profile.append(profileHistory(data.history,loadPage,data.coverEditor,reopenHistory===true));
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
    action('Выйти из аккаунта',()=>api('/api/auth/logout',{method:'POST'}),()=>{location.href='/'}));
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
    const {people}=await api('/api/friends');
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
    friendRefresh=()=>renderFriends().catch(failure);
  }

  async function renderMessages() {
    const id=segment[1];
    const layout=el('div',null,'social-panel dialogs-layout'+(id?' open':''));
    const left=panel('Сообщения','dialog-list');
    const search=el('input',null,'field');
    search.placeholder='Поиск по диалогам';
    search.setAttribute('aria-label','Поиск по диалогам');
    const list=el('div');
    left.append(search,list);
    const right=panel(null,'direct-room');
    if(id && window.visualViewport) {
      const resize=()=>{
        if(window.visualViewport.scale===1) {
          right.style.setProperty('--chat-viewport',window.visualViewport.height+'px');
        }
      };
      window.visualViewport.addEventListener('resize',resize,{passive:true});
      resize();
    }
    layout.append(left,right);
    main.replaceChildren(layout);
    let dialogListRequest=0;
    async function dialogs() {
      const request=++dialogListRequest;
      const {dialogs}=await api('/api/dialogs?q='+encodeURIComponent(search.value));
      if(request!==dialogListRequest) return;
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
    refreshDialogList=()=>dialogs().catch(error=>failure(error,list));
    let searchTimer;
    search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>dialogs().catch(error=>failure(error,list)),220)};
    await dialogs();
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
      const last=[...stored.values()].sort(order).at(-1);
      if(!last || BigInt(last.id)<=markedThrough || marking || document.hidden || !nearBottom())return;
      marking=true;
      try {
        await api('/api/dialogs/'+id+'/read',{method:'POST',body:{through:last.id}});
        markedThrough=BigInt(last.id);
      }
      finally{marking=false}
      if([...stored.keys()].some(messageId=>BigInt(messageId)>markedThrough)) await markRead();
    }
    function paint(scroll='keep'){
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
    async function refresh(scroll=false){
      const stick=initial||scroll||nearBottom();
      const data=await api('/api/dialogs/'+id+'/messages');
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
      if(!body||sending||!canSend)return;
      if(pendingId?.body!==body)pendingId={body,clientId:crypto.randomUUID()};
      sending=true;
      submit.disabled=true;
      status.textContent='';
      try{
        const result=await api('/api/dialogs/'+id+'/messages',{method:'POST',body:pendingId});
        stored.set(result.message.id,result.message);
        if(input.value.trim()===body)input.value='';
        pendingId=null;
        paint('bottom');
      }catch(error){status.textContent=error.message}
      finally{sending=false;submit.disabled=!canSend}
    };
    let readTimer;
    stream.addEventListener('scroll',()=>{
      clearTimeout(readTimer);
      readTimer=setTimeout(()=>markRead().catch(()=>{}),140);
    },{passive:true});
    document.addEventListener('visibilitychange',()=>markRead().catch(()=>{}));
    directRefresh=async event=>{
      if(!event||event.conversationId===id) {
        const removed=stored.get(event?.deletedId);
        if(removed) stored.set(removed.id,{...removed,deleted:true,body:'',invite:null});
        await refresh();
      }
      await dialogs();
    };
    friendRefresh=()=>refresh().catch(error=>failure(error,right));
    await refresh(true);
  }

  async function start(user) {
    viewer=user;
    socket?.disconnect();
    socket=io({autoConnect:false});
    CinemaNav.setUser(user);
    CinemaNav.show(true);
    CinemaNav.watchUnread(socket);
    function refreshPresence(){
      const status=document.getElementById('ownProfilePresence');
      if(!status)return;
      status.classList.toggle('is-online',socket.connected);
      status.textContent=socket.connected?'В сети':'Не в сети';
    }
    socket.on('connect',refreshPresence);
    socket.on('disconnect',refreshPresence);
    socket.on('direct-update',event=>{directRefresh?.(event).catch(error=>failure(error))});
    socket.on('direct-read',event=>{directRefresh?.(event).catch(error=>failure(error))});
    socket.on('direct-unread',()=>refreshDialogList?.());
    socket.on('friends-update',()=>friendRefresh?.());
    socket.on('connect',()=>{if(directRefresh)directRefresh().catch(error=>failure(error))});
    socket.on('disconnect',async reason=>{
      if(reason==='io server disconnect'){
        try { if(!(await api('/api/auth/me')).user) failure({status:401}); }catch {}
      }
    });
    socket.connect();
    try {
      if(segment[0]==='friends') await renderFriends();
      else if(segment[0]==='messages') await renderMessages();
      else { profileId=segment[1]; await renderProfile(); }
    }catch(error){failure(error)}
  }

  main.append(empty('Загружаем…'));
  api('/api/auth/me').then(({user})=>user?start(user):failure({status:401})).catch(error=>failure(error));
})();
