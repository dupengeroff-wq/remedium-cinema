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
  let friendRefresh;
  let profileId;

  const empty=text=>el('p',text,'social-note');
  function panel(title,cls='') {
    const node=el('section',null,('social-panel '+cls).trim());
    if(title) node.append(el('h2',title));
    return node;
  }
  function showModal(title,content) {
    detail.replaceChildren(el('h2',title),content);
    if(!modal.open) modal.showModal();
  }
  function failure(error,node=main) {
    if(error.status===401){
      socket?.disconnect();
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
    row.append(avatar(person),desc);
    if(tools.length) {
      const controls=el('div',null,'row-actions');
      controls.append(...tools);
      row.append(controls);
    }
    return row;
  }

  const statLabels={seconds:'Время просмотра',films:'Фильмы',sessions:'Сеансы',days:'Дни просмотра',
    last:'Последний просмотр',shared_count:'Совместные сеансы',first:'Первый просмотр'};
  function stats(values) {
    const grid=el('div',null,'stat-grid');
    for(const [key,value] of Object.entries(values)){
      if(!statLabels[key])continue;
      const card=el('div',null,'stat');
      const formatted=key==='seconds'?duration(value):['first','last'].includes(key)?date(value):String(value);
      card.append(el('strong',formatted),el('span',statLabels[key]));
      grid.append(card);
    }
    return grid;
  }

  function historyList(items) {
    const list=el('div',null,'history-list');
    if(!items.length) list.append(empty('Пока нет просмотров.'));
    for(const item of items) {
      const row=el('div',null,'history-row');
      const poster=el('div','✦','history-poster');
      if(/^posters\/[a-z0-9-]+\.webp$/i.test(item.poster_key||'')){
        const img=el('img');
        img.alt='';
        img.loading='lazy';
        img.src='/'+item.poster_key;
        img.onerror=()=>{poster.textContent='✦'};
        poster.replaceChildren(img);
      }
      const info=el('div',null,'grow');
      const source={youtube:'YouTube',vk:'VK Видео',video:'MP4 / WebM'}[item.media_type]||item.media_type;
      const state={running:'Идёт',interrupted:'Прерван',completed:'Завершён'}[item.status]||'';
      info.append(el('strong',item.movie_title),el('div',[source,date(item.started_at),duration(item.credited_seconds),state].filter(Boolean).join(' · '),'muted'));
      if(item.ended_at) info.append(el('div','До '+date(item.ended_at),'muted'));
      if(item.participants?.length) info.append(el('div','С '+item.participants.map(p=>p.nickname).join(', '),'muted'));
      row.append(poster,info);
      list.append(row);
    }
    return list;
  }

  async function openDialog(person,data) {
    try {
      const {id}=await api('/api/dialogs',{method:'POST',body:{userId:person.id}});
      location.href='/messages/'+id;
    }catch(error){
      const body=el('div');
      body.append(empty(error.message));
      if(error.status===403){
        if(data.relationship==='none') body.append(action('Отправить заявку',
          ()=>api('/api/friends/'+person.id,{method:'POST'}),()=>{body.replaceChildren(empty('Заявка отправлена.'))}));
        if(data.relationship==='incoming') body.append(action('Принять заявку',
          ()=>api('/api/friends/'+person.id,{method:'PATCH',body:{action:'accept'}}),()=>openDialog(person,{relationship:'friend'})));
      }
      showModal(person.nickname,body);
    }
  }

  async function renderProfile() {
    const id=profileId||viewer.id;
    const preview=options.get('view')==='friend';
    const friend=options.get('friend');
    const query=preview?'?view=friend'+(friend?'&friend='+encodeURIComponent(friend):''):'';
    const data=await api('/api/profiles/'+id+query);
    const {person}=data;
    document.title=person.nickname+' · REMEDIUM CINEMA';
    const header=panel();
    const hero=el('div',null,'profile-hero');
    const info=el('div',null,'profile-details');
    info.append(el('h1',person.nickname),el('p','@'+person.login+(person.role==='creator'?' · Создатель':''),'muted'));
    if(person.registeredAt) info.append(el('p','В кинотеатре с '+date(person.registeredAt),'muted'));
    if(Object.hasOwn(person,'online')) info.append(el('p',person.online?'● В сети':'Не в сети','muted'));
    if(person.bio) info.append(el('p',person.bio));
    hero.append(avatar(person,true),info);
    header.append(hero);
    const buttons=el('div',null,'profile-actions'+(data.canSeeFriends?'':' single'));
    if(data.self) buttons.append(button('Редактировать профиль',()=>settings(data),true));
    else if(data.preview){
      const simulated=button('Сообщение',null,true);
      simulated.disabled=true;
      buttons.append(simulated);
    } else buttons.append(button('Сообщение',()=>openDialog(person,data),true));
    if(data.canSeeFriends) buttons.append(data.self?link('Друзья','/friends'):action('Друзья',
      ()=>api('/api/profiles/'+person.id+'/friends'+query),({friends})=>{
        const list=el('div',null,'person-list');
        list.append(...(friends.length?friends.map(p=>personRow(p)):[empty('Пока нет друзей.')]));
        showModal('Друзья',list);
      }));
    header.append(buttons);
    if(data.preview) header.append(link('Вернуться в свой профиль','/profile'));
    const personal=data.personalHidden?panel('Личная статистика скрыта','compact'):panel('Личная статистика');
    if(!data.personalHidden) personal.append(stats(data.personal));
    main.replaceChildren(header,personal);
    if(data.shared!==null){
      const shared=panel('Совместная статистика');
      if(!data.shared.length) shared.append(empty('Пока нет совместных просмотров.'));
      for(const item of data.shared) {
        const partner=data.self?item.person.id:data.previewFriend||person.id;
        const row=personRow(item.person,[action('Совместные сеансы',()=>api('/api/shared/'+partner),value=>showModal('Совместные сеансы',historyList(value.history)))]);
        shared.append(row,stats(item));
      }
      main.append(shared);
    }
    const history=data.historyHidden?panel('История просмотров скрыта','compact'):panel('История просмотров');
    if(!data.historyHidden){
      history.append(historyList(data.history));
      let offset=data.history.length;
      if(offset===50){
        const more=button('Показать ещё');
        more.onclick=run(more,()=>api('/api/profiles/'+id+(query?query+'&':'?')+'offset='+offset),next=>{
          offset+=next.history?.length||0;
          if(next.history?.length) history.insertBefore(historyList(next.history),more);
          if((next.history?.length||0)<50) more.remove();
        });
        history.append(more);
      }
    }
    main.append(history);
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
  function settings(data) {
    const root=el('div');
    const redraw=async()=>{modal.close();await renderProfile()};
    root.append(form('Сохранить профиль',[
      field('Ник','nickname',{required:true,maxLength:40,value:data.person.nickname}).group,
      field('Описание','bio',{multiline:true,maxLength:240,value:data.person.bio}).group
    ],body=>api('/api/profile',{method:'PATCH',body}),redraw));
    const photo=el('input',null,'field');
    photo.type='file';
    photo.accept='image/jpeg,image/png,image/webp';
    photo.setAttribute('aria-label','Фото профиля');
    const photoBox=el('div',null,'settings-section');
    photoBox.append(el('h3','Фото профиля'),photo,action('Загрузить фото',async ()=>{
      const image=photo.files[0];
      if(!image) throw new Error('Выбери фото.');
      if(image.size>5*1024*1024) throw new Error('Максимальный размер фото — 5 МБ.');
      return api('/api/profile/avatar',{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:image});
    },redraw));
    if(data.person.avatar)photoBox.append(action('Удалить фото',()=>api('/api/profile/avatar',{method:'DELETE'}),redraw));
    root.append(photoBox);
    const toggles={watchTime:'Время просмотра',films:'Количество фильмов',sessions:'Количество сеансов',
      shared:'Совместная статистика',registration:'Дата регистрации',history:'История просмотров',
      friends:'Список друзей',presence:'Статус присутствия',hideStats:'Скрыть всю статистику'};
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

  async function renderFriends() {
    const {people}=await api('/api/friends');
    const section=panel('Друзья');
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
        results.replaceChildren(...(found.length?found.map(p=>personRow(p,[
          action('Добавить',()=>api('/api/friends/'+p.id,{method:'POST'}),({relationship})=>{
            results.replaceChildren(empty(relationship==='friend'?'Уже в друзьях.':relationship==='incoming'?'Входящая заявка уже есть.':'Заявка отправлена.'));
          })
        ])):[empty('Никого не нашли.')]));
      }catch(error){failure(error,results)}
      finally{go.disabled=false}
    };
    section.append(search,results);
    const list=panel('Список и заявки');
    const remove=id=>api('/api/friends/'+id,{method:'DELETE'});
    for(const p of people){
      const controls=[];
      if(p.relationship==='friend') controls.push(button('Сообщение',()=>openDialog(p,{relationship:'friend'})),
        action('В кинозал',()=>api('/api/friends/'+p.id+'/invite',{method:'POST'}),({id})=>{location.href='/messages/'+id}),
        action('Удалить',()=>remove(p.id),renderFriends));
      if(p.relationship==='incoming') controls.push(...[['Принять','accept'],['Отклонить','decline']].map(([label,a])=>
        action(label,()=>api('/api/friends/'+p.id,{method:'PATCH',body:{action:a}}),renderFriends)));
      if(p.relationship==='outgoing') controls.push(el('span','Заявка отправлена','muted'),action('Отменить',()=>remove(p.id),renderFriends));
      list.append(personRow(p,controls));
    }
    if(!people.length) list.append(empty('Пока нет друзей и заявок.'));
    main.replaceChildren(section,list);
    friendRefresh=()=>renderFriends().catch(failure);
  }

  async function renderMessages() {
    const id=segment[1];
    const layout=el('div',null,'dialogs-layout'+(id?' open':''));
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
    async function dialogs() {
      const {dialogs}=await api('/api/dialogs?q='+encodeURIComponent(search.value));
      list.replaceChildren();
      if(!dialogs.length) list.append(empty('Диалогов пока нет. Открой профиль друга, чтобы написать.'));
      for(const item of dialogs){
        const row=link('', '/messages/'+item.id,'dialog-row');
        const desc=el('div',null,'grow');
        desc.append(el('strong',item.person.nickname),el('div',item.preview||'Открыть диалог','muted'));
        if(item.at) desc.append(el('time',date(item.at),'muted'));
        row.append(avatar(item.person),desc);
        if(item.unread) row.append(el('span',item.unread,'unread'));
        list.append(row);
      }
    }
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
    input.placeholder='Сообщение';
    input.setAttribute('aria-label','Сообщение');
    const submit=el('button','Отправить','btn primary');
    submit.type='submit';
    composer.append(input,submit);
    const status=el('p',null,'form-status');
    status.setAttribute('role','status');
    right.append(head,stream,composer,status);
    const stored=new Map();
    let canSend=false,readByOther='0',more=false,initial=true,marking=false,sending=false,pendingId;
    const order=(a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0;
    const nearBottom=()=>stream.scrollHeight-stream.scrollTop-stream.clientHeight<75;
    async function markRead(){
      const last=[...stored.values()].sort(order).at(-1);
      if(!last || marking || document.hidden || !nearBottom())return;
      marking=true;
      try { await api('/api/dialogs/'+id+'/read',{method:'POST',body:{through:last.id}}); }
      finally{marking=false}
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
        const bubble=el('article',m.deleted?'Сообщение удалено':m.body,'direct-bubble'+(mine?' mine':''));
        if(m.invite&&!m.deleted) bubble.append(el('br'),link('Открыть кинозал','/?room='+encodeURIComponent(m.invite.room)+'&invite='+encodeURIComponent(m.invite.code)));
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
        head.append(link('←','/messages','btn mobile-back'),avatar(data.person),title,
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
      input.placeholder=canSend?'Сообщение':'Отправка доступна друзьям';
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
    socket=io();
    socket.on('direct-update',event=>{directRefresh?.(event).catch(error=>failure(error))});
    socket.on('direct-read',event=>{directRefresh?.(event).catch(error=>failure(error))});
    socket.on('friends-update',()=>friendRefresh?.());
    socket.on('connect',()=>{if(directRefresh)directRefresh().catch(error=>failure(error))});
    socket.on('disconnect',async reason=>{
      if(reason==='io server disconnect'){
        try { if(!(await api('/api/auth/me')).user) failure({status:401}); }catch {}
      }
    });
    try {
      if(segment[0]==='friends') await renderFriends();
      else if(segment[0]==='messages') await renderMessages();
      else { profileId=segment[1]; await renderProfile(); }
    }catch(error){failure(error)}
  }

  main.append(empty('Загружаем…'));
  api('/api/auth/me').then(({user})=>user?start(user):failure({status:401})).catch(error=>failure(error));
})();
