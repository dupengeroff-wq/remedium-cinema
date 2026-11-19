const $=id=>document.getElementById(id);
const socket=io({autoConnect:false});
const video=$('video');
const cinemaMenu=$('cinemaMenu');
const sharedVideoPrefix='Видео из кинозала\n';
CinemaNav.watchUnread(socket);
let room = '', selfPublicId = '', isHost = false, inRoom = false;
let inviting = false;
let serverOffset = 0;
let media = null, mediaId = null, syncVersion = -1;
let ytPlayer = null, vkPlayer = null, generation = 0;
let lastSync = 0, clock = 0, playingState = false, knownDuration = 0;
let muted = false, messages = [], chatId = null;
let mediaReady = false, mediaTimer = null, playbackTimer = null;
let pendingSync = null, pendingAction = null, pendingSeek = null;
let guestPlayback = null, autoplayMuted = false, playbackPrompt = '';
let vkPauseTime = null, vkRestoring = false;
let vkRecommendationsDismissed = false;
let chatAttempt = null, sendingChat = null;
const playerScripts = new Map();
let badge = '🎀';
const BADGES = ['🎀', '🐈', '🦊', '💖', '🐒'];
const REACTIONS = ['🔥', '🥹', '😍', '🤤', '❤️'];
const params = new URLSearchParams(location.search);
const sessionStorageFallback = new Map();

function storageGet(key) {
  if (sessionStorageFallback.has(key)) return sessionStorageFallback.get(key);
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    sessionStorageFallback.delete(key);
    return true;
  } catch {
    sessionStorageFallback.set(key, value);
    return false;
  }
}

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

video.muted = false;
video.volume = 1;
function toast(text) {
  const message = $('toast');
  const container = document.querySelector('.cinema-tool[open]') || document.body;
  if (message.parentElement !== container) container.append(message);
  message.textContent = text;
  message.style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').style.display = 'none', 3200);
}
function playerStatus(text='') {
  $('playerStatus').textContent=text;
  $('playerStatus').classList.toggle('hidden',!text);
}
function setPlaybackPrompt(mode = '', hint = 'Нажми ▶ внутри плеера') {
  playbackPrompt = mode;
  const button = $('soundPrompt');
  button.classList.toggle('hidden', mode !== 'start' && mode !== 'sound');
  button.textContent = mode === 'sound' ? 'Включить звук' : isHost ? '▶ Запустить видео' : '▶ Присоединиться к просмотру';
  const nativeHint = $('nativePlaybackHint');
  nativeHint.textContent = mode === 'native' ? hint : '';
  nativeHint.classList.toggle('hidden', mode !== 'native');
}
function waitingForPlaybackTap() {
  return playbackPrompt === 'start' || playbackPrompt === 'native';
}
function refreshSoundButton(){window.CinemaUI.setMuted(muted || autoplayMuted)}
function applyVolume(){
  const silent = muted || autoplayMuted;
  video.muted=silent;video.volume=1;
  try {
    if(mediaReady&&media?.type==='youtube'&&ytPlayer){
      if(silent)ytPlayer.mute();else{ytPlayer.unMute();ytPlayer.setVolume(100)}
    }
    if(mediaReady&&media?.type==='vk'&&vkPlayer){
      if(silent)vkPlayer.mute();else{vkPlayer.unmute();vkPlayer.setVolume(1)}
    }
  }catch(e){console.warn('Volume:',e)}
  refreshSoundButton();
}
function resumeLocalPlayback(){
  if (!mediaReady || !inRoom) return;
  const shouldPlay = isHost ? waitingForPlaybackTap() || getPlaying() : guestPlayback?.playing;
  const needsStart = !getPlaying() || waitingForPlaybackTap();
  autoplayMuted = false;
  muted = false;
  setPlaybackPrompt();
  applyVolume();
  if (!shouldPlay || !needsStart) return;
  if (media?.type === 'vk' && !$('vkRecovery').hidden) {
    recoverVkPlayback(true);
    return;
  }
  if (!isHost) syncPlayerPosition(guestPlayback);
  // Playback must be requested directly in the tap handler.
  commandPlayback(true, true);
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
function armPlayerTimeout(g) {
  clearTimeout(mediaTimer);
  mediaTimer = setTimeout(() => {
    if (g !== generation || mediaReady) return;
    if (media?.type === 'vk' || media?.type === 'youtube') {
      playerStatus();
      setPlaybackPrompt('native', 'Нажми ▶ внутри плеера. Синхронизация пока недоступна.');
    } else {
      playerStatus('Видео не загрузилось. Проверь ссылку и доступ к видеосервису.');
    }
  }, 18000);
}

function playerReady(g) {
  if (g !== generation || mediaReady) return;
  mediaReady = true;
  clearTimeout(mediaTimer);
  playerStatus();
  setPlaybackPrompt();
  knownDuration = getDuration();
  applyVolume();
  updateHost();
  const snapshot = pendingSync;
  pendingSync = null;
  if (snapshot) applySync(snapshot);
  if (!isHost && inRoom && socket.connected) socket.emit('request-sync');
}

function playbackEvent(playing, g, ended=false, position=getTime()) {
  if (g !== generation || !mediaReady) return;
  if (!isHost && playing && guestPlayback?.playing === false) {
    if (pendingAction?.playing !== false) commandPlayback(false);
    return;
  }
  const starting = pendingAction?.playing === true;
  if (pendingAction?.playing === playing) clearPlaybackAttempt();
  playingState = playing;
  if (playing) {
    if (!isHost && guestPlayback?.playing && (waitingForPlaybackTap() || !starting)) {
      syncPlayerPosition(guestPlayback);
    }
    setPlaybackPrompt(autoplayMuted ? 'sound' : '');
    playerStatus();
  } else if (!isHost && inRoom && guestPlayback?.playing && !starting) {
    setPlaybackPrompt('start');
  }
  emitPlayback(position, playing, false, ended);
  if (!playing) reportWatch(false);
  updateTimeline();
}

let viewer=null;
let roomTarget={room:params.get('room')||undefined,invite:params.get('invite')||undefined};
let joinFlight=0;

function openCinemaPanel(panel) {
  if (panel.open) return;
  CinemaNav.setOpen(false, panel.id !== 'movieInvite');
  if (panel.id === 'wishCompose') {
    if (!inRoom) return toast('Сначала войди в комнату');
    $('wishText').value = '';
    $('wishStatus').textContent = '';
  }
  document.querySelector('.cinema-tool[open]')?.close();
  panel.showModal();
  panel.querySelector('.cinema-tool-body').scrollTop = 0;
  cinemaMenu.querySelector('[data-open-panel="'+panel.id+'"]')?.setAttribute('aria-expanded','true');
  if (panel.id === 'watchlist') watchRender();
  if (panel.id === 'roulettePanel') refreshRouletteView();
}

cinemaMenu.addEventListener('click', event => {
  const entry = event.target.closest('[data-open-panel]');
  if (!entry) return;
  event.preventDefault();
  openCinemaPanel($(entry.dataset.openPanel));
});

for (const panel of document.querySelectorAll('.cinema-tool')) {
  for (const button of panel.querySelectorAll('[data-close-panel]')) {
    button.onclick = () => panel.close();
  }
  panel.addEventListener('click', event => {
    if (event.target !== panel) return;
    const {left, right, top, bottom} = panel.getBoundingClientRect();
    if (event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom) panel.close();
  });
  panel.addEventListener('close', () => {
    if (panel.open) return;
    cinemaMenu.querySelector('[data-open-panel="'+panel.id+'"]')?.setAttribute('aria-expanded','false');
    const message = $('toast');
    if (message.parentElement === panel) document.body.append(message);
  });
}

function enterRoom() {
  if(!viewer || !socket.connected || inRoom || joinFlight) return;
  const flight=Date.now()||1;
  joinFlight=flight;
  const sent=Date.now();
  $('entryStatus').textContent='Открываем кинозал…';
  socket.timeout(12000).emit('join',roomTarget,(error,response)=>{
    if(joinFlight!==flight) return;
    joinFlight=0;
    if(error || !response?.ok){
      $('entry').classList.remove('hidden');
      const status=$('entryStatus');
      status.textContent=response?.error||'Связь с комнатой не установилась.';
      status.append(document.createTextNode(' '),
        RC.button(roomTarget.room?'Открыть мой кинозал':'Повторить',()=>{
          roomTarget={};
          enterRoom();
        }));
      return;
    }
    const id=response.state?.room;
    if(typeof id!=='string') return;
    if(room!==id) resetRoomView();
    room=id;
    selfPublicId=response.id;
    isHost=!!response.isHost;
    inRoom=true;
    syncVersion=-1;
    roomTarget=isHost?{}:{room:id};
    if(Number.isFinite(response.state.serverTime)){
      serverOffset=response.state.serverTime-(sent+Date.now())/2;
    }
    CinemaNav.setRoom(isHost?null:id);
    history.replaceState(null,'',location.pathname+(isHost?'':'?room='+encodeURIComponent(id))+location.hash);
    $('entry').classList.add('hidden');
    $('roomInfo').textContent='КОМНАТА · '+id;
    $('status').textContent='Подключено';
    $('status').classList.add('is-online');
    wishMessages=response.inbox||[];
    renderWishInbox();
    applyRoomState(response.state,true);
    if(location.hash) openLinkedPanel();
  });
}

function showAccountForm() {
  document.querySelector('.cinema-tool[open]')?.close();
  viewer=null;
  resetChat();
  $('entry').classList.remove('hidden');
  CinemaNav.show(false);
  CinemaNav.clearUnread();
  CinemaNav.setRoom(null);
  $('entryStatus').textContent='';
  RC.mount($('accountEntry'),openAccount);
}
function openAccount(user) {
  viewer=user;
  CinemaNav.setUser(user);
  $('accountEntry').replaceChildren();
  CinemaNav.show(true);
  $('entryStatus').textContent='Подключаемся…';
  if(socket.connected) enterRoom();
  else socket.connect();
}
async function initAccount() {
  try {
    const {user}=await RC.api('/api/auth/me');
    if(user) openAccount(user);
    else showAccountForm();
  } catch (error) {
    $('entryStatus').textContent=error.message;
    $('entryStatus').append(RC.button('Повторить',initAccount));
  }
}

async function request(event, data) {
  if (!inRoom || !socket.connected) return {ok: false, error: 'Соединение с комнатой восстанавливается'};
  return new Promise(resolve => {
    socket.timeout(7000).emit(event, data, (error, result) => {
      resolve(error ? {ok: false, error: 'Сервер не подтвердил действие. Попробуй ещё раз.'} : result || {ok: false});
    });
  });
}

$('invite').onclick = async () => {
  if (!inRoom || !isHost || inviting) return;
  inviting = true;
  updateHost();
  const id = room;
  const result = await request('invite', null);
  inviting = false;
  updateHost();
  if (id !== room) return;
  if (!result.ok) return toast(result.error || 'Не удалось создать приглашение');
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('room', id);
  url.searchParams.set('invite', result.invite);
  if (navigator.share) {
    try {
      await navigator.share({url: url.href});
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url.href);
    toast('Ссылка скопирована');
  } catch {
    prompt('Скопируй ссылку приглашения', url.href);
  }
};

const movieInvite = $('movieInvite');
const movieInviteStatus = $('movieInviteStatus');
const movieInviteFriends = $('movieInviteFriends');
let invitePickerVersion = 0;

$('shareMovie').onclick = async () => {
  if (!inRoom || !media || !mediaId) return;
  const version = ++invitePickerVersion;
  const selectedRoom = room;
  const selectedFilm = mediaId;
  const shareAsHost = isHost;
  const body = sharedVideoPrefix + media.url;
  $('movieInviteTitle').textContent = shareAsHost ? 'Пригласить друга на фильм' : 'Поделиться видео с другом';
  movieInviteStatus.textContent = 'Загружаем друзей…';
  movieInviteFriends.replaceChildren();
  openCinemaPanel(movieInvite);
  try {
    const {people} = await RC.api('/api/friends');
    if (!movieInvite.open || version !== invitePickerVersion) return;
    const friends = people.filter(person => person.relationship === 'friend');
    movieInviteStatus.textContent = friends.length ? '' : 'Пока нет друзей.';
    for (const person of friends) {
      const row = RC.el('div', null, 'movie-invite-friend');
      const identity = RC.el('div');
      identity.append(RC.el('strong', person.nickname), RC.el('small', '@' + person.login));
      const clientId = crypto.randomUUID();
      const send = RC.button('Отправить', async () => {
        if (!inRoom || room !== selectedRoom || isHost !== shareAsHost || mediaId !== selectedFilm) {
          movieInviteStatus.textContent = 'Фильм сменился. Открой приглашение заново.';
          return;
        }
        if (!shareAsHost && body.length > 2000) {
          movieInviteStatus.textContent = 'Ссылка слишком длинная для личного сообщения.';
          return;
        }
        const buttons = movieInviteFriends.querySelectorAll('button');
        for (const button of buttons) button.disabled = true;
        movieInviteStatus.textContent = 'Отправляем…';
        try {
          let dialog;
          if (shareAsHost) {
            dialog = await RC.api('/api/friends/' + encodeURIComponent(person.id) + '/invite', {method:'POST'});
          } else {
            dialog = await RC.api('/api/dialogs', {method:'POST', body:{userId:person.id}});
            await RC.api('/api/dialogs/' + dialog.id + '/messages', {method:'POST', body:{body,clientId}});
          }
          const sent = shareAsHost ? 'Приглашение отправлено.' : 'Ссылка на видео отправлена.';
          toast(sent);
          if (!movieInvite.open || version !== invitePickerVersion) return;
          const openDialog = RC.link('Открыть диалог', '/messages/' + dialog.id, 'btn message-dialog-link');
          openDialog.prepend(CinemaNav.messageIcon());
          movieInviteStatus.replaceChildren(sent + ' ', openDialog);
          movieInviteFriends.replaceChildren();
        } catch (error) {
          if (!movieInvite.open || version !== invitePickerVersion) return;
          movieInviteStatus.textContent = error.message;
          for (const button of buttons) button.disabled = false;
        }
      });
      send.setAttribute('aria-label', (shareAsHost ? 'Отправить приглашение: ' : 'Отправить ссылку: ') + person.nickname);
      row.append(identity, send);
      movieInviteFriends.append(row);
    }
  } catch (error) {
    if (movieInvite.open && version === invitePickerVersion) movieInviteStatus.textContent = error.message;
  }
};

const finishDialog=$('finishMovieDialog');
let finishMediaId=null;
let finishingMovie=false;

function playerIsFullscreen(){
  return Boolean(document.fullscreenElement||document.webkitFullscreenElement
    ||video.webkitDisplayingFullscreen||$('playerShell').classList.contains('is-fullscreen'));
}

function canFinishMovie(){
  return inRoom&&isHost&&Boolean(mediaId);
}

$('finishMovie').onclick=()=>{
  if(!canFinishMovie()||playerIsFullscreen()||finishingMovie||finishDialog.open) return;
  finishMediaId=mediaId;
  $('finishMovieStatus').textContent='';
  finishDialog.showModal();
};
$('continueMovie').onclick=()=>finishDialog.close();
$('finishMovieForm').onsubmit=async event=>{
  event.preventDefault();
  if(finishingMovie||!finishDialog.open||!canFinishMovie()||playerIsFullscreen()||finishMediaId!==mediaId) return;
  finishingMovie=true;
  $('confirmFinishMovie').disabled=true;
  try {
    const response=await request('watch-finish',{mediaId:finishMediaId});
    if(response.ok) finishDialog.close();
    else $('finishMovieStatus').textContent=response.error||'Не удалось завершить фильм.';
  } finally {
    finishingMovie=false;
    $('confirmFinishMovie').disabled=false;
  }
};
function closeFinishOnFullscreen(){
  if(finishDialog.open&&playerIsFullscreen()) finishDialog.close();
}
document.addEventListener('fullscreenchange',closeFinishOnFullscreen);
document.addEventListener('webkitfullscreenchange',closeFinishOnFullscreen);
video.addEventListener('webkitbeginfullscreen',()=>finishDialog.close());

function updateHost() {
  const canControl = inRoom && isHost;
  document.body.classList.toggle('guest-view', !isHost);
  $('myBadge').classList.toggle('hidden', isHost);
  $('myBadge').textContent = badge;
  $('roomInviteActions').hidden = !isHost;
  $('movieSetup').hidden = !isHost;
  $('invite').disabled = !canControl || inviting;
  $('load').disabled = !canControl;
  $('url').disabled = !canControl;
  const shareLabel = isHost ? 'Пригласить друга на фильм' : 'Поделиться видео с другом';
  $('shareMovie').hidden = !inRoom || !media;
  $('finishMovie').hidden = !canFinishMovie();
  if(finishDialog.open && (!canFinishMovie() || finishMediaId!==mediaId)) finishDialog.close();
  $('shareMovie').title = shareLabel;
  $('shareMovie').setAttribute('aria-label', shareLabel);
  $('playerShell').classList.toggle('has-media', !!media);
  for (const id of ['play', 'back', 'forward', 'progress']) {
    $(id).disabled = !canControl || !media || !mediaReady;
  }
  $('role').hidden = !inRoom || !viewer;
  $('roleName').textContent = viewer ? 'Вы: ' + viewer.nickname : '';
  $('roleCrown').hidden = !isHost;
  $('sound').disabled = !mediaReady || !inRoom;
  $('full').disabled = !media;
  $('message').disabled = !inRoom;
  $('send').disabled = !inRoom || !!sendingChat;
  video.controls = true;
  refreshSoundButton();
  updateVkRecovery();
}

$('load').onclick = async () => {
  const url = $('url').value.trim();
  if (!url) return toast('Вставь ссылку на видео');
  const response=await request('media',{url});
  if (!response.ok) toast(response.error || 'Не удалось загрузить видео');
};

function showMedia(m, recovery = null){
  const g=++generation;
  mediaReady=false;pendingSync=recovery;pendingSeek=null;
  guestPlayback=isHost?null:recovery;
  if(!recovery)autoplayMuted=false;
  clearTimeout(mediaTimer);
  clearPlaybackAttempt();
  video.onloadedmetadata=null;video.oncanplay=null;video.onerror=null;
  try{video.pause()}catch{}
  try{ytPlayer?.destroy()}catch{}
  try{vkPlayer?.destroy()}catch{}
  ytPlayer=null;vkPlayer=null;
  video.removeAttribute('src');video.load();video.style.display='none';
  $('yt').style.display='none';$('vk').style.display='none';
  $('yt').replaceChildren();$('vk').replaceChildren();
  knownDuration=0;playingState=false;
  clock=recovery?syncPosition(recovery):0;
  vkPauseTime=recovery?clock:null;
  vkRestoring=!!recovery;
  vkRecommendationsDismissed=recovery?.dismissed===true;
  refreshSoundButton();setPlaybackPrompt();
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
      clearTimeout(mediaTimer);clearPlaybackAttempt();mediaReady=false;playingState=false;
      setPlaybackPrompt();updateHost();updateTimeline();
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
          onStateChange:e=>{if(e.data===1)playbackEvent(true,g);else if(e.data===0||e.data===2)playbackEvent(false,g,e.data===0)},
          onAutoplayBlocked:()=>{if(g===generation) reportAutoplayBlocked()},
          onError:e=>{
            if(g!==generation)return;
            clearTimeout(mediaTimer);clearPlaybackAttempt();mediaReady=false;playingState=false;
            setPlaybackPrompt();updateHost();updateTimeline();
            playerStatus([101,150].includes(e.data)?'Автор запретил встраивание этого видео. Выбери другую ссылку.':'YouTube не смог открыть видео. Проверь ссылку и доступность ролика.');
          }
        }
      });
    }).catch(e=>{
      if(g!==generation)return;
      console.warn(e);clearTimeout(mediaTimer);
      playerStatus('Не удалось загрузить YouTube API. Проверь соединение и блокировщики.');
    });
    return;
  }
  if(m.type==='vk'){
    const frame=document.createElement('iframe');
    const embed=new URL(m.embed);
    if (new URL(m.url).hostname.replace(/^(www|m)\./, '') === 'vkvideo.ru') {
      embed.hostname = 'vkvideo.ru';
    }
    embed.searchParams.set('js_api','1');
    frame.src=embed.href;frame.title='VK Видео';frame.allow='autoplay; encrypted-media; fullscreen; picture-in-picture';
    frame.allowFullscreen=true;frame.referrerPolicy='strict-origin-when-cross-origin';
    $('vk').append(frame);$('vk').style.display='block';
    loadPlayerScript('vkapi','https://vkvideo.ru/js/api/videoplayer.js',()=>!!window.VK?.VideoPlayer).then(()=>{
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
      vkPlayer.on('seeked',data=>{
        if(g!==generation)return;
        observe(data);
        if(vkPauseTime!==null && (!vkRestoring || getTime()>0))vkPauseTime=getTime();
        sendSync(true);
      });
      for(const event of ['started','resumed'])vkPlayer.on(event,data=>{
        if(g!==generation)return;
        observe(data);vkRecommendationsDismissed=false;
        if(!mediaReady)playerReady(g);
        // Some embeds defer seeking until playback starts.
        if(vkRestoring && (isHost || guestPlayback?.playing)){
          vkRestoring=false;
          pendingSeek=null;
          syncPlayerPosition(isHost?{time:vkPauseTime,seek:true}:guestPlayback);
        }
        vkPauseTime=null;
        playbackEvent(true,g);
      });
      for(const event of ['paused','ended'])vkPlayer.on(event,data=>{
        if(g!==generation)return;
        const previousTime=clock;
        observe(data);
        const time=getTime();
        const duration=getDuration();
        const ended=event==='ended'&&duration>0&&Math.max(time,previousTime)>=duration-2;
        if(playingState || vkPauseTime!==null){
          vkPauseTime=ended?0:(time || (pendingSeek?0:vkPauseTime??previousTime));
        }
        playbackEvent(false,g,ended,ended?duration:time);
      });
      vkPlayer.on('recommendationsLoaded',data=>{
        if(g!==generation || !mediaReady || getPlaying() || !data?.videos?.length)return;
        vkRecommendationsDismissed=false;
        vkPauseTime??=getTime();
        updateVkRecovery();
      });
      vkPlayer.on('volumechange',data=>{
        if(g!==generation||autoplayMuted||typeof data?.muted!=='boolean')return;
        muted=data.muted;refreshSoundButton();
      });
      vkPlayer.on('autoplaySoundProhibited',()=>{
        if (g === generation && !autoplayMuted && !muted) reportAutoplayBlocked();
      });
      vkPlayer.on('error',()=>{
        if(g!==generation)return;
        clearTimeout(mediaTimer);clearPlaybackAttempt();mediaReady=false;playingState=false;
        setPlaybackPrompt();updateHost();updateTimeline();
        playerStatus('VK не может воспроизвести ролик. Проверь доступ к нему и разрешение на встраивание.');
      });
      // The SDK can be attached after the iframe has already initialized.
      // Its cached state is usable only after a real state/duration arrives.
      if(vkPlayer.getDuration?.()>0||['playing','paused','ended'].includes(vkPlayer.getState?.()))playerReady(g);
    }).catch(e=>{
      if(g!==generation)return;
      console.warn(e);clearTimeout(mediaTimer);
      playerStatus();
      setPlaybackPrompt('native','Нажми ▶ внутри VK Видео. Синхронизация пока недоступна.');
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
    if(media?.type==='video')return !video.paused&&!video.ended&&(video.readyState>=3||playingState);
  }catch{}
  return playingState;
}
function emitPlayback(time, playing, seek = false, ended = false) {
  if (!inRoom || !socket.connected || !isHost || !mediaId) return;
  socket.emit('sync', {mediaId, time:finiteTime(time),duration:getDuration(),playing,seek,ended});
  lastSync = Date.now();
}

function sendSync(seek = false) {
  if (!mediaReady || !isHost) return;
  clock = getTime();
  playingState = getPlaying();
  emitPlayback(clock, playingState, seek);
  updateTimeline();
}

function clearPlaybackAttempt() {
  clearTimeout(playbackTimer);
  pendingAction = null;
}

function reportAutoplayBlocked(action = pendingAction) {
  if (!mediaReady || !inRoom || (action && pendingAction !== action)) return;
  if (action?.playing === false || (!action && waitingForPlaybackTap()) || (!isHost && !guestPlayback?.playing)) return;
  if (action?.recoverVk) {
    // VK has no command to dismiss its recommendation screen. Recreate the same embed at the saved time.
    const state = isHost ? action.recoverVk : guestPlayback;
    showMedia(media, {...state, seek:true});
    return;
  }
  clearPlaybackAttempt();

  if (!isHost && !action?.fromTap && !muted && !autoplayMuted) {
    autoplayMuted = true;
    applyVolume();
    commandPlayback(true);
    return;
  }
  if (media.type === 'video' || !action?.fromTap) setPlaybackPrompt('start');
  else setPlaybackPrompt('native');
  if (isHost) sendSync();
  updateTimeline();
}

function commandPlayback(playing, fromTap = false, recoverVk = null) {
  const action = {playing, fromTap, recoverVk};
  clearPlaybackAttempt();
  pendingAction = action;
  playbackTimer = setTimeout(() => {
    if (pendingAction !== action) return;
    if (playing && !getPlaying()) {
      reportAutoplayBlocked(action);
      return;
    }
    clearPlaybackAttempt();
    if (playing) setPlaybackPrompt(autoplayMuted ? 'sound' : '');
    if (isHost) sendSync();
    updateTimeline();
  }, 4200);
  try {
    if (media.type === 'video') {
      if (playing) {
        video.play().catch(error => {
          if (pendingAction !== action) return;
          if (error.name === 'NotAllowedError') reportAutoplayBlocked(action);
          else {
            clearPlaybackAttempt();
            if (error.name !== 'AbortError') playerStatus('Не удалось запустить видео. Проверь доступность ссылки.');
            if (isHost) sendSync();
            updateTimeline();
          }
        });
      } else {
        video.pause();
      }
    } else if (media.type === 'youtube') {
      if (playing) ytPlayer.playVideo();
      else ytPlayer.pauseVideo();
    } else if (media.type === 'vk') {
      if (playing) vkPlayer.play();
      else vkPlayer.pause();
    }
  } catch (error) {
    console.warn('Playback:', error);
    if (playing) reportAutoplayBlocked(action);
    else clearPlaybackAttempt();
  }
}

function syncPosition(snapshot) {
  const {playing, serverTime} = snapshot;
  const elapsed = playing && Number.isFinite(serverTime)
    ? Math.max(0, Date.now() + serverOffset - serverTime) / 1000 : 0;
  return Math.min(finiteTime(snapshot.time) + elapsed, getDuration() || Infinity);
}

function syncPlayerPosition(snapshot) {
  const time = syncPosition(snapshot);
  const tolerance = snapshot.seek ? 0.05 : snapshot.playing ? 1.25 : 0.25;
  if (Math.abs(getTime() - time) > tolerance) {
    try {
      if (media.type === 'video') video.currentTime = time;
      if (media.type === 'youtube') ytPlayer.seekTo(time, true);
      if (media.type === 'vk') vkPlayer.seek(time);
      pendingSeek = {time, until: Date.now() + 800};
    } catch (error) {
      console.warn('Seek:', error);
    }
  }
  clock = time;
}

function applySync(snapshot) {
  if (!inRoom || snapshot?.room !== room || !media || snapshot.mediaId !== mediaId
      || snapshot.version < syncVersion) return;
  syncVersion = snapshot.version;
  if (!isHost) guestPlayback = snapshot;
  if (!mediaReady) {
    pendingSync = snapshot;
    clock = syncPosition(snapshot);
    updateTimeline();
    return;
  }
  const {playing} = snapshot;
  if (!playing && waitingForPlaybackTap()) setPlaybackPrompt(autoplayMuted ? 'sound' : '');
  const intended = pendingAction?.playing ?? getPlaying();
  const waiting = !isHost && playing && waitingForPlaybackTap();
  if (!waiting) {
    syncPlayerPosition(snapshot);
    if (intended !== playing || (!playing && media.type === 'youtube' && pendingSeek)) commandPlayback(playing);
  }
  updateTimeline();
}

function updateVkRecovery() {
  const show = inRoom && mediaReady && media?.type === 'vk' && vkPauseTime !== null
    && !(pendingAction?.playing ?? getPlaying());
  const canResume = isHost || guestPlayback?.playing;
  $('vkRecovery').hidden = !show || (vkRecommendationsDismissed && !canResume);
  $('vkDismiss').hidden = vkRecommendationsDismissed;
  $('vkContinue').hidden = !canResume;
}

function recoverVkPlayback(resume) {
  if ($('vkRecovery').hidden || (!isHost && !guestPlayback) || (resume && $('vkContinue').hidden)) return;
  const state = isHost
    ? {room, mediaId, version:syncVersion, time:vkPauseTime, playing:resume, seek:true}
    : {...guestPlayback, seek:true};
  if (resume) {
    setPlaybackPrompt();
    syncPlayerPosition(state);
    commandPlayback(true, true, state);
    updateTimeline();
  } else {
    showMedia(media, {...state, dismissed:true});
  }
}
$('vkDismiss').onclick = () => recoverVkPlayback(false);
$('vkContinue').onclick = () => recoverVkPlayback(true);

function formatTime(n){n=Math.max(0,Math.floor(Number(n)||0));const h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=n%60;return(h?h+':':'')+String(m).padStart(h?2:1,'0')+':'+String(s).padStart(2,'0')}
function updateTimeline(){
  const t=getTime(),d=getDuration(),playing=pendingAction?.playing??getPlaying();
  $('elapsed').textContent=formatTime(t);$('duration').textContent=formatTime(d);
  $('progress').max=d||100;$('progress').value=Math.min(d||100,t);
  window.CinemaUI.setPlaying(playing);
  updateVkRecovery();
}
function seekTo(t){
  if(!inRoom||!isHost||!media||!mediaReady)return;
  const duration=getDuration();t=Math.max(0,Math.min(duration||Infinity,finiteTime(Number(t))));
  try{
    if(media.type==='video')video.currentTime=t;
    if(media.type==='youtube')ytPlayer.seekTo(t,true);
    if(media.type==='vk')vkPlayer.seek(t);
    clock=t;pendingSeek={time:t,until:Date.now()+800};
    emitPlayback(t,getPlaying(),true);updateTimeline();
  }catch(e){console.warn(e);toast('Плеер не смог перемотать видео. Попробуй ещё раз.')}
}
$('play').onclick=()=>{
  if(!inRoom||!isHost||!media||!mediaReady)return;
  const shouldPlay=!(pendingAction?.playing??getPlaying());
  commandPlayback(shouldPlay, true);
  updateTimeline();
};
$('back').onclick=()=>seekTo(getTime()-10);
$('forward').onclick=()=>seekTo(getTime()+10);
$('progress').onchange=e=>seekTo(Number(e.target.value));
for(const event of ['playing','pause','ended'])video.addEventListener(event,()=>{
  if(event==='pause'&&video.ended)return;
  if(media?.type==='video'&&mediaReady)playbackEvent(!video.paused&&!video.ended,generation,event==='ended');
});
video.addEventListener('seeked',()=>sendSync(true));
for(const event of ['seeking','waiting','stalled'])video.addEventListener(event,()=>reportWatch(false));
$('sound').onclick=()=>{
  if(!mediaReady)return;
  if (muted || autoplayMuted || waitingForPlaybackTap()) resumeLocalPlayback();
  else { muted = true; applyVolume(); }
};
$('soundPrompt').onclick=resumeLocalPlayback;
function isMine(msg){return !!selfPublicId&&msg.author===selfPublicId}
function badgeFor(msg){return msg.isHost?'👑':msg.badge||'🎀'}
function openBadgePicker(){
  $('pickerTitle').textContent='Твой космический знак';
  $('pickerHint').textContent='Нажми, чтобы заменить бантик';
  const choices=$('pickerChoices');
  choices.replaceChildren();
  for(const emoji of BADGES){
    const option=RC.button(emoji,async ()=>{
      closePicker();
      const result=await request('set-badge',emoji);
      if(!result.ok)toast(result.error||'Не удалось изменить значок');
    });
    option.className='choice';
    choices.append(option);
  }
  $('pickerOverlay').classList.remove('hidden');
}
$('myBadge').onclick=()=>{if(!isHost)openBadgePicker()};
function closePicker(){$('pickerOverlay').classList.add('hidden')}
$('pickerClose').onclick=closePicker;
$('pickerOverlay').onclick=event=>{if(event.target===$('pickerOverlay'))closePicker()};
document.addEventListener('keydown',event=>{if(event.key==='Escape')closePicker()});
function nameElement(msg){const stack=document.createElement('div');stack.className='name-stack';const badgeEl=document.createElement(!msg.isHost&&isMine(msg)?'button':'span');badgeEl.className='badge-icon'+(!msg.isHost&&isMine(msg)?' editable':'');badgeEl.textContent=badgeFor(msg);if(badgeEl.tagName==='BUTTON'){badgeEl.type='button';badgeEl.title='Изменить значок';badgeEl.onclick=openBadgePicker}stack.append(badgeEl);const name=document.createElement('span');name.className='msgname';name.textContent=msg.name;stack.append(name);return stack}
function renderReactions(msg,container){container.replaceChildren();for(const emoji of REACTIONS){const tokens=msg.reactions?.[emoji]||[];if(!tokens.length)continue;const b=document.createElement('button');b.type='button';b.className='reaction-pill'+(tokens.includes(selfPublicId)?' mine':'');b.textContent=emoji+' '+tokens.length;b.title='Изменить реакцию';b.onclick=()=>request('react',{id:msg.id,emoji}).then(res=>{if(!res.ok)toast(res.error||'Не удалось поставить реакцию')});container.append(b)}}
let reactionPanel=null,reactionAnchor=null;
function hideReactions(restore=false){
  reactionPanel?.remove();
  reactionAnchor?.setAttribute('aria-expanded','false');
  if(restore&&reactionAnchor?.isConnected)reactionAnchor.focus({preventScroll:true});
  reactionPanel=reactionAnchor=null;
}
function showReactions(anchor,msg){
  const same=anchor===reactionAnchor;
  hideReactions();
  if(same||!inRoom)return;
  reactionAnchor=anchor;
  reactionPanel=RC.el('div',null,'room-reactions');
  reactionPanel.setAttribute('role','group');
  reactionPanel.setAttribute('aria-label','Реакция на сообщение');
  for(const emoji of REACTIONS){
    const option=RC.button(emoji,async()=>{
      hideReactions(true);
      const result=await request('react',{id:msg.id,emoji});
      if(!result.ok)toast(result.error||'Не удалось поставить реакцию');
    });
    option.setAttribute('aria-pressed',String(!!msg.reactions?.[emoji]?.includes(selfPublicId)));
    reactionPanel.append(option);
  }
  document.body.append(reactionPanel);
  const box=anchor.getBoundingClientRect(),panel=reactionPanel.getBoundingClientRect();
  const v=window.visualViewport,top=v?.offsetTop||0,left=v?.offsetLeft||0;
  const right=left+(v?.width||innerWidth),bottom=top+(v?.height||innerHeight);
  reactionPanel.style.left=Math.max(left+8,Math.min(box.left,right-panel.width-8))+'px';
  reactionPanel.style.top=Math.max(top+8,Math.min(bottom-panel.height-8,
    box.top-panel.height-6>=top+8?box.top-panel.height-6:box.bottom+6))+'px';
  anchor.setAttribute('aria-expanded','true');
  reactionPanel.firstElementChild.focus({preventScroll:true});
}
document.addEventListener('pointerdown',event=>{
  if(reactionPanel&&!reactionPanel.contains(event.target)&&!reactionAnchor.contains(event.target))hideReactions();
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&reactionPanel)hideReactions(true)});
document.addEventListener('focusin',event=>{
  if(reactionPanel&&!reactionPanel.contains(event.target)&&!reactionAnchor.contains(event.target))hideReactions();
});
window.addEventListener('resize',()=>hideReactions());
window.visualViewport?.addEventListener('resize',()=>hideReactions());
document.addEventListener('scroll',()=>hideReactions(),{capture:true,passive:true});
function messageBubble(msg){
  const bubble=RC.el('div',null,'bubble');
  // Construct links as DOM nodes so message text never becomes markup.
  for(const part of msg.text.split(/(https?:\/\/[^\s<>"']+)/ig)){
    if(!/^https?:\/\//i.test(part)){bubble.append(part);continue}
    try{
      const match=part.match(/^(.*?)([.,!?;:]*)$/);
      const url=new URL(match[1]);
      const link=RC.link(match[1],url.href,'room-chat-link');
      link.target='_blank';link.rel='noopener noreferrer';
      bubble.append(link,match[2]);
    }catch{bubble.append(part)}
  }
  bubble.tabIndex=0;
  bubble.setAttribute('role','button');
  bubble.setAttribute('aria-label',msg.text+' — выбрать реакцию');
  bubble.setAttribute('aria-expanded','false');
  bubble.addEventListener('click',event=>{if(!event.target.closest('a'))showReactions(bubble,msg)});
  bubble.addEventListener('keydown',event=>{
    if(event.target===bubble&&(event.key==='Enter'||event.key===' ')){
      event.preventDefault();showReactions(bubble,msg);
    }
  });
  return bubble;
}
function appendMessage(msg){const list=$('messages');list.querySelector('.empty')?.remove();const row=document.createElement('div');row.className='msg '+(msg.isHost?'host':'guest')+(isMine(msg)?' mine':'');row.dataset.messageId=msg.id||'';const content=document.createElement('div');content.className='msg-content';const bubble=messageBubble(msg);const reactionRow=document.createElement('div');reactionRow.className='reaction-row';renderReactions(msg,reactionRow);const time=document.createElement('div');time.className='msgtime';time.textContent=new Date(msg.at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});content.append(nameElement(msg),bubble,reactionRow,time);row.append(content);list.append(row);list.scrollTop=list.scrollHeight}
function renderAllMessages(){
  hideReactions();
  const list=$('messages');
  list.replaceChildren();
  for(const msg of messages)appendMessage(msg);
  if(!messages.length)list.append(RC.el('div','Чат очищается после завершения сеанса или смены видео.','empty'));
}

function resetChat(nextId=null) {
  chatId=nextId;
  messages=[];
  chatAttempt=sendingChat=null;
  $('message').value='';
  renderAllMessages();
}

$('chatForm').onsubmit = async event => {
  event.preventDefault();
  const input = $('message');
  const text = input.value.trim();
  if (!text || sendingChat) return;
  if (!inRoom || !socket.connected || !chatId) return toast('Дождись подключения чата');
  if (!chatAttempt || chatAttempt.chatId !== chatId || chatAttempt.text !== text) {
    chatAttempt = {room, chatId, text, id: randomKey()};
  }
  const attempt = chatAttempt;
  sendingChat = attempt;
  updateHost();
  const result = await request('chat', attempt);
  if(sendingChat!==attempt)return;
  sendingChat = null;
  updateHost();
  if (result.ok) {
    if (input.value.trim() === text) input.value = '';
    if (chatAttempt === attempt) chatAttempt = null;
  } else {
    toast(result.error || 'Сообщение осталось в поле. Отправь ещё раз.');
  }
};

socket.on('chat', message => {
  if (!inRoom || message.room !== room || message.chatId !== chatId || messages.some(item => item.id === message.id)) return;
  messages.push(message);
  appendMessage(message);
  if (messages.length > 250) {
    messages.shift();
    $('messages').firstElementChild?.remove();
  }
});

socket.on('reaction-update', update => {
  if (!inRoom || update.room !== room || update.chatId !== chatId) return;
  const message = messages.find(item => item.id === update.id);
  if (!message) return;
  message.reactions = update.reactions;
  const row = [...$('messages').children].find(element => element.dataset.messageId === update.id);
  if (row) renderReactions(message, row.querySelector('.reaction-row'));
});

function resetRoomView() {
  media = null;
  mediaId = null;
  syncVersion = -1;
  showMedia(null);
  $('url').value = '';
  resetChat();
  currentCinemaPoll = null;
  pollDraft = null;
  renderCinemaPoll();
  resetRoulette();
}

function applyRoomState(state, joinedNow = false) {
  if (!inRoom || state?.room !== room) return;
  if(chatId!==state.chatId)resetChat(state.chatId);
  const users = state.users || [];
  const me = users.find(user => user.id === selfPublicId);
  isHost = !!me?.isHost;
  badge = me?.badge || '🎀';
  $('online').textContent = users.length + ' онлайн';
  $('online').classList.toggle('is-online',users.length>0);
  $('twinStars').classList.toggle('connected', users.length >= 2);
  $('starsLabel').textContent = users.length >= 2 ? 'Две звезды встретились ♡' : 'Ждём вторую звезду';
  const changed = mediaId !== state.mediaId;
  if (changed) {
    media = state.media;
    mediaId = state.mediaId;
    syncVersion = -1;
    showMedia(media);
    $('url').value = media?.url || '';
  }
  updateHost();
  if (Array.isArray(state.messages)) {
    messages = state.messages;
    renderAllMessages();
  }
  if (media && (changed || joinedNow || (!isHost && state.version > syncVersion))) applySync(state);
  if (currentCinemaPoll?.id !== state.poll?.id) pollDraft = null;
  currentCinemaPoll = state.poll || null;
  renderCinemaPoll();
  renderRoulette(state.roulette);
}

socket.on('room-state', state => applyRoomState(state));
socket.on('sync', snapshot => {
  if (!isHost) applySync(snapshot);
});
socket.on('connect',()=>enterRoom());
socket.on('disconnect',reason=>{
  inRoom=false;
  hideReactions();
  clearPlaybackAttempt();
  joinFlight=0;
  $('status').textContent='Переподключение…';
  $('status').classList.remove('is-online');
  $('online').textContent='0 онлайн';
  $('online').classList.remove('is-online');
  updateHost();
  renderCinemaPoll();
  if(reason==='io server disconnect' && viewer) initAccount();
});
window.addEventListener('pagehide',()=>socket.disconnect());
window.addEventListener('pageshow',event=>{
  if(event.persisted && viewer)socket.connect();
});
socket.on('connect_error',async ()=>{
  $('entryStatus').textContent='Связь с сервером пока недоступна.';
  if(viewer) {
    try { if(!(await RC.api('/api/auth/me')).user) { socket.disconnect(); showAccountForm(); } } catch {}
  }
});

let lastWatchReport;
function reportWatch(check=true) {
  if(!inRoom || !socket.connected || !mediaId) { lastWatchReport=null; return; }
  let position=null;
  if(check && !document.hidden && mediaReady && !pendingAction &&
     (!pendingSeek || Date.now()>=pendingSeek.until)){
    try {
      if(media.type==='video' && !video.paused && !video.ended && !video.seeking && video.readyState>=3 && video.playbackRate===1) position=video.currentTime;
      if(media.type==='youtube' && ytPlayer.getPlayerState()===1 && ytPlayer.getPlaybackRate()===1) position=ytPlayer.getCurrentTime();
      if(media.type==='vk' && vkPlayer.getState()==='playing') position=vkPlayer.getCurrentTime();
    } catch {}
  }
  const playing=Number.isFinite(position);
  if(playing || lastWatchReport?.playing || lastWatchReport?.mediaId!==mediaId) {
    socket.emit('watch-heartbeat',{mediaId,playing,position});
  }
  lastWatchReport={mediaId,playing};
}
setInterval(reportWatch,2500);
document.addEventListener('visibilitychange', () => {
  if(document.hidden) { reportWatch(false); return; }
  if (!inRoom || !socket.connected) return;
  if (isHost) sendSync();
  else socket.emit('request-sync');
});
setInterval(() => {
  if (!inRoom || !media) return;
  updateTimeline();
  if (isHost && mediaReady && getPlaying() && Date.now() - lastSync >= 5000) sendSync();
}, 1000);

// Lightweight star field with meteors; stops moving for reduced-motion users.
(()=>{const canvas=$('cosmos'),ctx=canvas.getContext('2d');if(!ctx)return;const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;let w=0,h=0,dpr=1,stars=[],meteors=[],last=0,nextMeteor=0;function resize(){dpr=Math.min(devicePixelRatio||1,2);w=innerWidth;h=innerHeight;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(dpr,0,0,dpr,0,0);stars=Array.from({length:Math.min(200,Math.floor(w*h/5700))},()=>({x:Math.random()*w,y:Math.random()*h,r:.35+Math.random()*1.15,a:.18+Math.random()*.7,p:Math.random()*6.28,s:.0003+Math.random()*.001}))}function draw(t){if(document.querySelector('.auth-universe[open]')){setTimeout(()=>requestAnimationFrame(draw),1000);return}ctx.clearRect(0,0,w,h);for(const s of stars){const a=reduced?s.a:s.a*(.7+.3*Math.sin(t*s.s+s.p));ctx.fillStyle=`rgba(225,225,225,${a})`;ctx.beginPath();ctx.arc(s.x,s.y,s.r,0,Math.PI*2);ctx.fill()}if(!reduced){if(t>nextMeteor){meteors.push({x:Math.random()*w*.8+w*.1,y:-40,v:4+Math.random()*3,len:75+Math.random()*110,a:1});nextMeteor=t+2500+Math.random()*5000}for(const m of meteors){m.x-=m.v*1.3;m.y+=m.v;m.a-=.007;const grad=ctx.createLinearGradient(m.x,m.y,m.x+m.len*.8,m.y-m.len*.6);grad.addColorStop(0,`rgba(245,245,245,${Math.max(0,m.a)})`);grad.addColorStop(1,'rgba(230,230,230,0)');ctx.strokeStyle=grad;ctx.lineWidth=1.7;ctx.beginPath();ctx.moveTo(m.x,m.y);ctx.lineTo(m.x+m.len*.8,m.y-m.len*.6);ctx.stroke()}meteors=meteors.filter(m=>m.a>0&&m.y<h+120)}last=t;if(!reduced)requestAnimationFrame(draw)}resize();addEventListener('resize',resize,{passive:true});requestAnimationFrame(draw)})();

// Personal movie list. Entirely local, not shared through Socket.IO.
const WATCH_KEY='remediumCinemaPersonalWatchV1';
const WATCH_DEFAULTS=[{"name":"Парни с тату","status":"done","category":"main"},{"name":"Ты умрешь через 6 часов","status":"done","category":"main"},{"name":"Гретель и Гензель","status":"done","category":"main"},{"name":"Платформа 1,2","status":"done","category":"main"},{"name":"Мы","status":"done","category":"main"},{"name":"Игра Джеральда","status":"done","category":"main"},{"name":"Уроки Фарси","status":"done","category":"main"},{"name":"Воровка книг","status":"done","category":"main"},{"name":"Дориан Грей","status":"done","category":"main"},{"name":"Магазинчик самоубийств","status":"done","category":"main"},{"name":"Коралина в Стране Кошмаров","status":"done","category":"main"},{"name":"Труп невесты","status":"done","category":"main"},{"name":"Глаза сердечки","status":"done","category":"main"},{"name":"Франкенвини","status":"done","category":"main"},{"name":"Пиноккио","status":"done","category":"main"},{"name":"Шрек 1","status":"done","category":"main"},{"name":"Шрек 2","status":"done","category":"main"},{"name":"Шрек 3","status":"done","category":"main"},{"name":"Шрек 4","status":"done","category":"main"},{"name":"Короткометражки Шрек","status":"done","category":"main"},{"name":"Носферату","status":"done","category":"main"},{"name":"Обезьяна","status":"done","category":"main"},{"name":"Сумерки все Сага","status":"done","category":"main"},{"name":"В поисках Аляски (сериал)","status":"done","category":"main"},{"name":"Осд (сериал) 1-3 сезоны, 4,5","status":"done","category":"main"},{"name":"Леденящие душу приключения Сабрины","status":"progress","category":"main"},{"name":"Джинни и Джорджия","status":"progress","category":"main"},{"name":"Конец ебаного мира","status":"done","category":"main"},{"name":"13 причин почему","status":"done","category":"main"},{"name":"scam (стыд) 1,2,3","status":"done","category":"main"},{"name":"Укрытие (сериал)","status":"done","category":"main"},{"name":"Эйфория","status":"done","category":"main"},{"name":"Тьма","status":"done","category":"main"},{"name":"Поделиться","status":"done","category":"main"},{"name":"Финес и Ферб","status":"done","category":"main"},{"name":"Эй, Арнольд!","status":"none","category":"main"},{"name":"Мне это не нравится","status":"none","category":"main"},{"name":"Острые козырьки","status":"no","category":"main"},{"name":"Гарри Поттер","status":"no","category":"main"},{"name":"Оно новая глава","status":"no","category":"main"},{"name":"Крик 1","status":"done","category":"main"},{"name":"Крик 2","status":"no","category":"main"},{"name":"Крик 3","status":"no","category":"main"},{"name":"Крик 4","status":"no","category":"main"},{"name":"Крик 5","status":"no","category":"main"},{"name":"Крик 6","status":"no","category":"main"},{"name":"Крик 7","status":"no","category":"main"},{"name":"Пророк А.С. Пушкин","status":"no","category":"main"},{"name":"Трилогия Гоголя","status":"no","category":"main"},{"name":"Анна Каренина","status":"no","category":"main"},{"name":"Компаньон","status":"no","category":"main"},{"name":"Чикатило","status":"no","category":"main"},{"name":"Фишер","status":"no","category":"main"},{"name":"Триггер","status":"no","category":"main"},{"name":"Холоп","status":"no","category":"main"},{"name":"Аватар 3","status":"no","category":"main"},{"name":"Один дома на НГ 🎄","status":"no","category":"main"},{"name":"Оно 1","status":"no","category":"main"},{"name":"Оно 2","status":"done","category":"main"},{"name":"Оно 3","status":"no","category":"main"},{"name":"Выбывшая","status":"done","category":"main"},{"name":"Ход королевы","status":"no","category":"main"},{"name":"Одни из нас","status":"no","category":"main"},{"name":"Озарк 1–4","status":"done","category":"main"},{"name":"Список смертников","status":"no","category":"main"},{"name":"Переходный возраст","status":"done","category":"main"},{"name":"Карма","status":"no","category":"main"},{"name":"Призраки дома на холме","status":"done","category":"main"},{"name":"Охотник за голова","status":"done","category":"main"},{"name":"Килербот","status":"done","category":"main"},{"name":"Во всем виновата она","status":"done","category":"main"},{"name":"Красные нити","status":"done","category":"main"},{"name":"Черное зеркало","status":"done","category":"main"},{"name":"Килербот","status":"done","category":"main"},{"name":"Декстер 1–7","status":"done","category":"main"},{"name":"Во все тяжкие","status":"done","category":"main"},{"name":"Периферийные устройства","status":"done","category":"main"},{"name":"Злой умысел","status":"done","category":"main"},{"name":"Добро пожаловать в Дерри","status":"done","category":"main"},{"name":"Одна из многих","status":"done","category":"main"},{"name":"Чудовище внутри меня","status":"done","category":"main"},{"name":"Оленёнок","status":"done","category":"main"},{"name":"Дорогой Санта","status":"done","category":"main"},{"name":"Настоящий детектив","status":"no","category":"main"},{"name":"Последний человек на земле","status":"no","category":"main"},{"name":"Фоллаут","status":"no","category":"main"},{"name":"Побег","status":"done","category":"main"},{"name":"Половое воспитание","status":"no","category":"main"},{"name":"Чернобыль","status":"no","category":"main"},{"name":"Слабый герой","status":"no","category":"main"},{"name":"Линкольн для адвоката","status":"no","category":"main"},{"name":"Школьные духи","status":"no","category":"main"},{"name":"Сделано в Кореи","status":"no","category":"main"},{"name":"Кросс","status":"no","category":"main"},{"name":"Ночной агент","status":"no","category":"main"},{"name":"Снова на воле","status":"no","category":"main"},{"name":"Больница Питт","status":"no","category":"main"},{"name":"Выход 8","status":"no","category":"main"},{"name":"Извне","status":"done","category":"main"},{"name":"Невидимая стороны","status":"no","category":"main"},{"name":"Волшебник Изумрудного города","status":"none","category":"moderation"},{"name":"Интерстеллар","status":"none","category":"moderation"},{"name":"Начальница","status":"no","category":"moderation"},{"name":"Лудермилк","status":"no","category":"moderation"},{"name":"Начальная школа Эбботт","status":"no","category":"moderation"},{"name":"Мег 2: Впадина","status":"no","category":"moderation"},{"name":"Уэйндвард Пайнс","status":"no","category":"moderation"},{"name":"Общество","status":"no","category":"moderation"},{"name":"Академия","status":"no","category":"moderation"},{"name":"Манифест","status":"no","category":"moderation"},{"name":"Архив 81","status":"done","category":"moderation"},{"name":"Зло","status":"no","category":"moderation"},{"name":"Лаки","status":"done","category":"moderation"},{"name":"Бороуз","status":"no","category":"moderation"},{"name":"Старьевщик","status":"done","category":"moderation"},{"name":"Люпен","status":"done","category":"moderation"},{"name":"Соник — 4 части","status":"none","category":"moderation"},{"name":"Мыс страха","status":"done","category":"moderation"},{"name":"Проект Гутенберг","status":"no","category":"moderation"},{"name":"Кэрри","status":"done","category":"moderation"},{"name":"Милые обманщицы","status":"no","category":"moderation"},{"name":"Элита","status":"no","category":"moderation"},{"name":"Молокососы","status":"no","category":"moderation"},{"name":"Деграсси","status":"no","category":"moderation"},{"name":"Ривердейл","status":"no","category":"moderation"}];
const watchStatus={none:'Без отметки',done:'✓ Просмотрено',no:'× В планах',progress:'… В процессе'};
const watchId=()=>globalThis.crypto?.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(36).slice(2);
let watchItems=[];
try {
 const stored = JSON.parse(storageGet(WATCH_KEY));
 watchItems = Array.isArray(stored) ? watchNormalize(stored) : [];
} catch { watchItems = []; }
// Seed once per browser. Keep existing entries and user-modified statuses untouched.
const WATCH_SEED_FLAG='remediumCinemaBuiltInList20261109';
if(storageGet(WATCH_SEED_FLAG)!=='yes'){
 const keys=new Set(watchItems.map(x=>x.category+'|'+x.name.trim().toLocaleLowerCase('ru')));
 for(const item of WATCH_DEFAULTS){const key=item.category+'|'+item.name.trim().toLocaleLowerCase('ru');if(!keys.has(key)){watchItems.push({id:globalThis.crypto?.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(36).slice(2),...item});keys.add(key)}}
 if (storageSet(WATCH_KEY, JSON.stringify(watchItems))) storageSet(WATCH_SEED_FLAG, 'yes');
}
function watchSave() {
 if (!storageSet(WATCH_KEY, JSON.stringify(watchItems))) toast('Браузер не смог сохранить список между посещениями');
 watchRender();
}

function customPoster(value) {
 if (typeof value !== 'string' || value.length > 1200) return null;
 try {
  const url = new URL(value.trim());
  if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
 } catch {}
 return null;
}

function posterEnqueue(item,holder){
 const key=String(item.name||'').trim().toLocaleLowerCase('ru');
 const local=LOCAL_POSTERS[key];
 const custom=customPoster(item.poster);
 const url=custom||local;
 if(!url)return;
 // Insert the image immediately. Waiting for onload before adding a lazy
 // image to the document can prevent the browser from ever requesting it.
 const img=document.createElement('img');
 img.alt='Постер: '+item.name;
 img.decoding='async';
 img.loading='lazy';
 img.referrerPolicy='no-referrer';
 img.style.cssText='display:block;width:100%;height:100%;object-fit:cover;object-position:center;border-radius:inherit;';
 img.onerror=()=>{
  console.warn('Не удалось загрузить постер:',img.src);
  if(img.parentNode)holder.textContent='✦';
 };
 holder.style.backgroundImage='none';
 holder.replaceChildren(img);
 img.src=new URL(url,location.origin+'/').href;
}

function watchRender(){
 const list=$('watchItems'),q=$('watchSearch').value.trim().toLocaleLowerCase('ru'),cat=$('watchCategory').value;
 $('watchCount').textContent='· '+watchItems.length;
 if (!$('watchlist').open) return;
 list.replaceChildren();const filtered=watchItems.filter(x=>(cat==='all'||x.category===cat)&&x.name.toLocaleLowerCase('ru').includes(q));
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
  const edit=document.createElement('button');edit.textContent='✎';edit.title='Изменить название';edit.onclick=()=>{
   const value=prompt('Название фильма',item.name);
   if(value===null)return;
   const link=prompt('Ссылка на постер (https://). Оставь пустым для встроенной обложки.',item.poster||'');
   const poster=link?.trim()?customPoster(link):null;
   if(link?.trim()&&!poster)return toast('Нужна корректная ссылка https://');
   if(value.trim())item.name=value.trim().slice(0,120);
   if(link!==null)item.poster=poster||'';
   watchSave();
  };
  const del=document.createElement('button');del.textContent='×';del.title='Удалить';del.onclick=()=>{if(confirm('Удалить «'+item.name+'»?')){watchItems=watchItems.filter(x=>x.id!==item.id);watchSave()}};
  actions.append(select,edit,del);row.append(poster,info,actions);list.append(row);posterEnqueue(item,poster)
 }
 if(!filtered.length){const empty=document.createElement('div');empty.className='watch-note';empty.textContent=watchItems.length?'Ничего не найдено':'Коллекция пока пуста. Добавь первый фильм ✦';list.append(empty)}
}
$('watchForm').onsubmit=e=>{e.preventDefault();const name=$('watchName').value.trim();if(!name)return;watchItems.push({id:watchId(),name,status:'none',category:$('watchNewCategory').value});$('watchName').value='';watchSave()};
$('watchSearch').oninput=watchRender;$('watchCategory').onchange=watchRender;
$('watchImport').onclick=()=>$('watchFile').click();
function watchNormalize(items, preserveIds = true) {
 return items.filter(item=>item&&typeof item.name==='string'&&item.name.trim()).map(item=>({
  id: preserveIds && typeof item.id==='string' ? item.id : watchId(),
  name: item.name.trim().slice(0,120),
  status: typeof item.status==='string'&&Object.hasOwn(watchStatus,item.status)?item.status:'none',
  category: item.category==='moderation'?'moderation':'main',
  poster: customPoster(item.poster)||''
 }));
}
function watchParseLegacy(html){const results=[];for(const [variable,category] of [['initial','main'],['moderation','moderation']]){const section=html.match(new RegExp('const\\s+'+variable+'\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*\\.map'));if(!section)continue;const regex=/\[\s*("(?:\\.|[^"\\])*"|\x27(?:\\.|[^\x27\\])*\x27)\s*,\s*["\x27](done|no|progress|none)["\x27]\s*\]/g;for(const m of section[1].matchAll(regex)){let name;try{name=m[1][0]==='"'?JSON.parse(m[1]):m[1].slice(1,-1)}catch{continue}results.push({name,status:m[2],category})}}return results}
$('watchFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>5e6)throw Error('Файл слишком большой');const text=await file.text();let parsed;if(/\.html?$/i.test(file.name)||/^\s*<!doctype html/i.test(text)){parsed=watchParseLegacy(text)}else{const data=JSON.parse(text);parsed=Array.isArray(data)?data:data.items}if(!Array.isArray(parsed)||!parsed.length)throw Error('Не удалось найти фильмы в файле');const entries=watchNormalize(parsed, false);if(!entries.length)throw Error('Нет подходящих записей');if(confirm('Импортировать '+entries.length+' записей? Нажми ОК, чтобы добавить к текущему списку.')){watchItems.push(...entries);watchSave();toast('Импортировано: '+entries.length)}}catch(err){alert('Ошибка импорта: '+err.message)}finally{e.target.value=''}};
$('watchExport').onclick=()=>{const blob=new Blob([JSON.stringify({version:1,items:watchItems},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='remedium-cinema-watchlist.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000)};
watchRender();


// Shared cinema features
let currentCinemaPoll = null;
let pollDraft = null;
let wishMessages = [];
let pollCreating = false, voting = false, pollFinishing = false;
let spinRequested = false, activeRoulette = null;

function safeText(tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}

function showWish(data) {
  if (!data?.text) return;
  const element = document.createElement('div');
  element.className = 'wish-visual';
  element.append(safeText('div', data.name + ' ✧ ' + data.text));
  const container = $('wishInbox').open ? $('wishInbox') : document.body;
  container.append(element);
  setTimeout(() => element.remove(), 5100);
}

$('wishForm').onsubmit=async event=>{
  event.preventDefault();
  const wish=$('wishText').value.trim();
  const submit=$('wishSubmit');
  if(!wish || submit.disabled) return;
  submit.disabled=true;
  try {
    const result=await request('wish',wish);
    if(result.ok) {
      if ($('wishText').value.trim() === wish) $('wishCompose').close();
      toast('Послание отправлено ✧');
    } else $('wishStatus').textContent=result.error||'Не удалось отправить послание';
  } finally { submit.disabled=false; }
};

function openLinkedPanel() {
  if(!inRoom) return;
  const target = location.hash.slice(1);
  const panel = $(target === 'send-wish' ? 'wishCompose' : target);
  if (panel?.classList.contains('cinema-tool')) {
    history.replaceState(null, '', location.pathname + location.search);
    openCinemaPanel(panel);
  }
}
window.addEventListener('hashchange',openLinkedPanel);

function renderWishInbox() {
  const unread = wishMessages.filter(item => !item.read).length;
  const badge = $('wishBadge');
  CinemaNav.setUnreadBadge(badge,unread);
  const list = $('wishLetters');
  list.replaceChildren();
  if (!wishMessages.length) {
    list.append(safeText('div', 'Пока нет посланий ✧'));
    return;
  }
  for (const item of wishMessages.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'feature-entry';
    row.append(safeText('span', item.read
      ? '✧ ' + item.name + ': ' + item.text : '✉ Запечатанное послание от ' + item.name));
    if (!item.read) {
      const button = safeText('button', 'Открыть');
      button.className = 'btn';
      button.type = 'button';
      button.onclick = async () => {
        const id = room;
        button.disabled = true;
        const result = await request('wish-read', item.id);
        button.disabled = false;
        if (room !== id) return;
        if (result.ok) showWish(result);
        else toast(result.error || 'Не удалось открыть послание');
      };
      row.append(button);
    }
    list.append(row);
  }
}

socket.on('wish-inbox', payload => {
  if (!inRoom || payload.room !== room) return;
  wishMessages = payload.items;
  renderWishInbox();
});

$('pollCreate').onclick = async () => {
  if (!inRoom) return toast('Сначала войди в комнату');
  if (pollCreating) return;
  const input = $('pollOptions');
  const draft = input.value;
  const values = draft.split(/\r?\n/).map(value => value.trim()).filter(Boolean).slice(0, 8);
  if (new Set(values).size < 2) return toast('Нужно хотя бы два разных фильма');
  pollCreating = true;
  renderCinemaPoll();
  const id = room;
  const result = await request('poll-create', values);
  pollCreating = false;
  if (id === room && result.ok && input.value === draft) input.value = '';
  renderCinemaPoll();
  if (id === room) toast(result.ok ? 'Голосование создано' : result.error || 'Не удалось создать голосование');
};

$('pollFinish').onclick = async () => {
  if (!currentCinemaPoll || pollFinishing) return;
  pollFinishing = true;
  renderCinemaPoll();
  const result = await request('poll-finish', {id: currentCinemaPoll.id});
  pollFinishing = false;
  renderCinemaPoll();
  if (!result.ok) toast(result.error || 'Не удалось завершить голосование');
};

function renderCinemaPoll() {
  const target = $('pollResults');
  const finish = $('pollFinish');
  const poll = currentCinemaPoll;
  $('pollCreate').disabled = pollCreating || (!!poll && !poll.finished);
  finish.classList.toggle('hidden', !poll || poll.finished || !isHost);
  finish.disabled = pollFinishing || !inRoom;
  target.replaceChildren();
  if (!poll) {
    target.append(safeText('div', 'Пока нет голосования'));
    return;
  }
  const confirmedChoice = poll.myChoice ?? null;
  target.append(safeText('div', poll.finished ? '✦ Голосование завершено · результаты открыты'
    : '🔒 Голоса скрыты до завершения · проголосовало: ' + poll.voteCount));
  poll.options.forEach((option, index) => {
    const row = document.createElement('div');
    row.className = 'feature-entry poll-vote-row';
    row.append(safeText('span', option + (poll.finished ? ' · ' + (poll.counts?.[index] || 0) + ' голос(ов)' : '')));
    if (!poll.finished) {
      const label = pollDraft === index ? '✓ Мой выбор' : confirmedChoice === index ? '✓ Мой голос' : 'Выбрать';
      const button = safeText('button', label);
      button.type = 'button';
      button.className = 'btn';
      button.disabled = voting || !inRoom;
      button.onclick = () => {
        pollDraft = index;
        renderCinemaPoll();
      };
      row.append(button);
    }
    target.append(row);
  });
  if (poll.finished) return;
  const confirmVote = safeText('button', 'Подтвердить голос');
  confirmVote.type = 'button';
  confirmVote.className = 'btn primary';
  confirmVote.disabled = !inRoom || voting || pollDraft === null;
  confirmVote.onclick = async () => {
    voting = true;
    renderCinemaPoll();
    const result = await request('poll-vote', {id: poll.id, index: pollDraft});
    voting = false;
    if (result.ok && currentCinemaPoll?.id === poll.id) pollDraft = null;
    renderCinemaPoll();
    toast(result.ok ? 'Твой голос принят и скрыт' : result.error || 'Не удалось проголосовать');
  };
  target.append(confirmVote);
}

const serverNow = () => Date.now() + serverOffset;
const spinEase = 'cubic-bezier(.12,.76,.16,1)';

function renderRouletteButton() {
  $('rouletteSpin').disabled = spinRequested || (!!activeRoulette && !activeRoulette.finished);
}

function resetRoulette() {
  if (activeRoulette) {
    clearTimeout(activeRoulette.loadTimer);
    clearTimeout(activeRoulette.startTimer);
    clearTimeout(activeRoulette.finishTimer);
    activeRoulette.animation?.cancel();
  }
  activeRoulette = null;
  const track = $('rouletteTrack');
  track.classList.remove('spinning');
  track.style.transition = 'none';
  track.style.transform = 'translateX(0)';
  track.style.filter = '';
  track.replaceChildren(safeText('span', '✦ Готовы выбрать фильм?'));
  $('rouletteResult').textContent = '';
  $('cinemaMenuUpdate').hidden = true;
  renderRouletteButton();
}

function winnerPosition(spin) {
  const card = $('rouletteTrack').children[spin.cardIndex];
  if (!card) return 0;
  return card.offsetLeft + card.offsetWidth / 2 - $('rouletteStage').clientWidth / 2;
}

function finishRoulette(spin) {
  if (activeRoulette !== spin) return;
  spin.finished = true;
  const track = $('rouletteTrack');
  if (spin.guestReveal) {
    spin.guestReveal = false;
    const card = document.createElement('div');
    card.className = 'roulette-card';
    if (spin.winnerImage) card.append(spin.winnerImage);
    card.append(safeText('span', spin.winner.name));
    track.replaceChildren(card);
    track.style.filter = '';
    spin.cardIndex = 0;
  }
  track.classList.remove('spinning');
  track.style.transition = 'none';
  track.style.transform = 'translateX(' + -winnerPosition(spin) + 'px)';
  spin.animation?.cancel();
  $('rouletteResult').textContent = '✦ Выпал фильм: ' + spin.winner.name + (spin.coversUnavailable ? ' · обложки не загрузились' : '');
  renderRouletteButton();
}

function animateRoulette(spin) {
  if (!$('rouletteStage').clientWidth || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const elapsed = Math.max(0, serverNow() - spin.startedAt);
  if (elapsed >= spin.duration) return;
  const track = $('rouletteTrack');
  const position = winnerPosition(spin);
  const target = 'translateX(' + -position + 'px)';
  spin.animation?.cancel();
  if (typeof track.animate === 'function') {
    spin.animation = track.animate([{transform: 'translateX(0)'}, {transform: target}], {
      duration: spin.duration, easing: spinEase, fill: 'both'
    });
    spin.animation.currentTime = elapsed;
  } else {
    track.style.transition = 'none';
    track.style.transform = 'translateX(' + (-position * elapsed / spin.duration) + 'px)';
    track.offsetWidth;
    track.style.transition = 'transform ' + (spin.duration - elapsed) + 'ms ' + spinEase;
    track.style.transform = target;
  }
}

function scheduleRoulette(spin) {
  if (activeRoulette !== spin || !spin.ready || spin.startedAt === null || spin.scheduled) return;
  spin.scheduled = true;
  spin.startTimer = setTimeout(() => {
    if (activeRoulette !== spin) return;
    animateRoulette(spin);
    spin.finishTimer = setTimeout(() => finishRoulette(spin), Math.max(0, spin.startedAt + spin.duration - serverNow()));
  }, Math.max(0, spin.startedAt - serverNow()));
}

function posterSource(poster) {
  if (typeof poster !== 'string') return null;
  if (/^posters\/[a-z0-9-]+\.webp$/i.test(poster)) return '/' + poster;
  return /^https:\/\//i.test(poster) ? poster : null;
}

function rouletteEntries(candidates) {
  const encoder = new TextEncoder();
  const entries = candidates.map(item => ({name: item.name.slice(0, 100), poster: null}));
  let size = encoder.encode(JSON.stringify(entries)).length;
  for (const [index, item] of candidates.entries()) {
    const poster = customPoster(item.poster) || LOCAL_POSTERS[item.name.trim().toLocaleLowerCase('ru')];
    if (!poster) continue;
    const extra = encoder.encode(JSON.stringify(poster)).length - 4;
    if (size + extra > 90000) continue;
    entries[index].poster = poster;
    size += extra;
  }
  return entries;
}

function buildRouletteCards(spin, cards, finished) {
  const track = $('rouletteTrack');
  const pending = new Set();
  const images = [];
  track.replaceChildren();
  for (const item of cards) {
    const card = document.createElement('div');
    card.className = 'roulette-card';
    const source = posterSource(item.poster);
    if (source) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = finished ? 'lazy' : 'eager';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      card.append(image);
      images.push({image, source});
      if (!finished) pending.add(image);
    }
    card.append(safeText('span', item.name));
    track.append(card);
  }
  if (finished) {
    for (const {image, source} of images) {
      image.onerror = () => image.remove();
      image.src = source;
    }
    finishRoulette(spin);
    return;
  }

  function ready() {
    if (activeRoulette !== spin || spin.ready || spin.finished) return;
    clearTimeout(spin.loadTimer);
    spin.ready = true;
    scheduleRoulette(spin);
  }

  function unavailable() {
    if (activeRoulette !== spin || spin.ready || spin.finished) return;
    clearTimeout(spin.loadTimer);
    spin.coversUnavailable = true;
    spin.cardIndex = 0;
    buildRouletteCards(spin, [spin.winner], true);
  }

  if (!images.length) return ready();
  if (!isHost) spin.loadTimer = setTimeout(unavailable, 20000);
  for (const {image, source} of images) {
    image.onerror = () => {
      image.remove();
      if (!isHost) unavailable();
    };
    if (!isHost) {
      image.onload = () => {
        pending.delete(image);
        if (!pending.size) ready();
      };
    }
    image.src = source;
  }
  if (isHost) ready();
}

function buildBlurredRoulette(spin, cardCount) {
  const track = $('rouletteTrack');
  track.replaceChildren();
  track.style.filter = 'blur(8px)';
  for (let index = 0; index < cardCount; index++) {
    const card = document.createElement('div');
    card.className = 'roulette-card';
    card.style.background = index % 2
      ? 'linear-gradient(145deg, #484052, #211d2d)'
      : 'linear-gradient(145deg, #524536, #292235)';
    track.append(card);
  }
  spin.guestReveal = true;
  const source = posterSource(spin.winner.poster);
  if (source) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'eager';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.onerror = () => {
      image.remove();
      spin.winnerImage = null;
    };
    spin.winnerImage = image;
    image.src = source;
  }
  spin.ready = true;
  scheduleRoulette(spin);
}

function renderRoulette(data) {
  if (!data) {
    if (activeRoulette) resetRoulette();
    return;
  }
  if (activeRoulette?.id === data.id) {
    if (data.startedAt !== null) {
      activeRoulette.startedAt = data.startedAt;
      scheduleRoulette(activeRoulette);
    }
    return;
  }
  const winner = data.cards?.[data.winnerIndex];
  if (!winner) return;
  resetRoulette();
  const finished = data.startedAt !== null && serverNow() >= data.startedAt + data.duration;
  const spin = {
    id: data.id, startedAt: data.startedAt, duration: data.duration,
    winner, cardIndex: finished ? 0 : data.winnerIndex, ready: false, finished: false, scheduled: false
  };
  activeRoulette = spin;
  if (!finished) {
    $('rouletteResult').textContent = '✦ Звёзды выбирают фильм…';
    $('cinemaMenuUpdate').hidden = $('roulettePanel').open;
  }
  renderRouletteButton();
  if (!isHost && !finished) buildBlurredRoulette(spin, data.cards.length);
  else buildRouletteCards(spin, finished ? [winner] : data.cards, finished);
}

function refreshRouletteView() {
  if (!$('roulettePanel').open || !activeRoulette) return;
  $('cinemaMenuUpdate').hidden = true;
  if (activeRoulette.finished) finishRoulette(activeRoulette);
  else if (activeRoulette.scheduled && activeRoulette.startedAt <= serverNow()) animateRoulette(activeRoulette);
}

window.addEventListener('resize',refreshRouletteView,{passive:true});

$('rouletteSpin').onclick = async () => {
  if (!inRoom) return toast('Сначала войди в комнату');
  if (spinRequested || (activeRoulette && !activeRoulette.finished)) return;
  const candidates = watchItems.filter(item => item.status === 'no' || item.status === 'none').slice(0, 180);
  if (!candidates.length) return toast('Нет фильмов в планах или без отметки');
  const entries = rouletteEntries(candidates);
  spinRequested = true;
  renderRouletteButton();
  const result = await request('roulette-spin', entries);
  spinRequested = false;
  renderRouletteButton();
  if (!result.ok) toast(result.error || 'Не удалось запустить рулетку');
};

socket.on('roulette', payload => {
  if (inRoom && payload.room === room) renderRoulette(payload.spin);
});

renderWishInbox();
renderCinemaPoll();

initAccount();
