import {parseMedia} from './media.js';
import express from 'express';
import {createServer} from 'node:http';
import {Server} from 'socket.io';
import crypto from 'node:crypto';
import {isIP} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {query,close as closeDatabase} from './lib/db.js';
import {authFor,sessionActive,mountAuth} from './lib/auth.js';
import {HttpError,apiErrors,sameOrigin,uuid} from './lib/http.js';
import {ownRoom,getRoomRecord,admitGuest,newInvite,saveRoom} from './lib/rooms.js';
import {mountProfiles} from './lib/profiles.js';
import {mountMessages} from './lib/messages.js';
import {mountAvatars} from './lib/avatars.js';
import {createWatchTracker} from './lib/watch.js';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy',1);
const http = createServer(app);
const io = new Server(http, {maxHttpBufferSize: 100_000});
const rooms = new Map();
const tracker=createWatchTracker();
const maxRooms = 500;
const maxConnections = 200;
const spinDuration = 5000;
const winnerIndex = 24;
const badges = new Set(['🎀', '🐈', '🦊', '💖', '🐒']);
const reactions = new Set(['🔥', '🥹', '😍', '🤤', '❤️']);
const uid = () => crypto.randomBytes(16).toString('hex');
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRoom = value => typeof value === 'string' && /^[\w-]{3,80}$/.test(value);
const isToken = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const channel = id => 'cinema:' + id;
const array = value => Array.isArray(value) ? value.filter(isRecord) : [];

function currentTime(room) {
  const elapsed = room.playing ? Math.max(0, Date.now() - room.updated) / 1000 : 0;
  return Math.min(43200, room.time + elapsed);
}

function makeRoom(id, hostToken, hostName) {
  return {
    id, hostToken, hostName, guestToken: null, identityKey: uid(), users: new Map(),
    history: [], watchEpoch: 0, watchId: null, watchLast: 0,
    media: null, mediaId: null, title: '', historyRecorded: false,
    time: 0, playing: false, updated: Date.now(), lastCheckpoint: 0, syncVersion: 0,
    messages: [], badges: Object.create(null), letters: [], poll: null,
    roulette: null
  };
}

function restorePoll(poll) {
  if (!isRecord(poll) || !Array.isArray(poll.options)) return null;
  const options = poll.options.slice(0, 8);
  if (options.length < 2 || options.some(option => typeof option !== 'string')) return null;
  const votes = Object.create(null);
  for (const [token, choice] of Object.entries(poll.votes || {})) {
    if (isToken(token) && Number.isInteger(choice) && choice >= 0 && choice < options.length) {
      votes[token] = choice;
    }
  }
  return {id: isToken(poll.id) ? poll.id : uid(), options, votes, finished: !!poll.finished};
}

function restoreRoulette(saved) {
  if (!isRecord(saved) || !isToken(saved.id)) return null;
  const cards = array(saved.cards);
  if (cards.length && Number.isFinite(saved.startedAt) && Number.isInteger(saved.winnerIndex)
      && cards[saved.winnerIndex]?.name) {
    return {id: saved.id, cards, winnerIndex: saved.winnerIndex, startedAt: saved.startedAt, duration: spinDuration};
  }
  const winner = array(saved.items)[saved.winner];
  if (!winner?.name) return null;
  return {id: saved.id, cards: [winner], winnerIndex: 0, startedAt: 0, duration: spinDuration};
}

function hydrateRoom(record, nickname) {
  const {id}=record;
  if(rooms.has(id)) return rooms.get(id);
  const saved=isRecord(record.state)?record.state:{};
  const hostToken=isToken(saved.hostToken)?saved.hostToken:record.owner_id.replaceAll('-','');
  const room=makeRoom(id,hostToken,clean(nickname||saved.hostName,40)||'Создатель');
  room.ownerId=record.owner_id;
  room.guestId=record.guest_id;
  room.guestToken=record.guest_id?.replaceAll('-','') || null;
  room.identityKey=isToken(saved.identityKey)?saved.identityKey:room.identityKey;
  room.media=isRecord(saved.media)?saved.media:null;
  room.mediaId=room.media?(isToken(saved.mediaId)?saved.mediaId:uid()):null;
  room.title=clean(saved.title,120);
  room.watchPoster=localPoster(saved.watchPoster);
  room.historyRecorded=!!saved.historyRecorded;
  room.time=Number.isFinite(saved.time)?Math.max(0,Math.min(saved.time,43200)):0;
  room.messages=array(saved.messages).slice(-250);
  for(const [key,badge] of Object.entries(saved.badges||{})){
    if(isToken(key)&&badges.has(badge)) room.badges[key]=badge;
  }
  room.letters=array(saved.letters).slice(-200);
  room.poll=restorePoll(saved.poll);
  room.roulette=restoreRoulette(saved.roulette);
  room.history=array(record.history).slice(-100);
  rooms.set(id,room);
  return room;
}

function snapshotRoom(room) {
  return {
    authVersion:2,hostToken:room.hostToken,guestToken:room.guestToken,hostName:room.hostName,
    identityKey:room.identityKey,media:room.media,mediaId:room.mediaId,title:room.title,
    watchPoster:room.watchPoster,historyRecorded:room.historyRecorded,time:currentTime(room),
    messages:room.messages,badges:room.badges,letters:room.letters,poll:room.poll,
    roulette:room.roulette?.startedAt!=null?room.roulette:null
  };
}

const dirtyRooms=new Set();
let saveTimer;
let writeQueue=Promise.resolve(true);
function flushSaves() {
  clearTimeout(saveTimer);
  saveTimer=null;
  if(!dirtyRooms.size) return writeQueue;
  const roomsToWrite=[...dirtyRooms];
  dirtyRooms.clear();
  writeQueue=writeQueue.then(async ()=>{
    let ok=true;
    for(const room of roomsToWrite){
      try { await saveRoom(room.id,snapshotRoom(room),room.history); }
      catch(error){
        ok=false;
        dirtyRooms.add(room);
        console.warn('Unable to save room:',error.code||error.name);
      }
    }
    if(dirtyRooms.size&&!saveTimer&&!shuttingDown) {
      saveTimer=setTimeout(flushSaves,2000);
      saveTimer.unref();
    }
    return ok;
  });
  return writeQueue;
}
function saveSoon(room) {
  dirtyRooms.add(room);
  if(!saveTimer){
    saveTimer=setTimeout(flushSaves,400);
    saveTimer.unref();
  }
}
function localPoster(value) {
  return typeof value==='string'&&/^posters\/[a-z0-9-]+\.webp$/i.test(value)?value:null;
}

const roomFor = socket => rooms.get(socket.data.room);
function member(socket) {
  const room=roomFor(socket);
  const user=room?.users.get(socket.id);
  return user && user.accountId===(user.isHost?room.ownerId:room.guestId)?user:null;
}

function publicId(room, token) {
  return crypto.createHmac('sha256', room.identityKey).update(typeof token === 'string' ? token : '').digest('hex');
}

function publicReactions(room, value) {
  const entries = [];
  for (const [emoji, tokens] of Object.entries(value || {})) {
    if (reactions.has(emoji) && Array.isArray(tokens)) {
      entries.push([emoji, tokens.filter(isToken).map(token => publicId(room, token))]);
    }
  }
  return Object.fromEntries(entries);
}

function publicMessage(room, message) {
  return {
    id: message.id, name: message.name, author: publicId(room, message.author),
    isHost: !!message.isHost, badge: message.badge, text: message.text, at: message.at,
    reactions: publicReactions(room, message.reactions)
  };
}

function userList(room) {
  const participants = new Map();
  for (const user of room.users.values()) {
    participants.set(user.token, {
      id: publicId(room, user.token), name: user.name, accountId:user.accountId, isHost: user.isHost,
      badge: user.isHost ? '👑' : room.badges[user.token] || '🎀'
    });
  }
  return [...participants.values()];
}

function publicPoll(poll, token) {
  if (!poll) return null;
  const votes = Object.values(poll.votes);
  const counts = poll.finished ? poll.options.map((_, i) => votes.filter(v => v === i).length) : null;
  return {
    id: poll.id, options: poll.options, finished: poll.finished, voteCount: votes.length, counts,
    myChoice: poll.votes[token] ?? null
  };
}

function playbackState(room, seek = false) {
  return {
    room: room.id, mediaId: room.mediaId, time: currentTime(room), playing: room.playing,
    serverTime: Date.now(), version: room.syncVersion, seek
  };
}

function sharedState(room, withMessages = false) {
  const state = {
    ...playbackState(room), users: userList(room), hostName: room.hostName,
    media: room.media, title: room.title, roulette: room.roulette
  };
  if (withMessages) state.messages = room.messages.map(message => publicMessage(room, message));
  return state;
}

function broadcast(room, withMessages = false) {
  const state = sharedState(room, withMessages);
  for (const user of room.users.values()) {
    user.socket.emit('room-state', {...state, poll: publicPoll(room.poll, user.token)});
  }
}

function inbox(room, token) {
  return room.letters.filter(letter => letter.to === token).map(letter => ({
    id: letter.id, name: letter.name, read: !!letter.read, text: letter.read ? letter.text : null, at: letter.at
  }));
}

function sendInbox(room, token) {
  const payload = {room: room.id, items: inbox(room, token)};
  for (const user of room.users.values()) {
    if (user.token === token) user.socket.emit('wish-inbox', payload);
  }
}

function roomHistory(room) {
  return room.history.slice(-100).reverse().map(({room, ...item})=>item);
}
function recordPlayback(room) {
  if(room.historyRecorded) return;
  room.history.push({room:room.id,id:room.mediaId,title:room.title,url:room.media.url,at:new Date().toISOString()});
  room.history=room.history.slice(-100);
  room.historyRecorded=true;
  saveSoon(room);
  io.to(channel(room.id)).emit('cinema-history',{room:room.id,items:roomHistory(room)});
}

function defaultTitle(media) {
  if (media.type === 'youtube') return 'YouTube';
  if (media.type === 'vk') return 'VK Видео';
  try {
    return clean(decodeURIComponent(new URL(media.url).pathname.split('/').at(-1)), 120) || 'Видео';
  } catch {
    return 'Видео';
  }
}

function posterUrl(value) {
  if (typeof value !== 'string' || value.length > 1200) return null;
  if (/^posters\/[a-z0-9-]+\.webp$/i.test(value)) return value;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(host)
        || !host.includes('.') || /\.(local|localhost|internal|test|invalid)$/i.test(host)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function makeCards(items) {
  const cards = [];
  while (cards.length < 28) {
    const batch = items.slice();
    for (let i = batch.length - 1; i > 0; i--) {
      const other = crypto.randomInt(i + 1);
      [batch[i], batch[other]] = [batch[other], batch[i]];
    }
    cards.push(...batch.slice(0, 28 - cards.length));
  }
  cards[winnerIndex] = items[crypto.randomInt(items.length)];
  return cards;
}

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
    tracker.finish(room).catch(error=>console.warn('Watch close:',error.code||error.name));
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

  on('join', 5, async (payload, reply, fail) => {
    if (joining) return fail('Вход уже выполняется');
    const auth=socket.data.auth;
    if (payload?.room && !isRoom(payload.room)) return fail('Ссылка на комнату некорректна');
    joining=true;
    try {
      const record=payload?.room?await getRoomRecord(payload.room):await ownRoom(auth);
      if(!record) return fail('Комната не найдена. Попроси создателя прислать ссылку.');
      if(rooms.size>=maxRooms && !rooms.has(record.id)) {
        const free=[...rooms.values()].find(r=>!r.users.size&&!dirtyRooms.has(r));
        if(free) rooms.delete(free.id);
        else return fail('Сервер пока не может открыть ещё одну комнату.');
      }
      const room=hydrateRoom(record,record.owner_id===auth.id?auth.nickname:null);
      const access=await admitGuest(record.id,auth.id,payload?.invite,
        ()=>[...room.users.values()].some(user=>!user.isHost && user.accountId!==auth.id));
      if(!socket.connected) return;
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
    } finally { joining=false; }
  });

  on('invite', 4, async (_, reply, fail) => {
    const room=roomFor(socket);
    if(!room || !member(socket)?.isHost) return fail('Пригласить может создатель комнаты');
    reply({ok:true,...await newInvite(socket.data.auth)});
  });

  on('watch-heartbeat', 4, async payload=>{
    const room=roomFor(socket);
    if(member(socket)) await tracker.report(socket,room,payload);
  });

  on('media', 4, (payload, reply, fail) => {
    const room = roomFor(socket);
    if (!member(socket)?.isHost) return fail('Менять фильм может только создатель');
    const media = parseMedia(payload?.url);
    if (!media) return fail('Поддерживаются YouTube, VK Видео и прямые HTTPS-ссылки MP4/WebM');
    tracker.finish(room).catch(error=>console.warn('Watch close:',error.code||error.name));
    room.media = media;
    room.watchPoster=localPoster(payload?.poster);
    room.mediaId = uid();
    room.title = clean(payload?.title, 120) || defaultTitle(media);
    room.historyRecorded = false;
    room.time = 0;
    room.playing = false;
    room.updated = Date.now();
    room.syncVersion++;
    broadcast(room);
    saveSoon(room);
    reply({ok: true});
  });

  on('sync', 18, payload => {
    const room = roomFor(socket);
    if (!member(socket)?.isHost || !room.media || payload?.mediaId !== room.mediaId) return;
    const time = payload.time;
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > 43200
        || typeof payload.playing !== 'boolean') return;
    const seek = payload.seek === true;
    const changed = room.playing !== payload.playing;
    if (changed || seek) tracker.invalidate(room);
    if (payload.ended===true && !payload.playing) tracker.finish(room,true).catch(error=>console.warn('Watch close:',error.code||error.name));
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

  on('chat', 8, async (payload, reply, fail) => {
    const room = roomFor(socket);
    const user = member(socket);
    if (!user || payload?.room !== room.id) return fail('Сначала войди в комнату');
    const text = clean(payload.text, 1000);
    if (!text || !isToken(payload.id)) return fail('Сообщение не отправлено');
    const prior = room.messages.find(message => message.author === user.token && message.clientId === payload.id);
    if (prior) return await flushSaves()?reply({ok:true}):fail('Чат не сохранился. Повтори отправку.');
    const message = {
      id: uid(), clientId: payload.id, name: user.name, author: user.token,
      isHost: user.isHost, badge: user.isHost ? '👑' : room.badges[user.token] || '🎀',
      text, at: Date.now(), reactions: {}
    };
    room.messages.push(message);
    if (room.messages.length > 250) room.messages.shift();
    saveSoon(room);
    const stored=await flushSaves();
    io.to(channel(room.id)).emit('chat', {room: room.id, ...publicMessage(room, message)});
    if(stored) reply({ok:true});
    else fail('Чат не сохранился. Повтори отправку.');
  });

  on('set-badge', 6, (badge, reply, fail) => {
    const user = member(socket);
    if (!user || user.isHost || !badges.has(badge)) return fail('Недоступный значок');
    const room = roomFor(socket);
    room.badges[user.token] = badge;
    for (const message of room.messages) {
      if (message.author === user.token) message.badge = badge;
    }
    broadcast(room, true);
    saveSoon(room);
    reply({ok: true});
  });

  on('react', 12, (payload, reply, fail) => {
    const user = member(socket);
    if (!user || !reactions.has(payload?.emoji)) return fail('Реакция недоступна');
    const room = roomFor(socket);
    const message = room.messages.find(item => item.id === payload.id);
    if (!message) return fail('Сообщение недоступно');
    const previous = message.reactions || {};
    const selected = Array.isArray(previous[payload.emoji]) && previous[payload.emoji].includes(user.token);
    const updated = {};
    for (const [emoji, users] of Object.entries(previous)) {
      if (reactions.has(emoji) && Array.isArray(users)) updated[emoji] = users.filter(token => token !== user.token);
    }
    if (!selected) (updated[payload.emoji] ||= []).push(user.token);
    message.reactions = updated;
    io.to(channel(room.id)).emit('reaction-update', {
      room: room.id, id: message.id, reactions: publicReactions(room, updated)
    });
    saveSoon(room);
    reply({ok: true});
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
      .map(item => ({name: clean(item.name, 120), poster: posterUrl(item.poster)}))
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

app.use((_, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use('/api',(req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!sameOrigin(req)) {
    return res.status(403).json({error:'Открой сайт и повтори действие.'});
  }
  next();
});
app.use('/api',express.json({limit:'24kb'}));
mountAuth(app,session=>io.in('session:'+session).disconnectSockets(true));
mountProfiles(app,io);
mountMessages(app,io);
mountAvatars(app);
app.use(apiErrors);
app.get('/health',(_,res)=>res.json({ok:true}));
app.get('/ready',async (_,res)=>{
  try { await query('SELECT 1'); res.json({ok:true}); }
  catch { res.status(503).json({ok:false}); }
});
app.get(['/profile','/profile/:id','/friends','/messages','/messages/:id'],(_,res)=>{
  res.set('Cache-Control','no-cache');
  res.sendFile(path.join(projectDir,'social.html'));
});
app.get(['/', '/index.html'], (_, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(projectDir, 'index.html'));
});
for (const asset of ['app.js','cinema-ui.js','player.css','social.js','social.css','account.js','cinema-moon.webp']) {
  app.get('/' + asset, (_, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(projectDir, asset));
  });
}
app.get('/posters/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-z0-9][a-z0-9-]*\.webp$/i.test(filename)) return res.sendStatus(404);
  res.sendFile(path.join(projectDir, 'posters', filename), {maxAge: '1d'}, error => {
    if (error && !res.headersSent) res.sendStatus(error.status === 404 ? 404 : 500);
  });
});

const port = Number(process.env.PORT) || 3000;
http.listen(port, '0.0.0.0', () => console.log('REMEDIUM CINEMA COSMOS listening on ' + port));

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for(const room of rooms.values()) {
    await tracker.finish(room).catch(()=>{});
    dirtyRooms.add(room);
  }
  await flushSaves();
  io.close(async ()=>{ await closeDatabase(); process.exit(0); });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
