import {parseMedia} from '../modules/playback/media.js';
import {authFor,sessionActive} from '../modules/auth/index.js';
import {HttpError,sameOrigin,uuid} from '../http/helpers.js';
import {ownRoom,getRoomRecord,admitGuest,newInvite,saveRoom} from '../modules/rooms/index.js';
import {openChat,changeChat,maintainChatLeases} from '../modules/room-chat/index.js';
import {createWatchTracker} from '../modules/watch/tracker.js';
import {catalogPoster,posterUrl,sourcePoster} from '../modules/watch/media.js';
import {maxRooms,maxConnections,spinDuration,winnerIndex,badges,reactions,uid,clean,isRecord,isRoom,isToken,channel} from '../config/room.js';
import {createRoomState,currentTime,snapshotRoom} from './room-state.js';
import {createRoomPersistence} from './room-persistence.js';
import {createRoomQueue} from './room-queue.js';
import {publicId,publicReactions,publicMessage,publicPoll,playbackState,sharedState,broadcast,inbox,sendInbox,roomHistory} from './room-view.js';
import {defaultTitle,makeCards} from './room-tools.js';

export function installRealtime(io,closeDatabase) {
const {rooms,hydrateRoom,roomFor,member} = createRoomState();
const tracker=createWatchTracker();
const {dirtyRooms,flushSaves,saveSoon,isPending}=createRoomPersistence({saveRoom,snapshotRoom,isShuttingDown:()=>shuttingDown});
function recordPlayback(room) {
  if(room.historyRecorded) return;
  room.history.push({room:room.id,id:room.mediaId,title:room.title,url:room.media.url,
    poster:room.watchPoster,at:new Date().toISOString()});
  room.history=room.history.slice(-100);
  room.historyRecorded=true;
  saveSoon(room);
  io.to(channel(room.id)).emit('cinema-history',{room:room.id,items:roomHistory(room)});
}

const {roomQueues,inRoomOrder}=createRoomQueue();
const leaseTimer=setInterval(()=>{
  const active=[...rooms.values()].filter(r=>r.users.size).map(r=>r.id);
  const onlineUsers=[...new Set([...io.sockets.sockets.values()].map(socket=>socket.data.auth.id))];
  maintainChatLeases(active,onlineUsers).catch(error=>console.warn('Chat expiry:',error.code||error.name));
},5*60*1000);
leaseTimer.unref();

function leave(socket) {
  tracker.forget(socket);
  const room=roomFor(socket);
  if(!room) return;
  room.users.delete(socket.id);
  socket.data.room=null;
  socket.leave(channel(room.id));
  if(!room.users.size){
    if(room.playing) room.time=currentTime(room);
    room.playing=false;
    room.updated=Date.now();
    room.syncVersion++;
    if(!room.finishing)tracker.finish(room).catch(error=>console.warn('Watch close:',error.code||error.name));
    saveSoon(room);
  }
  broadcast(room);
}

let shuttingDown=false;
io.use(async (socket,next)=>{
  try{
    if(shuttingDown || io.sockets.sockets.size>=maxConnections) return next(new Error('Сервер занят.'));
    if(!sameOrigin(socket.request,false)) return next(new Error('Стороннее подключение.'));
    const auth=await authFor(socket.request);
    if(!auth) return next(new Error('Войди в аккаунт.'));
    // Prevent an automatically reconnected old page from operating as a new account.
    if(socket.handshake.auth?.accountId!==undefined && socket.handshake.auth.accountId!==auth.id)
      return next(new Error('Аккаунт изменился. Обнови страницу.'));
    socket.data.auth=auth;
    socket.data.checkedAt=Date.now();
    next();
  }catch { next(new Error('Сервис временно недоступен.')); }
});

io.on('connection', socket => {
  const rate = new Map();
  let joining = false;
  let checking;
  socket.join('user:'+socket.data.auth.id);
  socket.join('session:'+socket.data.auth.session_id);
  const profile=socket.handshake.auth?.historyProfile;
  if(uuid(profile)) socket.join('history-profile:'+profile.toLowerCase());
  let expiry;
  function scheduleExpiry() {
    const remaining=new Date(socket.data.auth.expires_at).getTime()-Date.now();
    if(remaining<=0) socket.disconnect(true);
    else {
      expiry=setTimeout(scheduleExpiry,Math.min(remaining,2147483647));
      expiry.unref();
    }
  }
  scheduleExpiry();

  function on(event, perSecond, handle) {
    socket.on(event, async (...args) => {
      const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
      let replied = false;
      const reply = result => {
        if (!replied && callback) callback(result);
        replied = true;
      };
      const fail = error => reply({ok: false, error});
      const now = Date.now();
      let bucket = rate.get(event);
      if (!bucket || now - bucket.since >= 1000) {
        bucket = {since: now, count: 0};
        rate.set(event, bucket);
      }
      if (shuttingDown) return fail('Сервер перезапускается');
      if (++bucket.count > perSecond) return fail('Слишком много действий. Попробуй чуть позже.');
      try {
        const auth=socket.data.auth;
        if (now>=new Date(auth.expires_at).getTime()) return socket.disconnect(true);
        if (now-socket.data.checkedAt>=30000) {
          checking ||= sessionActive(auth).finally(()=>{checking=null});
          if (!await checking) return socket.disconnect(true);
          socket.data.checkedAt=now;
        }
        if (socket.connected) await handle(args[0], reply, fail);
      } catch (error) {
        if(error instanceof HttpError) return fail(error.message);
        console.warn('Cinema event '+event+':',error.code||error.name);
        fail('Сервис временно недоступен. Попробуй ещё раз.');
      }
    });
  }

  function onSession(event,limit,handle){
    on(event,limit,(payload,reply,fail)=>{
      const room=roomFor(socket);
      if(!room)return fail('Сначала войди в комнату');
      return inRoomOrder(room,()=>{
        if(!socket.connected||roomFor(socket)!==room||!member(socket))return fail('Комната сменилась');
        return handle(payload,reply,fail);
      });
    });
  }

  on('join', 5, async (payload, reply, fail) => {
    if (joining) return fail('Вход уже выполняется');
    const auth=socket.data.auth;
    if (payload?.room && !isRoom(payload.room)) return fail('Ссылка на комнату некорректна');
    joining=true;
    try {
      const record=payload?.room?await getRoomRecord(payload.room):await ownRoom(auth);
      if(!record) return fail('Комната не найдена. Попроси создателя прислать ссылку.');
      if(rooms.size>=maxRooms && !rooms.has(record.id)) {
        const free=[...rooms.values()].find(r=>!r.users.size&&!isPending(r)&&!roomQueues.has(r.id));
        if(free) rooms.delete(free.id);
        else return fail('Сервер пока не может открыть ещё одну комнату.');
      }
      const room=hydrateRoom(record,record.owner_id===auth.id?auth.nickname:null);
      await inRoomOrder(room,async ()=>{
        const access=await admitGuest(record.id,auth.id,payload?.invite,
          ()=>[...room.users.values()].some(user=>!user.isHost && user.accountId!==auth.id));
        if(!socket.connected)return;
        await openChat(room,access.guest_id);
        if(!socket.connected)return;
        const isHost=access.owner_id===auth.id;
        room.guestId=access.guest_id;
        room.guestToken=access.guest_id?.replaceAll('-','')||null;
        for(const guest of room.users.values()) {
          if(!guest.isHost && guest.accountId!==room.guestId) leave(guest.socket);
        }
        if(isHost) room.hostName=auth.nickname;
        const token=isHost?room.hostToken:room.guestToken;
        if(socket.data.room!==room.id) leave(socket);
        socket.data.room=room.id;
        socket.join(channel(room.id));
        room.users.set(socket.id,{socket,name:auth.nickname,token,isHost,accountId:auth.id});
        reply({ok:true,id:publicId(room,token),isHost,
          state:{...sharedState(room,true),poll:publicPoll(room.poll,token)},inbox:inbox(room,token),history:roomHistory(room)});
        broadcast(room);
      });
    } finally { joining=false; }
  });

  on('invite', 4, async (_, reply, fail) => {
    const room=roomFor(socket);
    if(!room || !member(socket)?.isHost) return fail('Пригласить может создатель комнаты');
    reply({ok:true,...await newInvite(socket.data.auth)});
  });

  on('watch-heartbeat', 4, async payload=>{
    const room=roomFor(socket);
    if(member(socket)&&!room.finishing) await tracker.report(socket,room,payload);
  });

  onSession('media', 4, async (payload, reply, fail) => {
    const room = roomFor(socket);
    if (!member(socket)?.isHost) return fail('Менять фильм может только создатель');
    if(room.finishing) return fail('Завершаем текущий фильм.');
    const media = parseMedia(payload?.url);
    if (!media) return fail('Поддерживаются YouTube, VK Видео и прямые HTTPS-ссылки MP4/WebM');
    const nextMediaId=uid();
    await openChat(room,room.guestId,{mediaId:nextMediaId,renew:true});
    tracker.finish(room).catch(error=>console.warn('Watch close:',error.code||error.name));
    room.media = media;
    room.mediaId = nextMediaId;
    room.title = clean(payload?.title, 120) || defaultTitle(media);
    room.watchPoster=posterUrl(payload?.poster)||catalogPoster(room.title)||sourcePoster(media);
    room.historyRecorded = false;
    room.time = 0;
    room.playing = false;
    room.playbackDuration = 0;
    room.updated = Date.now();
    room.syncVersion++;
    saveSoon(room);
    await flushSaves();
    broadcast(room,true);
    reply({ok: true});
  });

  onSession('watch-finish', 5, async (payload,reply,fail)=>{
    const room=roomFor(socket);
    if(!member(socket)?.isHost)
      return fail('Завершить фильм может только владелец комнаты.');
    const id=payload?.mediaId;
    if(isToken(id) && id===room.lastFinishedMediaId) return reply({ok:true});
    if(!room.media || id!==room.mediaId) return fail('Фильм уже сменился.');
    room.finishing ||= (async ()=>{
      await tracker.finish(room,true);
      await openChat(room,room.guestId,{mediaId:null,renew:true});
      room.lastFinishedMediaId=id;
      room.media=null;
      room.mediaId=null;
      room.title='';
      room.watchPoster=null;
      room.historyRecorded=false;
      room.time=0;
      room.playing=false;
      room.updated=Date.now();
      room.syncVersion++;
      saveSoon(room);
      await flushSaves();
      broadcast(room,true);
    })().finally(()=>{room.finishing=null});
    await room.finishing;
    reply({ok:true});
  });

  on('sync', 18, payload => {
    const room = roomFor(socket);
    if (!member(socket)?.isHost || !room.media || room.finishing || payload?.mediaId !== room.mediaId) return;
    const time = payload.time;
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > 43200
        || typeof payload.playing !== 'boolean') return;
    const seek = payload.seek === true;
    const changed = room.playing !== payload.playing;
    if (changed || seek) tracker.invalidate(room);
    const duration=payload.duration;
    const validDuration=Number.isFinite(duration) && duration>0 && duration<=43200;
    if(validDuration && !payload.ended && time<=duration+1.5) room.playbackDuration=duration;
    const completed=payload.ended===true && !payload.playing && !seek && room.watchId
      && validDuration && Math.abs(room.playbackDuration-duration)<=1.5 && Math.abs(time-duration)<=1.5
      && Date.now()-room.updated<=10000 && Math.abs(currentTime(room)-duration)<=5;
    if(completed) tracker.finish(room,true).catch(error=>console.warn('Watch close:',error.code||error.name));
    room.time = time;
    room.playing = payload.playing;
    room.updated = Date.now();
    room.syncVersion++;
    socket.to(channel(room.id)).emit('sync', playbackState(room, seek));
    if (room.playing && !room.historyRecorded) {
      recordPlayback(room);
      saveSoon(room);
    }
    if (changed || seek || Date.now() - room.lastCheckpoint > 15000) {
      room.lastCheckpoint = Date.now();
      saveSoon(room);
    }
  });

  on('request-sync', 6, () => {
    if (member(socket)) socket.emit('sync', playbackState(roomFor(socket)));
  });

  onSession('chat',8,async (payload,reply,fail)=>{
    const room=roomFor(socket),user=member(socket);
    if(payload?.room!==room.id||payload.chatId!==room.chatId)return fail('Чат зала обновился. Напиши сообщение заново.');
    const text=clean(payload.text,1000);
    if(!text||!isToken(payload.id))return fail('Сообщение не отправлено');
    const message=await changeChat(room,messages=>{
      if(messages.some(item=>item.author===user.token&&item.clientId===payload.id))return null;
      const item={id:uid(),clientId:payload.id,name:user.name,author:user.token,isHost:user.isHost,
        badge:user.isHost?'👑':room.badges[user.token]||'🎀',text,at:Date.now(),reactions:{}};
      messages.push(item);
      return item;
    });
    if(message)io.to(channel(room.id)).emit('chat',{room:room.id,chatId:room.chatId,...publicMessage(room,message)});
    reply({ok:true});
  });

  onSession('set-badge',6,async (badge,reply,fail)=>{
    const user=member(socket),room=roomFor(socket);
    if(user.isHost||!badges.has(badge))return fail('Недоступный значок');
    await changeChat(room,messages=>{
      for(const item of messages)if(item.author===user.token)item.badge=badge;
    });
    room.badges[user.token]=badge;
    broadcast(room,true);
    saveSoon(room);
    reply({ok:true});
  });

  onSession('react',12,async (payload,reply,fail)=>{
    const user=member(socket),room=roomFor(socket);
    if(!reactions.has(payload?.emoji))return fail('Реакция недоступна');
    const updated=await changeChat(room,messages=>{
      const message=messages.find(item=>item.id===payload.id);
      if(!message)throw new HttpError(404,'Сообщение недоступно');
      const current=message.reactions;
      const selected=current[payload.emoji]?.includes(user.token);
      for(const emoji of Object.keys(current))current[emoji]=current[emoji].filter(token=>token!==user.token);
      if(!selected)(current[payload.emoji]||=[]).push(user.token);
      return current;
    });
    io.to(channel(room.id)).emit('reaction-update',{room:room.id,chatId:room.chatId,
      id:payload.id,reactions:publicReactions(room,updated)});
    reply({ok:true});
  });

  on('wish', 4, (value, reply, fail) => {
    const user = member(socket);
    if (!user) return fail('Сначала войди в комнату');
    const room = roomFor(socket);
    const text = clean(value, 140);
    const to = user.isHost ? room.guestToken : room.hostToken;
    if (!text || !to) return fail('В комнате пока нет второго участника');
    room.letters.push({id: uid(), to, name: user.name, text, read: false, at: Date.now()});
    if (room.letters.length > 200) room.letters.shift();
    sendInbox(room, to);
    saveSoon(room);
    reply({ok: true});
  });

  on('wish-read', 8, (id, reply, fail) => {
    const user = member(socket);
    if (!user) return fail('Сначала войди в комнату');
    const room = roomFor(socket);
    const letter = room.letters.find(item => item.id === id && item.to === user.token);
    if (!letter) return fail('Послание недоступно');
    if (!letter.read) {
      letter.read = true;
      sendInbox(room, user.token);
      saveSoon(room);
    }
    reply({ok: true, name: letter.name, text: letter.text});
  });

  on('poll-create', 4, (values, reply, fail) => {
    const room = roomFor(socket);
    if (!member(socket) || !Array.isArray(values)) return fail('Сначала войди в комнату');
    if (room.poll && !room.poll.finished) return fail('Сначала завершите текущее голосование');
    const options = [...new Set(values.slice(0, 8).map(value => clean(value, 100)).filter(Boolean))];
    if (options.length < 2) return fail('Нужно хотя бы два разных фильма');
    room.poll = {id: uid(), options, votes: Object.create(null), finished: false};
    broadcast(room);
    saveSoon(room);
    reply({ok: true});
  });

  on('poll-vote', 8, (payload, reply, fail) => {
    const user = member(socket);
    const room = roomFor(socket);
    const poll = room?.poll;
    const index = payload?.index;
    if (!user || !poll || poll.finished || payload?.id !== poll.id
        || !Number.isInteger(index) || index < 0 || index >= poll.options.length) {
      return fail('Голосование изменилось или завершилось');
    }
    poll.votes[user.token] = index;
    broadcast(room);
    saveSoon(room);
    reply({ok: true});
  });

  on('poll-finish', 4, (payload, reply, fail) => {
    const room=roomFor(socket);
    const poll = room?.poll;
    if (!member(socket)?.isHost) return fail('Завершить может только создатель');
    if (!poll || poll.id !== payload?.id) return fail('Голосование уже изменилось');
    poll.finished = true;
    broadcast(roomFor(socket));
    saveSoon(room);
    reply({ok: true});
  });

  on('roulette-spin', 3, (entries, reply, fail) => {
    const room = roomFor(socket);
    if (!member(socket) || !Array.isArray(entries)) return fail('Сначала войди в комнату');
    if (room.roulette?.startedAt != null
        && Date.now() < room.roulette.startedAt + room.roulette.duration) {
      return fail('Рулетка уже крутится');
    }
    const items = entries.slice(0, 180)
      .filter(isRecord)
      .map(item => {
        const name=clean(item.name,120);
        return {name,poster:posterUrl(item.poster)||catalogPoster(name)};
      })
      .filter(item => item.name);
    if (!items.length) return fail('В списке нет фильмов для рулетки');
    room.roulette = {id: uid(), cards: makeCards(items), winnerIndex, startedAt: Date.now(), duration: spinDuration};
    io.to(channel(room.id)).emit('roulette', {room: room.id, spin: room.roulette});
    saveSoon(room);
    reply({ok: true});
  });

  socket.on('disconnect', () => {
    clearTimeout(expiry);
    leave(socket);
  });
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(leaseTimer);
  await Promise.allSettled([...roomQueues.values()]);
  for(const room of rooms.values()) {
    await room.finishing?.catch(()=>{});
    await tracker.finish(room).catch(()=>{});
    dirtyRooms.add(room);
  }
  let saved=await flushSaves();
  if(!saved&&dirtyRooms.size)saved=await flushSaves();
  if(!saved)console.warn('Room checkpoint incomplete at shutdown');
  io.close(async ()=>{
    try{await closeDatabase();process.exit(saved?0:1)}
    catch{process.exit(1)}
  });
}

return {shutdown};
}
