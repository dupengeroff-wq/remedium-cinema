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
  function codesPanel(target,codes,done) {
    target.replaceChildren(el('h3','Резервные коды'),el('p','Сохрани их в надёжном месте. Каждый код работает один раз.'));
    const pre=el('pre',codes.join('\n'),'recovery-list');
    target.append(pre,button('Скачать коды',()=>{
      const url=URL.createObjectURL(new Blob([codes.join('\n')+'\n'],{type:'text/plain'}));
      const a=link('',''+url,'');
      a.download='remedium-recovery-codes.txt';
      a.click();
      setTimeout(()=>URL.revokeObjectURL(url),5000);
    }),button('Продолжить',done,true));
  }
  function mount(target,onLogin) {
    let mode='login';
    let loginValue='';
    function draw() {
      target.replaceChildren();
      const tabs=el('div',null,'account-tabs');
      for(const [id,label] of [['login','Вход'],['register','Регистрация'],['recover','Восстановление']]) {
        const item=button(label,()=>{loginValue=login.input.value;mode=id;draw()},id===mode);
        item.setAttribute('aria-pressed',String(id===mode));
        tabs.append(item);
      }
      const form=el('form',null,'account-form');
      form.method='post';
      const login=field('Логин','login',{autocomplete:'username',required:true,maxLength:80,value:loginValue,spellcheck:false});
      login.input.setAttribute('autocapitalize','off');
      const password=field(mode==='recover'?'Новый пароль':'Пароль','password',{type:'password',autocomplete:mode==='login'?'current-password':'new-password',required:true,maxLength:128});
      const status=el('p',null,'form-status');
      status.setAttribute('role','status');
      form.append(login.group);
      if(mode==='register') form.append(field('Ник','nickname',{autocomplete:'nickname',required:true,maxLength:40}).group);
      if(mode==='recover') form.append(field('Резервный код','code',{autocomplete:'off',required:true,maxLength:40}).group);
      form.append(password.group);
      if(mode!=='login') form.append(field('Подтверждение пароля','confirmation',{type:'password',autocomplete:'new-password',required:true,maxLength:128}).group);
      if(mode==='register'){
        const detail=el('details',null,'account-owner');
        detail.append(el('summary','Есть код создателя?'),field('Код создателя','creatorCode',{type:'password',autocomplete:'off',maxLength:256}).group);
        form.append(detail);
      }
      const submit=el('button',mode==='login'?'Войти':mode==='register'?'Создать аккаунт':'Сменить пароль','btn primary');
      submit.type='submit';
      form.append(submit,status);
      form.onsubmit=async event=>{
        event.preventDefault();
        if(submit.disabled) return;
        submit.disabled=true;
        status.textContent='Подключаемся…';
        const endpoint='/api/auth/'+mode;
        const body=Object.fromEntries(new FormData(form));
        try {
          const data=await api(endpoint,{method:'POST',body});
          if(mode==='recover'){
            mode='login'; loginValue=login.input.value; draw();
            target.querySelector('.form-status').textContent='Пароль изменён. Войди с новым паролем.';
            return;
          }
          form.reset();
          if(data.recoveryCodes) codesPanel(target,data.recoveryCodes,()=>onLogin(data.user));
          else onLogin(data.user);
        }catch(error){
          status.textContent=error.message;
          submit.disabled=false;
        }
      };
      target.append(tabs,form);
    }
    draw();
  }
  window.RC={el,button,link,field,api,date,duration,mount,codesPanel};
})();
