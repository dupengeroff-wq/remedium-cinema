import {uid,clean,isRecord,isToken,array,badges,spinDuration} from '../config/room.js';
import {posterUrl} from '../modules/watch/media.js';

export function currentTime(room) {
  const elapsed = room.playing ? Math.max(0, Date.now() - room.updated) / 1000 : 0;
  return Math.min(43200, room.time + elapsed);
}

function makeRoom(id, hostToken, hostName) {
  return {
    id, hostToken, hostName, guestToken: null, identityKey: uid(), users: new Map(),
    history: [], watchEpoch: 0, watchId: null, watchLast: 0,
    media: null, mediaId: null, title: '', historyRecorded: false,
    time: 0, playing: false, updated: Date.now(), lastCheckpoint: 0, syncVersion: 0,
    chatId: uid(), messages: [], badges: Object.create(null), letters: [], poll: null,
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


export function snapshotRoom(room) {
  return {
    authVersion:2,hostToken:room.hostToken,guestToken:room.guestToken,hostName:room.hostName,
    identityKey:room.identityKey,media:room.media,mediaId:room.mediaId,title:room.title,
    watchPoster:room.watchPoster,lastFinishedMediaId:room.lastFinishedMediaId,historyRecorded:room.historyRecorded,time:currentTime(room),
    badges:room.badges,letters:room.letters,poll:room.poll,
    roulette:room.roulette?.startedAt!=null?room.roulette:null
  };
}

export function createRoomState() {
const rooms = new Map();
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
  room.watchPoster=posterUrl(saved.watchPoster);
  room.lastFinishedMediaId=isToken(saved.lastFinishedMediaId)?saved.lastFinishedMediaId:null;
  room.historyRecorded=!!saved.historyRecorded;
  room.time=Number.isFinite(saved.time)?Math.max(0,Math.min(saved.time,43200)):0;
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

const roomFor = socket => rooms.get(socket.data.room);
function member(socket) {
  const room=roomFor(socket);
  const user=room?.users.get(socket.id);
  return user && user.accountId===(user.isHost?room.ownerId:room.guestId)?user:null;
}

return {rooms,hydrateRoom,roomFor,member};
}
