import {parseMedia} from './media.js';
import express from 'express';
import {createServer} from 'node:http';
import {Server} from 'socket.io';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {isIP} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.CINEMA_DATA_DIR ? path.resolve(process.env.CINEMA_DATA_DIR) : projectDir;
fs.mkdirSync(dataDir, {recursive: true, mode: 0o700});
const dataFile = path.join(dataDir, 'cinema-data.json');
const historyFile = path.join(dataDir, 'cinema-history.json');
const app = express();
app.disable('x-powered-by');
const http = createServer(app);
const io = new Server(http, {maxHttpBufferSize: 100_000});
const rooms = new Map();
const maxRooms = 500;
const maxConnections = 200;
const spinDuration = 5000;
const spinLead = 900;
const posterWait = 5500;
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

const blockedFiles = new Set();
function readFile(file, fallback, valid) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!valid(value)) throw new Error('invalid format');
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try {
        fs.copyFileSync(file, file + '.backup-' + Date.now(), fs.constants.COPYFILE_EXCL);
      } catch {
        blockedFiles.add(file);
      }
      console.warn('Unable to read ' + path.basename(file) + ': ' + error.message);
    }
    return fallback;
  }
}

let history = array(readFile(historyFile, [], Array.isArray));

function currentTime(room) {
  const elapsed = room.playing ? Math.max(0, Date.now() - room.updated) / 1000 : 0;
  return Math.min(43200, room.time + elapsed);
}

function makeRoom(id, hostToken, hostName) {
  return {
    id, hostToken, hostName, guestToken: null, invite: null, identityKey: uid(),
    rotateHost: false, rotateGuest: false, users: new Map(),
    media: null, mediaId: null, title: '', historyRecorded: false,
    time: 0, playing: false, updated: Date.now(), lastCheckpoint: 0, syncVersion: 0,
    messages: [], badges: Object.create(null), letters: [], poll: null,
    roulette: null, preparation: null
  };
}

function legacyGuest(saved) {
  const candidates = new Set([
    ...array(saved.messages).filter(m => !m.isHost).map(m => m.author),
    ...array(saved.letters).map(letter => letter.to),
    ...Object.keys(saved.badges || {}),
    ...Object.keys(saved.poll?.votes || {})
  ].filter(token => isToken(token) && token !== saved.hostToken));
  return candidates.size === 1 ? [...candidates][0] : null;
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

const savedRooms = readFile(dataFile, {}, isRecord);
for (const [id, saved] of Object.entries(savedRooms)) {
  if (!isRoom(id) || !isRecord(saved) || !isToken(saved.hostToken)) continue;
  const room = makeRoom(id, saved.hostToken, clean(saved.hostName, 24) || 'Создатель');
  const legacy = saved.authVersion !== 2;
  room.guestToken = legacy ? legacyGuest(saved) : isToken(saved.guestToken) ? saved.guestToken : null;
  room.invite = isToken(saved.invite) ? saved.invite : null;
  room.identityKey = isToken(saved.identityKey) ? saved.identityKey : room.identityKey;
  room.rotateHost = legacy || saved.rotateHost === true;
  room.rotateGuest = !!room.guestToken && (legacy || saved.rotateGuest === true);
  room.media = isRecord(saved.media) ? saved.media : null;
  room.mediaId = room.media ? isToken(saved.mediaId) ? saved.mediaId : uid() : null;
  room.title = clean(saved.title, 120);
  room.historyRecorded = saved.historyRecorded === true || (legacy && !!room.media
    && history.some(item => item.room === id && item.url === room.media.url));
  room.time = Number.isFinite(saved.time) ? Math.max(0, Math.min(saved.time, 43200)) : 0;
  room.messages = array(saved.messages).slice(-250);
  for (const [key, badge] of Object.entries(saved.badges || {})) {
    if (isToken(key) && badges.has(badge)) room.badges[key] = badge;
  }
  room.letters = array(saved.letters).slice(-200);
  room.poll = restorePoll(saved.poll);
  room.roulette = restoreRoulette(saved.roulette);
  rooms.set(id, room);
}

function savedRoomState() {
  return Object.fromEntries([...rooms].map(([id, room]) => [id, {
    authVersion: 2, hostToken: room.hostToken, guestToken: room.guestToken, hostName: room.hostName,
    invite: room.invite, identityKey: room.identityKey, rotateHost: room.rotateHost, rotateGuest: room.rotateGuest,
    media: room.media, mediaId: room.mediaId, title: room.title, historyRecorded: room.historyRecorded,
    time: currentTime(room), messages: room.messages, badges: room.badges,
    letters: room.letters, poll: room.poll,
    roulette: room.roulette?.startedAt != null ? room.roulette : null
  }]));
}

let saveTimer;
let writeQueue = Promise.resolve(true);
const pendingFiles = new Set();

function flushSaves() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!pendingFiles.size) return writeQueue;
  const files = [...pendingFiles];
  pendingFiles.clear();
  writeQueue = writeQueue.then(async () => {
    let saved = true;
    for (const file of files) {
      if (blockedFiles.has(file)) {
        saved = false;
        continue;
      }
      const tmp = file + '.' + uid() + '.tmp';
      try {
        const snapshot = file === dataFile ? savedRoomState() : history;
        await fs.promises.writeFile(tmp, JSON.stringify(snapshot), {mode: 0o600, flag: 'wx'});
        await fs.promises.rename(tmp, file);
      } catch (error) {
        saved = false;
        await fs.promises.unlink(tmp).catch(() => {});
        console.warn('Unable to save ' + path.basename(file) + ': ' + error.message);
        pendingFiles.add(file);
      }
    }
    if (pendingFiles.size && !saveTimer && !shuttingDown) {
      saveTimer = setTimeout(flushSaves, 2000);
      saveTimer.unref();
    }
    return saved;
  });
  return writeQueue;
}

function saveSoon(file = dataFile) {
  pendingFiles.add(file);
  if (!saveTimer) {
    saveTimer = setTimeout(flushSaves, 400);
    saveTimer.unref();
  }
}

function replaceToken(room, oldToken, newToken) {
  for (const message of room.messages) {
    if (message.author === oldToken) message.author = newToken;
    for (const [emoji, tokens] of Object.entries(message.reactions || {})) {
      if (Array.isArray(tokens)) message.reactions[emoji] = tokens.map(token => token === oldToken ? newToken : token);
    }
  }
  for (const letter of room.letters) {
    if (letter.to === oldToken) letter.to = newToken;
  }
  if (Object.hasOwn(room.badges, oldToken)) {
    room.badges[newToken] = room.badges[oldToken];
    delete room.badges[oldToken];
  }
  if (room.poll && Object.hasOwn(room.poll.votes, oldToken)) {
    room.poll.votes[newToken] = room.poll.votes[oldToken];
    delete room.poll.votes[oldToken];
  }
}

const member = socket => rooms.get(socket.data.room)?.users.get(socket.id);
const roomFor = socket => rooms.get(socket.data.room);

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
      id: publicId(room, user.token), name: user.name, isHost: user.isHost,
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
  return history.filter(item => item.room === room.id).slice(-100).reverse().map(({room, ...item}) => item);
}

function recordPlayback(room) {
  if (room.historyRecorded) return;
  const entry = {room: room.id, id: room.mediaId, title: room.title, url: room.media.url, at: new Date().toISOString()};
  history = [...history, entry];
  const own = history.filter(item => item.room === room.id);
  if (own.length > 100) {
    const keep = new Set(own.slice(-100));
    history = history.filter(item => item.room !== room.id || keep.has(item));
  }
  room.historyRecorded = true;
  saveSoon(historyFile);
  io.to(channel(room.id)).emit('cinema-history', {room: room.id, items: roomHistory(room)});
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

function startRoulette(room) {
  if (!room.preparation) return;
  clearTimeout(room.preparation.timer);
  room.preparation = null;
  room.roulette.startedAt = Date.now() + spinLead;
  io.to(channel(room.id)).emit('roulette', {room: room.id, spin: room.roulette});
  saveSoon();
}

function leave(socket) {
  const room = roomFor(socket);
  if (!room) return;
  room.users.delete(socket.id);
  socket.data.room = null;
  socket.leave(channel(room.id));
  if (room.preparation) {
    room.preparation.pending.delete(socket.id);
    if (!room.users.size) {
      clearTimeout(room.preparation.timer);
      room.preparation = null;
      room.roulette = null;
    } else if (!room.preparation.pending.size) {
      startRoulette(room);
    }
  }
  if (!room.users.size && room.playing) {
    room.time = currentTime(room);
    room.playing = false;
    room.updated = Date.now();
    room.syncVersion++;
    saveSoon();
  }
  broadcast(room);
}

let shuttingDown = false;
const recentCreations = [];

io.use((_, next) => {
  if (shuttingDown || io.sockets.sockets.size >= maxConnections) {
    return next(new Error('Сервер занят. Попробуй чуть позже.'));
  }
  next();
});

io.on('connection', socket => {
  const rate = new Map();
  let joining = false;

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
        await handle(args[0], reply, fail);
      } catch (error) {
        console.warn('Cinema event ' + event + ': ' + error.message);
        fail('Сервер не смог выполнить действие. Попробуй ещё раз.');
      }
    });
  }

  on('join', 5, async (payload, reply, fail) => {
    if (joining) return fail('Вход уже выполняется');
    const id = payload?.room;
    const name = clean(payload?.name, 24);
    const token = isToken(payload?.token) ? payload.token : null;
    const next = isToken(payload?.nextToken) ? payload.nextToken : null;
    if (!isRoom(id) || !name || !next) return fail('Укажи имя и корректный код или ссылку');
    joining = true;
    try {
      let room = rooms.get(id);
      let changed = false;
      if (!room) {
        if (payload.create !== true || !isToken(id)) return fail('Комната не найдена. Проверь ссылку у создателя.');
        if (rooms.size >= maxRooms) return fail('Сервер пока не может создать новую комнату');
        const now = Date.now();
        while (recentCreations.length && recentCreations[0] < now - 60000) recentCreations.shift();
        if (recentCreations.length >= 20) return fail('Сейчас создаётся слишком много комнат. Попробуй чуть позже.');
        recentCreations.push(now);
        room = makeRoom(id, next, name);
        rooms.set(id, room);
        changed = true;
      }
      let isHost = token === room.hostToken || next === room.hostToken;
      let own = isHost ? room.hostToken : room.guestToken;
      const knownGuest = !!own && (token === own || next === own);
      if (isHost || knownGuest) {
        const needsRotation = isHost ? room.rotateHost : room.rotateGuest;
        if (needsRotation) {
          if (next === own || next === (isHost ? room.guestToken : room.hostToken)) {
            return fail('Обнови страницу и войди ещё раз');
          }
          replaceToken(room, own, next);
          if (isHost) {
            room.hostToken = next;
            room.rotateHost = false;
          } else {
            room.guestToken = next;
            room.rotateGuest = false;
          }
          own = next;
          changed = true;
        }
      } else {
        if (payload.create === true || !room.invite || payload.invite !== room.invite) {
          return fail('Нужна свежая ссылка от создателя комнаты.');
        }
        if ([...room.users.values()].some(user => !user.isHost)) {
          return fail('В комнате уже есть второй участник');
        }
        if (room.guestToken) {
          delete room.badges[room.guestToken];
          if (room.poll && !room.poll.finished) delete room.poll.votes[room.guestToken];
        }
        room.guestToken = next;
        room.rotateGuest = false;
        room.invite = null;
        own = next;
        changed = true;
      }
      if ([...room.users.values()].filter(user => user.token === own && user.socket !== socket).length >= 3) {
        return fail('Закрой лишние вкладки этой комнаты');
      }
      if (isHost && room.hostName !== name) {
        room.hostName = name;
        changed = true;
      }
      let durable = true;
      if (changed) {
        saveSoon();
        durable = await flushSaves();
      }
      if (socket.connected === false) return;
      if (own !== (isHost ? room.hostToken : room.guestToken)) return fail('Ссылка изменилась. Войди снова.');
      if ([...room.users.values()].filter(user => user.token === own && user.socket !== socket).length >= 3) {
        return fail('Закрой лишние вкладки этой комнаты');
      }
      if (socket.data.room !== id) leave(socket);
      socket.data.room = id;
      socket.join(channel(id));
      room.users.set(socket.id, {socket, name, token: own, isHost});
      reply({
        ok: true, id: publicId(room, own), token: own, isHost, durable,
        state: {...sharedState(room, true), poll: publicPoll(room.poll, own)},
        inbox: inbox(room, own), history: roomHistory(room)
      });
      broadcast(room);
    } finally {
      joining = false;
    }
  });

  on('invite', 4, async (_, reply, fail) => {
    const room = roomFor(socket);
    if (!member(socket)?.isHost) return fail('Пригласить может создатель комнаты');
    const invite = uid();
    room.invite = invite;
    saveSoon();
    await flushSaves();
    if (room.invite !== invite) return fail('Приглашение уже обновилось');
    reply({ok: true, invite});
  });

  on('media', 4, (payload, reply, fail) => {
    const room = roomFor(socket);
    if (!member(socket)?.isHost) return fail('Менять фильм может только создатель');
    const media = parseMedia(payload?.url);
    if (!media) return fail('Поддерживаются YouTube, VK Видео и прямые HTTPS-ссылки MP4/WebM');
    room.media = media;
    room.mediaId = uid();
    room.title = clean(payload?.title, 120) || defaultTitle(media);
    room.historyRecorded = false;
    room.time = 0;
    room.playing = false;
    room.updated = Date.now();
    room.syncVersion++;
    broadcast(room);
    saveSoon();
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
    room.time = time;
    room.playing = payload.playing;
    room.updated = Date.now();
    room.syncVersion++;
    socket.to(channel(room.id)).emit('sync', playbackState(room, seek));
    if (room.playing && !room.historyRecorded) {
      recordPlayback(room);
      saveSoon();
    }
    if (changed || seek || Date.now() - room.lastCheckpoint > 15000) {
      room.lastCheckpoint = Date.now();
      saveSoon();
    }
  });

  on('request-sync', 6, () => {
    if (member(socket)) socket.emit('sync', playbackState(roomFor(socket)));
  });

  on('chat', 8, (payload, reply, fail) => {
    const room = roomFor(socket);
    const user = member(socket);
    if (!user || payload?.room !== room.id) return fail('Сначала войди в комнату');
    const text = clean(payload.text, 1000);
    if (!text || !isToken(payload.id)) return fail('Сообщение не отправлено');
    const prior = room.messages.find(message => message.author === user.token && message.clientId === payload.id);
    if (prior) return reply({ok: true});
    const message = {
      id: uid(), clientId: payload.id, name: user.name, author: user.token,
      isHost: user.isHost, badge: user.isHost ? '👑' : room.badges[user.token] || '🎀',
      text, at: Date.now(), reactions: {}
    };
    room.messages.push(message);
    if (room.messages.length > 250) room.messages.shift();
    io.to(channel(room.id)).emit('chat', {room: room.id, ...publicMessage(room, message)});
    saveSoon();
    reply({ok: true});
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
    saveSoon();
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
    saveSoon();
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
    saveSoon();
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
      saveSoon();
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
    saveSoon();
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
    saveSoon();
    reply({ok: true});
  });

  on('poll-finish', 4, (payload, reply, fail) => {
    const poll = roomFor(socket)?.poll;
    if (!member(socket)?.isHost) return fail('Завершить может только создатель');
    if (!poll || poll.id !== payload?.id) return fail('Голосование уже изменилось');
    poll.finished = true;
    broadcast(roomFor(socket));
    saveSoon();
    reply({ok: true});
  });

  on('roulette-spin', 3, (entries, reply, fail) => {
    const room = roomFor(socket);
    if (!member(socket) || !Array.isArray(entries)) return fail('Сначала войди в комнату');
    if (room.preparation || (room.roulette?.startedAt != null
        && Date.now() < room.roulette.startedAt + room.roulette.duration)) {
      return fail('Рулетка уже крутится');
    }
    const items = entries.slice(0, 180)
      .filter(isRecord)
      .map(item => ({name: clean(item.name, 120), poster: posterUrl(item.poster)}))
      .filter(item => item.name);
    if (!items.length) return fail('В списке нет фильмов для рулетки');
    room.roulette = {id: uid(), cards: makeCards(items), winnerIndex, startedAt: null, duration: spinDuration};
    room.preparation = {pending: new Set(room.users.keys()), timer: setTimeout(() => startRoulette(room), posterWait)};
    room.preparation.timer.unref();
    io.to(channel(room.id)).emit('roulette', {room: room.id, spin: room.roulette});
    reply({ok: true});
  });

  on('roulette-ready', 6, payload => {
    const room = roomFor(socket);
    if (!member(socket) || !room.preparation || room.roulette.id !== payload?.id) return;
    room.preparation.pending.delete(socket.id);
    if (!room.preparation.pending.size) startRoulette(room);
  });

  socket.on('disconnect', () => leave(socket));
});

app.use((_, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.get('/health', (_, res) => res.json({ok: true}));
app.get(['/', '/index.html'], (_, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(projectDir, 'index.html'));
});
for (const asset of ['app.js', 'cinema-ui.js', 'player.css']) {
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
  saveSoon();
  await flushSaves();
  io.close(() => process.exit(0));
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
