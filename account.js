(() => {
  const el=(tag,content,cls)=>{
    const node=document.createElement(tag);
    if(content!=null) node.textContent=content;
    if(cls) node.className=cls;
    return node;
  };
  function button(label,fn,primary=false) {
    const node=el('button',label,'btn'+(primary?' primary':''));
    node.type='button';
    node.onclick=fn;
    return node;
  }
  function link(label,href,cls='btn') {
    const node=el('a',label,cls);
    node.href=href;
    return node;
  }
  function field(label,name,options={}) {
    const group=el('label',null,'account-field');
    group.append(el('span',label));
    const input=el(options.multiline?'textarea':'input',null,'field');
    input.name=name;
    Object.assign(input,options);
    group.append(input);
    return {group,input};
  }
  async function api(url,options={}) {
    const headers=new Headers(options.headers||{});
    let body=options.body;
    if(body!=null && !(body instanceof Blob)) {
      headers.set('Content-Type','application/json');
      body=JSON.stringify(body);
    }
    const response=await fetch(url,{...options,body,headers,credentials:'same-origin',cache:'no-store',signal:options.signal||AbortSignal.timeout(16000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) {
      const error=new Error(data.error||'Сервер не ответил. Попробуй снова.');
      error.status=response.status;
      throw error;
    }
    return data;
  }
  const date=value=>value?new Date(value).toLocaleString('ru-RU',{dateStyle:'medium',timeStyle:'short'}):'—';
  const duration=value=>{
    const seconds=Math.max(0,Number(value)||0);
    const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
    return [hours?hours+' ч':'',minutes?minutes+' мин':'',seconds%60?seconds%60+' с':''].filter(Boolean).join(' ')||'0 с';
  };
  const strokes = {
    user:'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2z M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
    add:'M13 14H9a6 6 0 0 0-6 6 M14 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M18 13v8m-4-4h8',
    team:'M15 20H2a6 6 0 0 1 6-6h1a6 6 0 0 1 6 6z M12 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z M16 4a3.5 3.5 0 0 1 0 7m1 3a6 6 0 0 1 5 6',
    key:'M14 12a5 5 0 1 0-3-3l-8 8v4h4v-3h3z',
    lock:'M5 10h14v11H5z M8 10V7a4 4 0 1 1 8 0v3 M12 14v3',
    shield:'M12 2 3 6v6c0 5 4 8 9 10 5-2 9-5 9-10V6z m-4 10 3 3 5-6',
    eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    closed:'M3 3l18 18 M5 7c-2 2-3 5-3 5s4 7 10 7c2 0 4-.7 5-1.5 M10 5c7-1 12 7 12 7s-.6 1.5-2 3',
    copy:'M8 8h12v13H8z M5 16H3V3h12v2',
    download:'M12 2v13m-5-5 5 5 5-5 M3 15v6h18v-6',
    refresh:'M3 10a9 9 0 0 1 16-5l2 3m0-6v6h-6 M21 14a9 9 0 0 1-16 5l-2-3m0 6v-6h6',
    info:'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z M12 11v6m0-10v.2',
    play:'M5 3l15 9-15 9z', chat:'M21 11c0 5-4 8-9 8l-7 2 1-4a8 8 0 0 1-3-6c0-4 4-8 9-8s9 4 9 8z'
  };
  function icon(name) {
    if(name==='at') {
      const at=el('span','@','auth-icon');
      at.setAttribute('aria-hidden','true');
      return at;
    }
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('class','auth-icon');
    svg.setAttribute('viewBox','0 0 24 24');
    svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(svg.namespaceURI,'path');
    for(const [attr,value] of Object.entries({d:strokes[name],fill:'none',stroke:'currentColor','stroke-width':'1.55','stroke-linecap':'round','stroke-linejoin':'round'})) path.setAttribute(attr,value);
    svg.append(path);
    return svg;
  }
  function codesPanel(target,codes,done) {
    const text=codes.join('\n');
    const message=el('p',null,'form-status');
    message.setAttribute('role','status');
    async function copy(){
      try { await navigator.clipboard.writeText(text); message.textContent='Все коды скопированы.'; }
      catch { message.textContent='Не удалось скопировать. Выделите коды вручную или скачайте файл.'; }
    }
    const block=el('div',null,'auth-code-box');
    const quick=button('',copy);
    quick.setAttribute('aria-label','Копировать все резервные коды');
    quick.append(icon('copy'));
    block.append(el('pre',text,'recovery-list'),quick);
    const download=button('Скачать коды',()=>{
      const url=URL.createObjectURL(new Blob([text+'\n'],{type:'text/plain;charset=utf-8'}));
      const a=link('',url,'');
      a.download='remedium-recovery-codes.txt';
      a.click();
      setTimeout(()=>URL.revokeObjectURL(url),5000);
    });
    download.prepend(icon('download'));
    target.replaceChildren(el('h3','Резервные коды'),el('p','Сохраните их в надёжном месте. Каждый код работает один раз.'),
      block,button('Скопировать все коды',copy),download,button('Продолжить →',done),message);
  }
  const screens={login:'Вход',register:'Регистрация',recover:'Восстановление'};
  const guides={
    register:['Подсказки для регистрации',[
      ['at','Логин','От 3 до 40 символов. Можно использовать буквы, цифры, точку, дефис и подчёркивание.'],
      ['user','Ник','Ваше отображаемое имя на сайте. Его будут видеть другие пользователи.'],
      ['lock','Пароль','От 12 до 128 символов. Используйте длинный уникальный пароль.'],
      ['shield','Подтверждение пароля','Повторите пароль, чтобы избежать ошибки при вводе.']]],
    codes:['Резервные коды',[
      ['download','Сохраните коды','Храните их в надёжном месте.'],
      ['key','Один код — одно использование','Каждый код можно применить только один раз.'],
      ['shield','Для чего они нужны?','Помогут восстановить доступ к аккаунту.']]],
    recover:['Восстановление доступа',[
      ['at','Логин','Укажите логин вашего аккаунта.'],['key','Резервный код','Введите один из сохранённых резервных кодов.'],
      ['lock','Новый пароль','Придумайте новый пароль и подтвердите его.']]]
  };
  function renderGuide(side,mode){
    side.replaceChildren();
    if(mode==='login'){
      side.append(el('small','UNIVERSE FOR TWO'),el('h1','Ближе, чем звёзды.'),el('p','Один космос. Два сердца. Ваш собственный кинозал. ✦'));
      const perks=el('div',null,'auth-perks');
      for(const [name,label] of [['play','Совместный просмотр'],['chat','Общий чат'],['team','Друзья и атмосфера']]){
        const item=el('span'); item.append(icon(name),el('span',label)); perks.append(item);
      }
      side.append(perks);
    }else{
      const [title,hints]=guides[mode];
      side.append(el('h2',title));
      const list=el('dl');
      for(const [name,title,copy] of hints){
        const row=el('div'),term=el('dt',title);
        row.append(icon(name),term,el('dd',copy));list.append(row);
      }
      side.append(list);
    }
  }
  function authInput(form,label,name,symbol,options){
    const row=el('div',null,'auth-input');
    const input=el('input');
    Object.assign(input,{name,placeholder:label,required:true,...options});
    input.setAttribute('aria-label',label);
    if(['login','code'].includes(name)){input.autocapitalize='off';input.spellcheck=false}
    row.append(icon(symbol),input);
    if(input.type==='password'){
      const toggle=button('',()=>{
        const visible=input.type==='password';
        input.type=visible?'text':'password';
        toggle.replaceChildren(icon(visible?'eye':'closed'));
        toggle.setAttribute('aria-pressed',String(visible));
      });
      toggle.setAttribute('aria-label','Показать пароль — '+label);
      toggle.setAttribute('aria-pressed','false');
      toggle.append(icon('closed'));
      row.append(toggle);
    }
    form.append(row);
    return input;
  }
  function mount(target,onLogin) {
    document.querySelector('.auth-universe')?.remove();
    const screen=el('dialog',null,'auth-universe');
    screen.setAttribute('aria-labelledby','auth-title');
    const anchor=el("span");
    anchor.hidden=true;
    target.replaceChildren(anchor);
    document.body.append(screen);
    const sky=el('div',null,'auth-sky');
    sky.setAttribute('aria-hidden','true');
    for(const layer of ['stars one','stars two','stars three','moon','clouds','water','meteor']) sky.append(el('i',null,'auth-'+layer));
    const bar=el('div',null,'auth-top'),dots=button('•••',()=>setMenu(menu.hidden));
    dots.setAttribute('aria-label','Меню авторизации');
    const menu=el('nav',null,'auth-menu');menu.id='auth-menu';dots.setAttribute('aria-controls',menu.id);
    const wrapper=el('div',null,'auth-layout'),side=el('aside',null,'auth-guide'),card=el('section',null,'auth-panel');
    bar.append(el('strong','✦ REMEDIUM CINEMA'),dots,menu);
    wrapper.append(side,card); screen.append(sky,bar,wrapper);
    const about=el('dialog',null,'auth-about');
    const aboutTitle=el('h2','О проекте');
    aboutTitle.id='auth-about-title';
    about.setAttribute('aria-labelledby',aboutTitle.id);
    about.append(aboutTitle,
      el('p','У двоих, которые любят друг друга, есть своя маленькая вселенная. В ней даже поздней ночью кто-то шепчет «ты ещё здесь?» и улыбается, услышав в ответ «я с тобой».'),
      el('p','Эта вселенная принадлежит им двоим. Здесь всегда найдутся ещё пять минут перед тем, как сказать друг другу «спокойной ночи».'),
      button('Закрыть',()=>about.close()));
    screen.append(about);
    let mode='login', loginValue='', busy=false, issued=null;
    const motion=matchMedia('(prefers-reduced-motion: reduce)');
    let meteorTimer;
    function schedule(){
      clearTimeout(meteorTimer);
      if(!screen.isConnected||motion.matches||document.hidden)return;
      meteorTimer=setTimeout(()=>{
        const meteor=sky.lastElementChild;
        meteor.style.left=(18+Math.random()*55)+'%';
        meteor.style.top=(5+Math.random()*17)+'%';
        meteor.animate([{opacity:0,transform:'translate(0,0) rotate(-32deg)'},{opacity:.72,offset:.22},{opacity:0,transform:'translate(-140px,90px) rotate(-32deg)'}],850);
        schedule();
      },20000+Math.random()*25000);
    }
    const life=new AbortController();
    const observer=new MutationObserver(()=>{if(!anchor.isConnected||!screen.isConnected){screen.remove();clearTimeout(meteorTimer);life.abort();observer.disconnect()}});
    observer.observe(document.body,{subtree:true,childList:true});
    document.addEventListener('visibilitychange',schedule,{signal:life.signal});
    motion.addEventListener('change',schedule,{signal:life.signal});
    function setMenu(open){menu.hidden=!open;dots.setAttribute('aria-expanded',String(open))}
    setMenu(false);
    for(const [id,label] of [...Object.entries(screens),['about','О проекте']]){
      const item=button(label,()=>{
        setMenu(false);dots.focus();
        if(id==='about') about.showModal();else select(id);
      });
      item.prepend(icon({login:'user',register:'add',recover:'refresh',about:'info'}[id]));
      menu.append(item);
    }
    screen.addEventListener('click',e=>{if(!menu.contains(e.target)&&!dots.contains(e.target))setMenu(false)});
    screen.addEventListener('cancel',e=>{if(e.target===screen){e.preventDefault();setMenu(false);dots.focus()}});
    function select(id){
      if(busy||mode===id)return;
      loginValue=card.querySelector('[name=login]')?.value??loginValue;
      if(issued && !confirm('Коды сохранены? При выходе с этого экрана их больше нельзя будет посмотреть.'))return;
      issued=null;mode=id;draw();
    }
    function finish(user){ screen.close();screen.remove();onLogin(user) }
    function draw(){
      renderGuide(side,mode);
      screen.dataset.mode=mode;
      const title=el('h2',mode==='register'?'Создайте аккаунт ♡':'Добро пожаловать во Вселенную ♡');
      title.id='auth-title';
      card.replaceChildren(el('small','✦ REMEDIUM CINEMA'),title);
      if(mode==='codes'){
        const box=el('div',null,'auth-codes');card.append(box);
        codesPanel(box,issued.recoveryCodes,()=>finish(issued.user));return;
      }
      if(mode==='register')card.append(el('p','Присоединяйтесь к своему кинозалу во Вселенной'));
      const tabs=el('div',null,'auth-tabs');
      for(const [id,label] of Object.entries(screens)){
        const tab=button(label,()=>select(id));tab.setAttribute('aria-pressed',String(mode===id));tabs.append(tab);
      }
      const form=el('form',null,'auth-form');form.method='post';
      const login=authInput(form,'Введите логин','login','at',{autocomplete:'username',maxLength:80,value:loginValue});
      if(mode==='register')authInput(form,'Введите ник','nickname','user',{autocomplete:'nickname',maxLength:40});
      if(mode==='recover')authInput(form,'Введите резервный код','code','key',{autocomplete:'off',maxLength:40});
      const passwordOptions={type:'password',autocomplete:mode==='login'?'current-password':'new-password',minLength:mode==='login'?1:12,maxLength:128};
      authInput(form,mode==='recover'?'Введите новый пароль':'Введите пароль','password','lock',passwordOptions);
      if(mode!=='login')authInput(form,mode==='recover'?'Подтвердите новый пароль':'Подтвердите пароль','confirmation','lock',passwordOptions);
      if(mode==='register'){
        const detail=el('details',null,'auth-owner');detail.append(el('summary','Есть код создателя?'));
        authInput(detail,'Код создателя','creatorCode','key',{type:'password',autocomplete:'off',required:false,maxLength:256});
        form.append(detail);
      }
      const submit=el('button',({login:'Войти',register:'Создать аккаунт',recover:'Сменить пароль'})[mode]+' →','btn auth-submit');
      submit.type='submit';
      const status=el('p',null,'form-status');status.setAttribute('role','status');
      form.append(submit,status);card.append(tabs,form);
      form.onsubmit=async event=>{
        event.preventDefault();
        if(busy)return;
        busy=true;submit.disabled=true;
        status.textContent='Подключаемся…';
        try{
          const data=await api('/api/auth/'+mode,{method:'POST',body:Object.fromEntries(new FormData(form))});
          if(!screen.isConnected)return;
          if(mode==='recover'){
            loginValue=login.value;mode='login';draw();
            card.querySelector('.form-status').textContent='Пароль изменён. Войди с новым паролем.';
          }else if(data.recoveryCodes){
            form.reset();issued=data;mode='codes';draw();
          }else finish(data.user);
        }catch(error){status.textContent=error.message}
        finally{busy=false;submit.disabled=false}
      };
    }
    draw();screen.showModal();schedule();
  }
  window.RC={el,button,link,field,api,date,duration,mount,codesPanel};
})();
