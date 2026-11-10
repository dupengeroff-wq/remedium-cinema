const $=id=>document.getElementById(id);
const socket=io();
const video=$('video');
let room='',self='',selfToken='',media=null,isHost=false;
let ytPlayer=null,vkPlayer=null,generation=0,joining=false;
let remoteUntil=0,lastSync=0,clock=0,playingState=false,knownDuration=0;
let muted=false,hostName='',messages=[],soundPromptNeeded=false;
let mediaReady=false,mediaTimer=null,playbackTimer=null,pendingSync=null,pendingAction=null,pendingSeek=null;
const playerScripts=new Map();
let badge='🎀',pickerMessage=null;
const BADGES=['🎀','🐈','🦊','💖','🐒'];
const REACTIONS=['🔥','🥹','😍','🤤','❤️'];
const tokenKey=id=>'rc-token-'+id;
const params=new URLSearchParams(location.search);
$('room').value=params.get('room')||localStorage.getItem('rc-room')||'';
$('name').value=localStorage.getItem('rc-name')||'';
video.muted=false;video.volume=1;
function toast(s){$('toast').textContent=s;$('toast').style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').style.display='none',3200)}
function randomRoom(){const a=new Uint8Array(9);crypto.getRandomValues(a);return Array.from(a,x=>x.toString(16).padStart(2,'0')).join('')}
function playerStatus(text='') {
  $('playerStatus').textContent=text;
  $('playerStatus').classList.toggle('hidden',!text);
}
function setSoundPrompt(show) {
  soundPromptNeeded=!!show;
  $('soundPrompt').classList.toggle('hidden',!show||!media);
}
function refreshSoundButton(){window.CinemaUI.setMuted(muted)}
function applyVolume(){
  video.muted=muted;video.volume=1;
  try {
    if(mediaReady&&media?.type==='youtube'&&ytPlayer){
      if(muted)ytPlayer.mute();else{ytPlayer.unMute();ytPlayer.setVolume(100)}
    }
    if(mediaReady&&media?.type==='vk'&&vkPlayer){
      if(muted)vkPlayer.mute();else{vkPlayer.unmute();vkPlayer.setVolume(1)}
    }
  }catch(e){console.warn('Volume:',e)}
  refreshSoundButton();
}
function activateSound(){
  if(!mediaReady)return;
  muted=false;applyVolume();
  // This call runs directly in the click gesture, including for a guest whose
  // browser rejected autoplay. It does not change the room's playback state.
  if(playingState)commandPlayback(true);else setSoundPrompt(false);
}
function loadPlayerScript(id,src,available){
  if(available())return Promise.resolve();
  if(playerScripts.has(id))return playerScripts.get(id);
  const promise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.id=id;script.src=src;
    const timeout=setTimeout(()=>fail(new Error('Player API timeout')),15000);
    function fail(error){clearTimeout(timeout);script.remove();playerScripts.delete(id);reject(error)}
    script.onerror=()=>fail(new Error('Player API unavailable'));
    script.onload=()=>{
      if(id!=='ytapi'){clearTimeout(timeout);available()?resolve():fail(new Error('Invalid player API'))}
    };
    if(id==='ytapi')window.onYouTubeIframeAPIReady=()=>{clearTimeout(timeout);resolve()};
    document.head.append(script);
  });
  playerScripts.set(id,promise);return promise;
}
function armPlayerTimeout(g){
  clearTimeout(mediaTimer);
  mediaTimer=setTimeout(()=>{
    if(g!==generation||mediaReady)return;
    playerStatus(media?.type==='vk'
      ?'VK не ответил. Проверь доступность ролика и разрешение на встраивание; попробуй запуск внутри видео.'
      :'Видео не загрузилось. Проверь ссылку и доступ к видеосервису.');
  },18000);
}
function playerReady(g){
  if(g!==generation)return;
  mediaReady=true;clearTimeout(mediaTimer);playerStatus();
  knownDuration=getDuration();applyVolume();updateHost();
  if(pendingSync)applySync(pendingSync);
  socket.emit('request-sync');
}
function playbackEvent(playing,g){
  if(g!==generation||!mediaReady)return;
  // Ignore old acknowledgements when the user quickly presses play/pause.
  if(pendingAction&&Date.now()<pendingAction.until&&pendingAction.playing!==playing)return;
  pendingAction=null;playingState=playing;
  if(playing){setSoundPrompt(false);playerStatus()}
  updateTimeline();sendSync();
}
function join(auto=false){if(!socket.connected)return toast('Подключаемся к серверу…');if(joining)return;const id=$('room').value.trim()||randomRoom(),name=$('name').value.trim().slice(0,24);if(!name)return toast('Напиши своё имя');joining=true;socket.emit('join',{room:id,name,token:localStorage.getItem(tokenKey(id))||''},res=>{joining=false;if(!res?.ok)return toast(res?.error||'Ошибка входа');const changed=room!==id;room=id;self=res.id;selfToken=res.token;isHost=!!res.isHost;localStorage.setItem('rc-room',id);localStorage.setItem('rc-name',name);localStorage.setItem(tokenKey(id),res.token);$('room').value=id;history.replaceState(null,'',location.pathname+'?room='+encodeURIComponent(id));$('entry').classList.add('hidden');$('invite').disabled=false;$('message').disabled=false;$('send').disabled=false;$('roomInfo').textContent='КОМНАТА · '+id;$('screenRoom').textContent='✦ ROOM '+id.slice(0,6).toUpperCase();$('status').textContent='● Подключено';if(changed){media=null;messages=[];$('messages').dataset.loaded='';setSoundPrompt(false)}updateHost();if(!auto)toast('Добро пожаловать в наш космос ♡')})}
$('join').onclick=()=>join();$('name').addEventListener('keydown',e=>{if(e.key==='Enter')join()});$('editName').onclick=()=>{$('entry').classList.remove('hidden');$('name').focus();$('name').select()};
$('invite').onclick=async()=>{if(!room)return;const url=location.origin+location.pathname+'?room='+encodeURIComponent(room);try{if(navigator.share)await navigator.share({url});else{await navigator.clipboard.writeText(url);toast('Ссылка скопирована')}}catch{}};
function updateHost(){document.body.classList.toggle('guest-view',!isHost);$('myBadge').classList.toggle('hidden',isHost);$('myBadge').textContent=badge;$('load').disabled=!isHost;$('url').disabled=!isHost;for(const id of ['play','back','forward','progress'])$(id).disabled=!isHost||!media||!mediaReady;$('role').textContent=isHost?'👑 ВЫ СОЗДАТЕЛЬ':'✦ ВЫ ГОСТЬ';$('hostBadge').textContent='♛ '+(hostName||'Создатель')+(isHost?' · вы':'');$('sound').disabled=!mediaReady;video.controls=true;video.style.pointerEvents='auto';$('yt').style.pointerEvents=isHost?'auto':'none';$('vk').style.pointerEvents='auto';if(!isHost&&document.activeElement?.tagName==='IFRAME')document.activeElement.blur();refreshSoundButton()}
$('load').onclick=()=>{if(!room)return toast('Сначала войдите');socket.emit('media',{url:$('url').value.trim()},res=>{if(res?.error)toast(res.error)})};
function showMedia(m){
  const g=++generation;
  mediaReady=false;pendingSync=null;pendingAction=null;pendingSeek=null;
  clearTimeout(mediaTimer);clearTimeout(playbackTimer);
  video.onloadedmetadata=null;video.oncanplay=null;video.onerror=null;
  try{video.pause()}catch{}
  try{ytPlayer?.destroy()}catch{}
  try{vkPlayer?.destroy()}catch{}
  ytPlayer=null;vkPlayer=null;
  video.removeAttribute('src');video.load();video.style.display='none';
  $('yt').style.display='none';$('vk').style.display='none';
  $('yt').replaceChildren();$('vk').replaceChildren();
  knownDuration=0;clock=0;playingState=false;
  refreshSoundButton();setSoundPrompt(false);
  $('placeholder').classList.toggle('hidden',!!m);
  updateHost();updateTimeline();playerStatus(m?'Загружаем видео…':'');
  if(!m)return;
  armPlayerTimeout(g);
  if(m.type==='video'){
    video.style.display='block';video.src=m.url;
    video.onloadedmetadata=()=>{if(g===generation)knownDuration=video.duration||0};
    video.oncanplay=()=>{if(!mediaReady)playerReady(g)};
    video.onerror=()=>{
      if(g!==generation)return;
      clearTimeout(mediaTimer);mediaReady=false;updateHost();
      playerStatus('Не удалось открыть видео. Нужна доступная прямая ссылка MP4/WebM.');
    };
    return;
  }
  if(m.type==='youtube'){
    const el=document.createElement('div');el.id='ytframe';$('yt').append(el);$('yt').style.display='block';
    loadPlayerScript('ytapi','https://www.youtube.com/iframe_api',()=>!!window.YT?.Player).then(()=>{
      if(g!==generation)return;
      ytPlayer=new YT.Player('ytframe',{
        videoId:m.id,width:'100%',height:'100%',
        playerVars:{playsinline:1,controls:1,disablekb:0,fs:1,rel:0,origin:location.origin},
        events:{
          onReady:()=>playerReady(g),
          onStateChange:e=>{if(e.data===1)playbackEvent(true,g);else if(e.data===0||e.data===2)playbackEvent(false,g)},
          onAutoplayBlocked:()=>{if(g===generation)setSoundPrompt(true)},
          onError:e=>{
            if(g!==generation)return;
            clearTimeout(mediaTimer);mediaReady=false;playingState=false;pendingAction=null;updateHost();updateTimeline();
            playerStatus([101,150].includes(e.data)?'Автор запретил встраивание этого видео. Выбери другую ссылку.':'YouTube не смог открыть видео. Проверь ссылку и доступность ролика.');
          }
        }
      });
    }).catch(e=>{
      if(g!==generation)return;
      console.warn(e);clearTimeout(mediaTimer);playerStatus('Не удалось загрузить YouTube API. Проверь соединение и блокировщики.');
    });
    return;
  }
  if(m.type==='vk'){
    const frame=document.createElement('iframe');
    const embed=new URL(m.embed);embed.searchParams.set('js_api','1');
    frame.src=embed.href;frame.title='VK Видео';frame.allow='autoplay; encrypted-media; fullscreen; picture-in-picture';
    frame.allowFullscreen=true;frame.referrerPolicy='strict-origin-when-cross-origin';frame.tabIndex=isHost?0:-1;
    $('vk').append(frame);$('vk').style.display='block';
    loadPlayerScript('vkapi','https://vk.com/js/api/videoplayer.js',()=>!!window.VK?.VideoPlayer).then(()=>{
      if(g!==generation)return;
      vkPlayer=VK.VideoPlayer(frame);
      // Event names are part of the public API. Do not look up lower-case
      // properties on Events: official SDK versions use upper-case keys.
      const observe=data=>{
        if(g!==generation)return;
        if(Number.isFinite(data?.duration))knownDuration=data.duration;
        if(Number.isFinite(data?.time)&&!pendingSeek)clock=data.time;
      };
      vkPlayer.on('inited',data=>{observe(data);playerReady(g)});
      vkPlayer.on('timeupdate',data=>{observe(data);updateTimeline()});
      for(const event of ['started','resumed'])vkPlayer.on(event,data=>{
        observe(data);if(!mediaReady)playerReady(g);playbackEvent(true,g);
      });
      for(const event of ['paused','ended'])vkPlayer.on(event,data=>{observe(data);playbackEvent(false,g)});
      vkPlayer.on('volumechange',data=>{
        if(g!==generation||typeof data?.muted!=='boolean')return;
        muted=data.muted;refreshSoundButton();
      });
      vkPlayer.on('error',()=>{
        if(g!==generation)return;
        clearTimeout(mediaTimer);mediaReady=false;playingState=false;pendingAction=null;updateHost();updateTimeline();
        playerStatus('VK не может воспроизвести ролик. Проверь доступ к нему и разрешение на встраивание.');
      });
      // The SDK can be attached after the iframe has already initialized.
      // Its cached state is usable only after a real state/duration arrives.
      if(vkPlayer.getDuration?.()>0||['playing','paused','ended'].includes(vkPlayer.getState?.()))playerReady(g);
    }).catch(e=>{
      if(g!==generation)return;
      console.warn(e);clearTimeout(mediaTimer);
      playerStatus('Не удалось загрузить API VK. Отключи блокировку vk.com; пока можно использовать кнопки внутри видео.');
    });
  }
}
function finiteTime(value,fallback=0){return Number.isFinite(value)&&value>=0?value:fallback}
function getTime(){
  if(pendingSeek){
    if(Date.now()<pendingSeek.until)return pendingSeek.time;
    pendingSeek=null;
  }
  if(!mediaReady)return clock;
  try{
    if(media?.type==='youtube')return finiteTime(ytPlayer?.getCurrentTime(),clock);
    if(media?.type==='vk')return finiteTime(vkPlayer?.getCurrentTime(),clock);
    if(media?.type==='video')return finiteTime(video.currentTime,clock);
  }catch{}
  return clock;
}
function getDuration(){
  if(!mediaReady)return knownDuration;
  try{
    let value=0;
    if(media?.type==='youtube')value=ytPlayer?.getDuration();
    if(media?.type==='vk')value=vkPlayer?.getDuration();
    if(media?.type==='video')value=video.duration;
    return finiteTime(value,knownDuration)||knownDuration;
  }catch{return knownDuration}
}
function getPlaying(){
  if(pendingAction&&Date.now()<pendingAction.until)return pendingAction.playing;
  if(!mediaReady)return playingState;
  try{
    if(media?.type==='youtube'){
      const state=ytPlayer?.getPlayerState();
      return state===1||state===3&&playingState;
    }
    if(media?.type==='vk'){
      const state=vkPlayer?.getState();
      return state==='playing'?true:['paused','ended','unstarted'].includes(state)?false:playingState;
    }
    if(media?.type==='video')return !video.paused&&!video.ended;
  }catch{}
  return playingState;
}
function emitPlayback(time,playing){
  if(!room||!media||!isHost)return;
  socket.emit('sync',{time:finiteTime(time),playing:!!playing});lastSync=Date.now();
}
function sendSync(){
  if(!room||!media||!isHost||!mediaReady||Date.now()<remoteUntil)return;
  clock=getTime();playingState=getPlaying();emitPlayback(clock,playingState);updateTimeline();
}
function commandPlayback(playing){
  const g=generation;
  pendingAction={playing,until:Date.now()+4000};
  clearTimeout(playbackTimer);
  try{
    if(media.type==='video'){
      if(playing)video.play().then(()=>{if(g===generation)setSoundPrompt(false)}).catch(()=>{
        if(g!==generation)return;
        pendingAction=null;
        if(isHost){playingState=false;emitPlayback(getTime(),false)}
        setSoundPrompt(true);updateTimeline();
      });
      else video.pause();
    }
    if(media.type==='youtube'){if(playing)ytPlayer.playVideo();else ytPlayer.pauseVideo()}
    if(media.type==='vk'){if(playing)vkPlayer.play();else vkPlayer.pause()}
  }catch(e){
    pendingAction=null;throw e;
  }
  playbackTimer=setTimeout(()=>{
    if(g!==generation||!pendingAction)return;
    pendingAction=null;
    if(playing&&!getPlaying()){
      if(isHost){playingState=false;emitPlayback(getTime(),false)}
      setSoundPrompt(true);
    }
    updateTimeline();
  },4200);
}
function applySync(d){
  if(!media)return;
  pendingSync={time:finiteTime(Number(d.time)),playing:!!d.playing};
  clock=pendingSync.time;playingState=pendingSync.playing;
  remoteUntil=Date.now()+1600;
  if(!mediaReady){updateTimeline();return}
  const time=clock,playing=playingState;
  try{
    // Clear a previous pending seek before comparing actual provider time.
    pendingSeek=null;
    if(Math.abs(getTime()-time)>1.5){
      if(media.type==='video')video.currentTime=time;
      if(media.type==='youtube')ytPlayer.seekTo(time,true);
      if(media.type==='vk')vkPlayer.seek(time);
      pendingSeek={time,until:Date.now()+800};
    }
    applyVolume();commandPlayback(playing);
    if(!playing)setSoundPrompt(false);
  }catch(e){console.warn('Sync:',e);if(playing)setSoundPrompt(true)}
  updateTimeline();
}
function formatTime(n){n=Math.max(0,Math.floor(Number(n)||0));const h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=n%60;return(h?h+':':'')+String(m).padStart(h?2:1,'0')+':'+String(s).padStart(2,'0')}
function updateTimeline(){
  const t=getTime(),d=getDuration(),playing=getPlaying();
  $('elapsed').textContent=formatTime(t);$('duration').textContent=formatTime(d);
  $('progress').max=d||100;$('progress').value=Math.min(d||100,t);
  window.CinemaUI.setPlaying(playing);
  $('playingBadge').textContent=!media?'● ОЖИДАНИЕ':!mediaReady?'◌ ЗАГРУЗКА':playing?'◉ СМОТРИМ ВМЕСТЕ':'◉ ПАУЗА';
}
function seekTo(t){
  if(!isHost||!media||!mediaReady)return;
  const duration=getDuration();t=Math.max(0,Math.min(duration||Infinity,finiteTime(Number(t))));
  try{
    if(media.type==='video')video.currentTime=t;
    if(media.type==='youtube')ytPlayer.seekTo(t,true);
    if(media.type==='vk')vkPlayer.seek(t);
    clock=t;pendingSeek={time:t,until:Date.now()+800};remoteUntil=0;
    emitPlayback(t,getPlaying());updateTimeline();
  }catch(e){console.warn(e);toast('Плеер не смог перемотать видео. Попробуй ещё раз.')}
}
$('play').onclick=()=>{
  if(!isHost||!media||!mediaReady)return;
  const shouldPlay=!getPlaying();remoteUntil=0;
  try{
    playingState=shouldPlay;commandPlayback(shouldPlay);
    emitPlayback(getTime(),shouldPlay);updateTimeline();
  }catch(e){
    console.warn('Playback:',e);playingState=getPlaying();updateTimeline();
    toast('Не удалось запустить видео. Проверь ссылку и доступность ролика.');
  }
};
$('back').onclick=()=>seekTo(getTime()-10);
$('forward').onclick=()=>seekTo(getTime()+10);
$('progress').onchange=e=>seekTo(Number(e.target.value));
for(const event of ['play','pause','ended'])video.addEventListener(event,()=>{
  if(media?.type==='video'&&mediaReady)playbackEvent(!video.paused&&!video.ended,generation);
});
video.addEventListener('seeked',sendSync);
$('sound').onclick=()=>{
  if(!mediaReady)return;
  muted=!muted;applyVolume();
  if(!muted)activateSound();
};
$('soundPrompt').onclick=activateSound;
function avatar(name){return String(name||'?').trim().slice(0,1).toUpperCase()}
function isMine(msg){return !!selfToken&&msg.author===selfToken}
function badgeFor(msg){return msg.isHost?'👑':msg.badge||'🎀'}
function openPicker(kind,msg=null){pickerMessage=msg;$('pickerTitle').textContent=kind==='badge'?'Твой космический знак':'Реакция на сообщение';$('pickerHint').textContent=kind==='badge'?'Нажми, чтобы заменить бантик':'Выбери эмоцию — она появится у обоих';const choices=$('pickerChoices');choices.replaceChildren();for(const emoji of(kind==='badge'?BADGES:REACTIONS)){const b=document.createElement('button');b.className='choice';b.type='button';b.textContent=emoji;b.onclick=()=>{closePicker();if(kind==='badge'){socket.emit('set-badge',emoji,res=>{if(!res?.ok)toast(res?.error||'Не удалось изменить значок')})}else if(msg?.id){socket.emit('react',{id:msg.id,emoji},res=>{if(!res?.ok)toast('Не удалось поставить реакцию')})}};choices.append(b)}$('pickerOverlay').classList.remove('hidden')}
$('myBadge').onclick=()=>{if(!isHost)openPicker('badge')};
function closePicker(){$('pickerOverlay').classList.add('hidden');pickerMessage=null}$('pickerClose').onclick=closePicker;$('pickerOverlay').onclick=e=>{if(e.target===$('pickerOverlay'))closePicker()};document.addEventListener('keydown',e=>{if(e.key==='Escape')closePicker()});
function nameElement(msg){const stack=document.createElement('div');stack.className='name-stack';const badgeEl=document.createElement(!msg.isHost&&isMine(msg)?'button':'span');badgeEl.className='badge-icon'+(!msg.isHost&&isMine(msg)?' editable':'');badgeEl.textContent=badgeFor(msg);if(badgeEl.tagName==='BUTTON'){badgeEl.type='button';badgeEl.title='Изменить значок';badgeEl.onclick=()=>openPicker('badge')}stack.append(badgeEl);const name=document.createElement('span');name.className='msgname';name.textContent=msg.name;stack.append(name);return stack}
function renderReactions(msg,container){container.replaceChildren();for(const emoji of REACTIONS){const tokens=msg.reactions?.[emoji]||[];if(!tokens.length)continue;const b=document.createElement('button');b.type='button';b.className='reaction-pill'+(tokens.includes(selfToken)?' mine':'');b.textContent=emoji+' '+tokens.length;b.title='Изменить реакцию';b.onclick=()=>socket.emit('react',{id:msg.id,emoji});container.append(b)}}
function attachLongPress(el,msg){let timer=null,x=0,y=0,opened=false;const cancel=()=>{clearTimeout(timer);timer=null};el.addEventListener('pointerdown',e=>{if(e.button!==0&&e.pointerType==='mouse')return;opened=false;x=e.clientX;y=e.clientY;cancel();timer=setTimeout(()=>{opened=true;openPicker('reaction',msg)},480)});el.addEventListener('pointermove',e=>{if(Math.abs(e.clientX-x)>12||Math.abs(e.clientY-y)>12)cancel()});for(const ev of ['pointerup','pointercancel','pointerleave'])el.addEventListener(ev,cancel);el.addEventListener('contextmenu',e=>{e.preventDefault();cancel();if(!opened)openPicker('reaction',msg)});el.addEventListener('click',e=>{if(opened){e.preventDefault();opened=false}})}
function appendMessage(msg){const list=$('messages');list.querySelector('.empty')?.remove();const row=document.createElement('div');row.className='msg '+(msg.isHost?'host':'guest')+(isMine(msg)?' mine':'');row.dataset.messageId=msg.id||'';const content=document.createElement('div');content.className='msg-content';const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=msg.text;attachLongPress(bubble,msg);const reactionRow=document.createElement('div');reactionRow.className='reaction-row';renderReactions(msg,reactionRow);const time=document.createElement('div');time.className='msgtime';time.textContent=new Date(msg.at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});content.append(nameElement(msg),bubble,reactionRow,time);row.append(content);list.append(row);list.scrollTop=list.scrollHeight}
function renderAllMessages(){const list=$('messages');list.replaceChildren();for(const msg of messages)appendMessage(msg);if(!messages.length){const e=document.createElement('div');e.className='empty';e.textContent='Тишина перед началом фильма ✦ Зажми сообщение, чтобы поставить реакцию.';list.append(e)}}
function floatMessage(msg){const row=document.createElement('div');row.className='floatmsg';const av=document.createElement('div');av.className='avatar';av.textContent=avatar(msg.name);const b=document.createElement('div');b.className='floatbubble';const who=document.createElement('b');who.textContent=badgeFor(msg)+' '+msg.name+': ';const text=document.createElement('span');text.textContent=msg.text;b.append(who,text);row.append(b);$('floating').append(row);while($('floating').children.length>4)$('floating').firstElementChild.remove();setTimeout(()=>row.remove(),8500)}
$('chatForm').onsubmit=e=>{e.preventDefault();const text=$('message').value.trim();if(!text||!room)return;socket.emit('chat',text);$('message').value=''};
socket.on('chat',msg=>{if(!room)return;messages.push(msg);appendMessage(msg);floatMessage(msg)});
socket.on('reaction-update',update=>{const msg=messages.find(m=>m.id===update.id);if(!msg)return;msg.reactions=update.reactions;const row=[...$('messages').children].find(el=>el.dataset.messageId===update.id);if(row)renderReactions(msg,row.querySelector('.reaction-row'))});
socket.on('room-state',state=>{if(!room)return;isHost=!!state.users.find(u=>u.id===self)?.isHost;hostName=state.hostName||'Создатель';badge=state.users.find(u=>u.id===self)?.badge||'🎀';$('online').textContent=state.users.length+' онлайн';const changed=JSON.stringify(media)!==JSON.stringify(state.media);if(changed){media=state.media;showMedia(media);$('url').value=media?.url||''}updateHost();const previous=JSON.stringify(messages.map(m=>[m.id,m.badge,m.reactions]));messages=state.messages||[];if(!$('messages').dataset.loaded||previous!==JSON.stringify(messages.map(m=>[m.id,m.badge,m.reactions]))){renderAllMessages();$('messages').dataset.loaded='1'}if(changed)applySync({time:state.time,playing:state.playing});else if(media){playingState=!!state.playing;updateTimeline()}});
socket.on('sync',applySync);
socket.on('connect',()=>{$('status').textContent='● Подключено';if(room){const id=room;room='';media=null;$('messages').dataset.loaded='';$('room').value=id;join(true)}else $('entry').classList.remove('hidden')});
socket.on('disconnect',()=>{$('status').textContent='● Переподключение…'});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&room&&socket.connected)socket.emit('request-sync')});
setInterval(()=>{if(room&&media){updateTimeline();if(isHost&&getPlaying()&&Date.now()-lastSync>5000)sendSync()}},1000);
// Lightweight star field with meteors; stops moving for reduced-motion users.
(()=>{const canvas=$('cosmos'),ctx=canvas.getContext('2d');if(!ctx)return;const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;let w=0,h=0,dpr=1,stars=[],meteors=[],last=0,nextMeteor=0;function resize(){dpr=Math.min(devicePixelRatio||1,2);w=innerWidth;h=innerHeight;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0);stars=Array.from({length:Math.min(200,Math.floor(w*h/5700))},()=>({x:Math.random()*w,y:Math.random()*h,r:.35+Math.random()*1.15,a:.18+Math.random()*.7,p:Math.random()*6.28,s:.0003+Math.random()*.001}))}function draw(t){ctx.clearRect(0,0,w,h);for(const s of stars){const a=reduced?s.a:s.a*(.7+.3*Math.sin(t*s.s+s.p));ctx.fillStyle=`rgba(225,225,225,${a})`;ctx.beginPath();ctx.arc(s.x,s.y,s.r,0,Math.PI*2);ctx.fill()}if(!reduced){if(t>nextMeteor){meteors.push({x:Math.random()*w*.8+w*.1,y:-40,v:4+Math.random()*3,len:75+Math.random()*110,a:1});nextMeteor=t+2500+Math.random()*5000}for(const m of meteors){m.x-=m.v*1.3;m.y+=m.v;m.a-=.007;const grad=ctx.createLinearGradient(m.x,m.y,m.x+m.len*.8,m.y-m.len*.6);grad.addColorStop(0,`rgba(245,245,245,${Math.max(0,m.a)})`);grad.addColorStop(1,'rgba(230,230,230,0)');ctx.strokeStyle=grad;ctx.lineWidth=1.7;ctx.beginPath();ctx.moveTo(m.x,m.y);ctx.lineTo(m.x+m.len*.8,m.y-m.len*.6);ctx.stroke()}meteors=meteors.filter(m=>m.a>0&&m.y<h+120)}last=t;if(!reduced)requestAnimationFrame(draw)}resize();addEventListener('resize',resize,{passive:true});requestAnimationFrame(draw)})();

// Personal movie list. Entirely local, not shared through Socket.IO.
const WATCH_KEY='remediumCinemaPersonalWatchV1';
const WATCH_DEFAULTS=[{"name":"Парни с тату","status":"done","category":"main"},{"name":"Ты умрешь через 6 часов","status":"done","category":"main"},{"name":"Гретель и Гензель","status":"done","category":"main"},{"name":"Платформа 1,2","status":"done","category":"main"},{"name":"Мы","status":"done","category":"main"},{"name":"Игра Джеральда","status":"done","category":"main"},{"name":"Уроки Фарси","status":"done","category":"main"},{"name":"Воровка книг","status":"done","category":"main"},{"name":"Дориан Грей","status":"done","category":"main"},{"name":"Магазинчик самоубийств","status":"done","category":"main"},{"name":"Коралина в Стране Кошмаров","status":"done","category":"main"},{"name":"Труп невесты","status":"done","category":"main"},{"name":"Глаза сердечки","status":"done","category":"main"},{"name":"Франкенвини","status":"done","category":"main"},{"name":"Пиноккио","status":"done","category":"main"},{"name":"Шрек 1","status":"done","category":"main"},{"name":"Шрек 2","status":"done","category":"main"},{"name":"Шрек 3","status":"done","category":"main"},{"name":"Шрек 4","status":"done","category":"main"},{"name":"Короткометражки Шрек","status":"done","category":"main"},{"name":"Носферату","status":"done","category":"main"},{"name":"Обезьяна","status":"done","category":"main"},{"name":"Сумерки все Сага","status":"done","category":"main"},{"name":"В поисках Аляски (сериал)","status":"done","category":"main"},{"name":"Осд (сериал) 1-3 сезоны, 4,5","status":"done","category":"main"},{"name":"Леденящие душу приключения Сабрины","status":"progress","category":"main"},{"name":"Джинни и Джорджия","status":"progress","category":"main"},{"name":"Конец ебаного мира","status":"done","category":"main"},{"name":"13 причин почему","status":"done","category":"main"},{"name":"scam (стыд) 1,2,3","status":"done","category":"main"},{"name":"Укрытие (сериал)","status":"done","category":"main"},{"name":"Эйфория","status":"done","category":"main"},{"name":"Тьма","status":"done","category":"main"},{"name":"Поделиться","status":"done","category":"main"},{"name":"Финес и Ферб","status":"done","category":"main"},{"name":"Эй, Арнольд!","status":"none","category":"main"},{"name":"Мне это не нравится","status":"none","category":"main"},{"name":"Острые козырьки","status":"no","category":"main"},{"name":"Гарри Поттер","status":"no","category":"main"},{"name":"Оно новая глава","status":"no","category":"main"},{"name":"Крик 1","status":"done","category":"main"},{"name":"Крик 2","status":"no","category":"main"},{"name":"Крик 3","status":"no","category":"main"},{"name":"Крик 4","status":"no","category":"main"},{"name":"Крик 5","status":"no","category":"main"},{"name":"Крик 6","status":"no","category":"main"},{"name":"Крик 7","status":"no","category":"main"},{"name":"Пророк А.С. Пушкин","status":"no","category":"main"},{"name":"Трилогия Гоголя","status":"no","category":"main"},{"name":"Анна Каренина","status":"no","category":"main"},{"name":"Компаньон","status":"no","category":"main"},{"name":"Чикатило","status":"no","category":"main"},{"name":"Фишер","status":"no","category":"main"},{"name":"Триггер","status":"no","category":"main"},{"name":"Холоп","status":"no","category":"main"},{"name":"Аватар 3","status":"no","category":"main"},{"name":"Один дома на НГ 🎄","status":"no","category":"main"},{"name":"Оно 1","status":"no","category":"main"},{"name":"Оно 2","status":"done","category":"main"},{"name":"Оно 3","status":"no","category":"main"},{"name":"Выбывшая","status":"done","category":"main"},{"name":"Ход королевы","status":"no","category":"main"},{"name":"Одни из нас","status":"no","category":"main"},{"name":"Озарк 1–4","status":"done","category":"main"},{"name":"Список смертников","status":"no","category":"main"},{"name":"Переходный возраст","status":"done","category":"main"},{"name":"Карма","status":"no","category":"main"},{"name":"Призраки дома на холме","status":"done","category":"main"},{"name":"Охотник за голова","status":"done","category":"main"},{"name":"Килербот","status":"done","category":"main"},{"name":"Во всем виновата она","status":"done","category":"main"},{"name":"Красные нити","status":"done","category":"main"},{"name":"Черное зеркало","status":"done","category":"main"},{"name":"Килербот","status":"done","category":"main"},{"name":"Декстер 1–7","status":"done","category":"main"},{"name":"Во все тяжкие","status":"done","category":"main"},{"name":"Периферийные устройства","status":"done","category":"main"},{"name":"Злой умысел","status":"done","category":"main"},{"name":"Добро пожаловать в Дерри","status":"done","category":"main"},{"name":"Одна из многих","status":"done","category":"main"},{"name":"Чудовище внутри меня","status":"done","category":"main"},{"name":"Оленёнок","status":"done","category":"main"},{"name":"Дорогой Санта","status":"done","category":"main"},{"name":"Настоящий детектив","status":"no","category":"main"},{"name":"Последний человек на земле","status":"no","category":"main"},{"name":"Фоллаут","status":"no","category":"main"},{"name":"Побег","status":"done","category":"main"},{"name":"Половое воспитание","status":"no","category":"main"},{"name":"Чернобыль","status":"no","category":"main"},{"name":"Слабый герой","status":"no","category":"main"},{"name":"Линкольн для адвоката","status":"no","category":"main"},{"name":"Школьные духи","status":"no","category":"main"},{"name":"Сделано в Кореи","status":"no","category":"main"},{"name":"Кросс","status":"no","category":"main"},{"name":"Ночной агент","status":"no","category":"main"},{"name":"Снова на воле","status":"no","category":"main"},{"name":"Больница Питт","status":"no","category":"main"},{"name":"Выход 8","status":"no","category":"main"},{"name":"Извне","status":"done","category":"main"},{"name":"Невидимая стороны","status":"no","category":"main"},{"name":"Волшебник Изумрудного города","status":"none","category":"moderation"},{"name":"Интерстеллар","status":"none","category":"moderation"},{"name":"Начальница","status":"no","category":"moderation"},{"name":"Лудермилк","status":"no","category":"moderation"},{"name":"Начальная школа Эбботт","status":"no","category":"moderation"},{"name":"Мег 2: Впадина","status":"no","category":"moderation"},{"name":"Уэйндвард Пайнс","status":"no","category":"moderation"},{"name":"Общество","status":"no","category":"moderation"},{"name":"Академия","status":"no","category":"moderation"},{"name":"Манифест","status":"no","category":"moderation"},{"name":"Архив 81","status":"done","category":"moderation"},{"name":"Зло","status":"no","category":"moderation"},{"name":"Лаки","status":"done","category":"moderation"},{"name":"Бороуз","status":"no","category":"moderation"},{"name":"Старьевщик","status":"done","category":"moderation"},{"name":"Люпен","status":"done","category":"moderation"},{"name":"Соник — 4 части","status":"none","category":"moderation"},{"name":"Мыс страха","status":"done","category":"moderation"},{"name":"Проект Гутенберг","status":"no","category":"moderation"},{"name":"Кэрри","status":"done","category":"moderation"},{"name":"Милые обманщицы","status":"no","category":"moderation"},{"name":"Элита","status":"no","category":"moderation"},{"name":"Молокососы","status":"no","category":"moderation"},{"name":"Деграсси","status":"no","category":"moderation"},{"name":"Ривердейл","status":"no","category":"moderation"}];
let watchItems=[];
try{const stored=JSON.parse(localStorage.getItem(WATCH_KEY));watchItems=Array.isArray(stored)?stored:[]}catch{watchItems=[]}
// Seed once per browser. Keep existing entries and user-modified statuses untouched.
const WATCH_SEED_FLAG='remediumCinemaBuiltInList20261109';
if(localStorage.getItem(WATCH_SEED_FLAG)!=='yes'){
 const keys=new Set(watchItems.map(x=>x.category+'|'+x.name.trim().toLocaleLowerCase('ru')));
 for(const item of WATCH_DEFAULTS){const key=item.category+'|'+item.name.trim().toLocaleLowerCase('ru');if(!keys.has(key)){watchItems.push({id:globalThis.crypto?.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(36).slice(2),...item});keys.add(key)}}
 try{localStorage.setItem(WATCH_KEY,JSON.stringify(watchItems));localStorage.setItem(WATCH_SEED_FLAG,'yes')}catch(err){console.warn('Не удалось сохранить встроенный список',err)}
}
const watchStatus={none:'Без отметки',done:'✓ Просмотрено',no:'× В планах',progress:'… В процессе'};
const watchId=()=>globalThis.crypto?.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(36).slice(2);
function watchSave(){try{localStorage.setItem(WATCH_KEY,JSON.stringify(watchItems))}catch{toast('Не удалось сохранить список: память браузера заполнена')}watchRender()}

// Movie posters are optional and never modify stored film names, status, or collection.
// Locally bundled original illustrated covers. No external network requests.
// Bundled poster atlas: one local PNG, no network catalog or SVG data URLs.
const LOCAL_POSTERS = {"парни с тату":"posters/marked-men-rule-shaw-1078600.webp","ты умрешь через 6 часов":"posters/movie-1147266-1147266.webp","гретель и гензель":"posters/gretel-hansel-542224.webp","мы":"posters/us-458723.webp","игра джеральда":"posters/gerald-s-game-343674.webp","уроки фарси":"posters/persischstunden-581577.webp","воровка книг":"posters/the-book-thief-203833.webp","дориан грей":"posters/dorian-gray-23488.webp","магазинчик самоубийств":"posters/le-magasin-des-suicides-118293.webp","коралина в стране кошмаров":"posters/coraline-14836.webp","труп невесты":"posters/corpse-bride-3933.webp","глаза сердечки":"posters/heart-eyes-1302916.webp","франкенвини":"posters/frankenweenie-62214.webp","шрек 2":"posters/shrek-2-809.webp","носферату":"posters/nosferatu-426063.webp","обезьяна":"posters/the-monkey-1124620.webp","леденящие душу приключения сабрины":"posters/chilling-adventures-of-sabrina-79242.webp","джинни и джорджия":"posters/ginny-georgia-117581.webp","13 причин почему":"posters/13-reasons-why-66788.webp","эйфория":"posters/euphoria-85552.webp","тьма":"posters/dark-70523.webp","финес и ферб":"posters/phineas-and-ferb-1877.webp","эй, арнольд!":"posters/hey-arnold-537.webp","мне это не нравится":"posters/i-am-not-okay-with-this-90260.webp","острые козырьки":"posters/peaky-blinders-60574.webp","крик 2":"posters/scream-2-4233.webp","крик 3":"posters/scream-3-4234.webp","крик 4":"posters/scream-4-41446.webp","крик 5":"posters/scream-646385.webp","крик 6":"posters/scream-vi-934433.webp","крик 7":"posters/scream-7-1159559.webp","компаньон":"posters/companion-1084199.webp","чикатило":"posters/tv-109356-109356.webp","фишер":"posters/tv-220018-220018.webp","триггер":"posters/tv-99671-99671.webp","холоп":"posters/movie-575828-575828.webp","оно 2":"posters/it-chapter-two-474350.webp","выбывшая":"posters/the-dropout-122066.webp","ход королевы":"posters/the-queen-s-gambit-87739.webp","одни из нас":"posters/the-last-of-us-100088.webp","список смертников":"posters/the-terminal-list-120911.webp","переходный возраст":"posters/adolescence-249042.webp","карма":"posters/tv-233686-233686.webp","призраки дома на холме":"posters/the-haunting-of-hill-house-72844.webp","во всем виновата она":"posters/all-her-fault-246386.webp","красные нити":"posters/s-232402.webp","черное зеркало":"posters/black-mirror-42009.webp","во все тяжкие":"posters/breaking-bad-1396.webp","периферийные устройства":"posters/the-peripheral-95403.webp","злой умысел":"posters/malice-244416.webp","одна из многих":"posters/wycaro-225171.webp","чудовище внутри меня":"posters/the-beast-in-me-250504.webp","оленёнок":"posters/baby-reindeer-241259.webp","дорогой санта":"posters/dear-santa-1097870.webp","настоящий детектив":"posters/true-detective-46648.webp","последний человек на земле":"posters/the-last-man-on-earth-61888.webp","фоллаут":"posters/fallout-106379.webp","побег":"posters/prison-break-2288.webp","половое воспитание":"posters/sex-education-81356.webp","чернобыль":"posters/chernobyl-87108.webp","слабый герой":"posters/tv-200709-200709.webp","линкольн для адвоката":"posters/the-lincoln-lawyer-116799.webp","школьные духи":"posters/school-spirits-208397.webp","кросс":"posters/cross-213306.webp","ночной агент":"posters/the-night-agent-129552.webp","снова на воле":"posters/unprisoned-201902.webp","больница питт":"posters/the-pitt-250307.webp","выход 8":"posters/movie-1408208-1408208.webp","извне":"posters/from-124364.webp","волшебник изумрудного города":"posters/movie-658224-658224.webp","интерстеллар":"posters/interstellar-157336.webp","начальница":"posters/girlboss-65856.webp","лудермилк":"posters/loudermilk-73200.webp","начальная школа эбботт":"posters/abbott-elementary-125935.webp","мег 2: впадина":"posters/meg-2-the-trench-615656.webp","общество":"posters/the-society-84647.webp","манифест":"posters/manifest-79696.webp","архив 81":"posters/archive-81-112314.webp","зло":"posters/evil-86848.webp","лаки":"posters/lucky-278624.webp","бороуз":"posters/the-boroughs-224941.webp","люпен":"posters/lupin-96677.webp","проект гутенберг":"posters/movie-531384-531384.webp","милые обманщицы":"posters/pretty-little-liars-31917.webp","элита":"posters/elite-76669.webp","молокососы":"posters/skins-900.webp","деграсси":"posters/degrassi-1948.webp","ривердейл":"posters/riverdale-69050.webp","платформа 1,2":"posters/el-hoyo-619264.webp","пиноккио":"posters/guillermo-del-toro-s-pinocchio-555604.webp","шрек 1":"posters/shrek-808.webp","шрек 3":"posters/shrek-the-third-810.webp","шрек 4":"posters/shrek-forever-after-10192.webp","короткометражки шрек":"posters/scared-shrekless-48466.webp","сумерки все сага":"posters/twilight-8966.webp","в поисках аляски (сериал)":"posters/looking-for-alaska-88640.webp","осд (сериал) 1-3 сезоны, 4,5":"posters/stranger-things-66732.webp","конец ебаного мира":"posters/the-end-of-the-f-ing-world-74577.webp","scam (стыд) 1,2,3":"posters/skam-65320.webp","укрытие (сериал)":"posters/silo-125988.webp","поделиться":"posters/share-510355.webp","гарри поттер":"posters/harry-potter-and-the-philosopher-s-stone-671.webp","оно новая глава":"posters/welcome-to-derry-200875.webp","крик 1":"posters/scream-4232.webp","пророк а.с. пушкин":"posters/movie-1008445-1008445.webp","трилогия гоголя":"posters/movie-468988-468988.webp","анна каренина":"posters/anna-karenina-96724.webp","аватар 3":"posters/avatar-fire-and-ash-83533.webp","один дома на нг 🎄":"posters/home-alone-771.webp","оно 1":"posters/it-346364.webp","озарк 1–4":"posters/ozark-69740.webp","охотник за голова":"posters/the-bondsman-229711.webp","килербот":"posters/murderbot-241554.webp","декстер 1–7":"posters/dexter-1405.webp","добро пожаловать в дерри":"posters/welcome-to-derry-200875.webp","сделано в кореи":"posters/tv-246473-246473.webp","невидимая стороны":"posters/the-blind-side-22881.webp","уэйндвард пайнс":"posters/wayward-pines-53425.webp","академия":"posters/akademiya-2015.webp","старьевщик":"posters/staryovschik-2022.webp","соник — 4 части":"posters/sonic-the-hedgehog-454626.webp","мыс страха":"posters/cape-fear-1598.webp","кэрри":"posters/carrie-7340.webp"};
const posterCache = new Map();
function posterEnqueue(item,holder){
 const key=String(item.name||'').trim().toLocaleLowerCase('ru');
 const local=LOCAL_POSTERS[key];
 const custom=typeof item.poster==='string' && /^https:\/\//i.test(item.poster)?item.poster:null;
 const url=custom||local;
 if(!url)return;
 const img=document.createElement('img');
 img.alt='Постер: '+item.name;
 img.loading='lazy';
 img.decoding='async';
 img.style.cssText='display:block;width:100%;height:100%;object-fit:cover;object-position:center;border-radius:inherit;';
 img.onload=()=>{if(holder.isConnected){holder.style.backgroundImage='none';holder.replaceChildren(img)}};
 img.onerror=()=>{if(holder.isConnected)holder.textContent='✦'};
 img.src=url;
}
function watchRender(){
 const list=$('watchItems'),q=$('watchSearch').value.trim().toLocaleLowerCase('ru'),cat=$('watchCategory').value;
 list.replaceChildren();const filtered=watchItems.filter(x=>(cat==='all'||x.category===cat)&&x.name.toLocaleLowerCase('ru').includes(q));
 $('watchCount').textContent='· '+watchItems.length;
 const done=watchItems.filter(x=>x.status==='done').length;
 $('watchStats').innerHTML='<span class="stat-pill">✦ '+watchItems.length+' в коллекции</span><span class="stat-pill">✓ '+done+' просмотрено</span><span class="stat-pill">◷ '+watchItems.filter(x=>x.status==='progress').length+' смотрим</span>';
 for(const item of filtered){
  const row=document.createElement('article');row.className='watch-item';
  const poster=document.createElement('div');poster.className='watch-poster';poster.textContent='✦';
  const info=document.createElement('div');info.className='watch-info';
  const title=document.createElement('div');title.className='watch-title';title.textContent=item.name;
  const subtitle=document.createElement('div');subtitle.className='watch-subtitle';subtitle.textContent=item.category==='moderation'?'НА МОДЕРАЦИИ':'НАША КОЛЛЕКЦИЯ';info.append(title,subtitle);
  const actions=document.createElement('div');actions.className='watch-actions';
  const select=document.createElement('select');select.title='Статус';for(const [value,label] of Object.entries(watchStatus)){const opt=document.createElement('option');opt.value=value;opt.textContent=label;select.append(opt)}select.value=item.status;select.onchange=()=>{item.status=select.value;watchSave()};
  const edit=document.createElement('button');edit.textContent='✎';edit.title='Изменить название';edit.onclick=()=>{const value=prompt('Название фильма',item.name);if(value===null)return;if(value.trim())item.name=value.trim().slice(0,120);const link=prompt('Ссылка на постер (https://). Оставь пустым для автоматического поиска.',item.poster||'');if(link!==null){if(link.trim()&&!/^https:\/\//i.test(link.trim())){toast('Нужна ссылка https://');return}item.poster=link.trim().slice(0,1200)}posterCache.delete(item.name.toLocaleLowerCase('ru'));watchSave()};
  const del=document.createElement('button');del.textContent='×';del.title='Удалить';del.onclick=()=>{if(confirm('Удалить «'+item.name+'»?')){watchItems=watchItems.filter(x=>x.id!==item.id);watchSave()}};
  actions.append(select,edit,del);row.append(poster,info,actions);list.append(row);posterEnqueue(item,poster)
 }
 if(!filtered.length){const empty=document.createElement('div');empty.className='watch-note';empty.textContent=watchItems.length?'Ничего не найдено':'Коллекция пока пуста. Добавь первый фильм ✦';list.append(empty)}
}
$('watchForm').onsubmit=e=>{e.preventDefault();const name=$('watchName').value.trim();if(!name)return;watchItems.push({id:watchId(),name,status:'none',category:$('watchNewCategory').value});$('watchName').value='';watchSave()};
$('watchSearch').oninput=watchRender;$('watchCategory').onchange=watchRender;
$('watchImport').onclick=()=>$('watchFile').click();
function watchNormalize(arr){return arr.filter(x=>x&&typeof x.name==='string'&&x.name.trim()).map(x=>({id:watchId(),name:x.name.trim().slice(0,120),status:Object.hasOwn(watchStatus,x.status)?x.status:'none',category:x.category==='moderation'?'moderation':'main'}))}
function watchParseLegacy(html){const results=[];for(const [variable,category] of [['initial','main'],['moderation','moderation']]){const section=html.match(new RegExp('const\\s+'+variable+'\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*\\.map'));if(!section)continue;const regex=/\[\s*("(?:\\.|[^"\\])*"|\x27(?:\\.|[^\x27\\])*\x27)\s*,\s*["\x27](done|no|progress|none)["\x27]\s*\]/g;for(const m of section[1].matchAll(regex)){let name;try{name=m[1][0]==='"'?JSON.parse(m[1]):m[1].slice(1,-1)}catch{continue}results.push({name,status:m[2],category})}}return results}
$('watchFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>5e6)throw Error('Файл слишком большой');const text=await file.text();let parsed;if(/\.html?$/i.test(file.name)||/^\s*<!doctype html/i.test(text)){parsed=watchParseLegacy(text)}else{const data=JSON.parse(text);parsed=Array.isArray(data)?data:data.items}if(!Array.isArray(parsed)||!parsed.length)throw Error('Не удалось найти фильмы в файле');const entries=watchNormalize(parsed);if(!entries.length)throw Error('Нет подходящих записей');if(confirm('Импортировать '+entries.length+' записей? Нажми ОК, чтобы добавить к текущему списку.')){watchItems.push(...entries);watchSave();$('watchlist').open=true;toast('Импортировано: '+entries.length)}}catch(err){alert('Ошибка импорта: '+err.message)}finally{e.target.value=''}};
$('watchExport').onclick=()=>{const blob=new Blob([JSON.stringify({version:1,items:watchItems},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='remedium-cinema-watchlist.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000)};
watchRender();


// Shared cosmic features
let sharedCinemaHistory=[];
let currentCinemaPoll=null;
let latestCinemaMedia=null;
let cinemaParticipants=[];
let historyRequested=false;
const featureEl=id=>document.getElementById(id);
const safeText=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el};
function showWish(data){
 if(!data?.text)return;
 const el=document.createElement('div');el.className='wish-visual';
 el.append(safeText('div',data.name+' ✧ '+data.text));
 document.body.append(el);setTimeout(()=>el.remove(),5100);
}
featureEl('wishOpen').onclick=()=>{
 if(!room)return toast('Сначала войдите в комнату');
 const wish=prompt('Напиши тайное послание ♡ — его увидит только получатель после открытия');
 if(wish?.trim())socket.emit('wish',wish.trim().slice(0,140));
};
let wishMessages=[];
function renderWishInbox(){
 const unread=wishMessages.filter(x=>!x.read).length;
 const badge=featureEl('wishBadge');badge.hidden=!unread;badge.textContent='+'+unread;
 const list=featureEl('wishLetters');list.replaceChildren();
 if(!wishMessages.length){list.append(safeText('div','Пока нет посланий ✧'));return}
 for(const item of wishMessages.slice().reverse()){
  const row=document.createElement('div');row.className='feature-entry';
  row.append(safeText('span',item.read?'✧ '+item.name+': '+item.text:'✉ Запечатанное послание от '+item.name));
  if(!item.read){const btn=document.createElement('button');btn.className='btn';btn.textContent='Открыть';btn.onclick=()=>socket.emit('wish-read',item.id);row.append(btn)}
  list.append(row);
 }
}
featureEl('wishInboxOpen').onclick=()=>{if(!room)return toast('Сначала войдите в комнату');const box=featureEl('wishInbox');box.hidden=!box.hidden};
socket.on('wish-inbox',items=>{wishMessages=Array.isArray(items)?items:[];renderWishInbox()});
socket.on('wish-opened',showWish);
socket.on('wish-sent',()=>toast('Послание отправлено ✧'));
socket.on('wish-error',msg=>toast(msg));
renderWishInbox();
function renderCinemaHistory(){
 const target=featureEl('historyList');target.replaceChildren();
 for(const item of sharedCinemaHistory.slice(0,60)){
  const row=document.createElement('div');row.className='feature-entry';
  row.append(safeText('span',(item.title||'Видео')+' · '+new Date(item.at).toLocaleDateString('ru-RU')));
  target.append(row);
 }
 if(!sharedCinemaHistory.length)target.append(safeText('div','Пока нет просмотров'));
}
socket.on('cinema-history',data=>{if(!Array.isArray(data))return;sharedCinemaHistory=data;renderCinemaHistory()});
featureEl('historyExport').onclick=()=>{
 const blob=new Blob([JSON.stringify({history:sharedCinemaHistory},null,2)],{type:'application/json'});
 const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='remedium-cinema-history.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
};
featureEl('pollCreate').onclick=()=>{
 if(!room)return toast('Сначала войдите в комнату');
 const values=featureEl('pollOptions').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,8);
 if(values.length<2)return toast('Нужно хотя бы два фильма');
 socket.emit('poll-create',values);
};
function renderCinemaPoll(){
 const target=featureEl('pollResults');target.replaceChildren();
 if(!currentCinemaPoll){target.append(safeText('div','Пока нет голосования'));return}
 const votes=Object.values(currentCinemaPoll.votes||{});
 currentCinemaPoll.options.forEach((option,i)=>{
  const row=document.createElement('div');row.className='feature-entry';
  row.append(safeText('span',option+' · '+votes.filter(v=>v===i).length+' голос(ов)'));
  const button=document.createElement('button');button.type='button';button.className='btn';button.textContent='Выбрать';
  button.onclick=()=>socket.emit('poll-vote',i);row.append(button);target.append(row);
 });
}
socket.on('room-state',state=>{
 if(!room)return;
 cinemaParticipants=state.users||[];
 const connected=cinemaParticipants.length>=2;
 featureEl('twinStars').classList.toggle('connected',connected);
 featureEl('starsLabel').textContent=connected?'Две звезды встретились ♡':'Ждём вторую звезду';
 currentCinemaPoll=state.poll||null;latestCinemaMedia=state.media||null;renderCinemaPoll();
 if(!historyRequested){historyRequested=true;socket.emit('get-cinema-history')}
});
socket.on('disconnect',()=>{historyRequested=false});
renderCinemaHistory();renderCinemaPoll();
