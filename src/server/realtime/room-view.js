import crypto from 'node:crypto';
import {reactions,isToken} from '../config/room.js';
import {currentTime} from './room-state.js';

export function publicId(room, token) {
  return crypto.createHmac('sha256', room.identityKey).update(typeof token === 'string' ? token : '').digest('hex');
}

export function publicReactions(room, value) {
  const entries = [];
  for (const [emoji, tokens] of Object.entries(value || {})) {
    if (reactions.has(emoji) && Array.isArray(tokens)) {
      entries.push([emoji, tokens.filter(isToken).map(token => publicId(room, token))]);
    }
  }
  return Object.fromEntries(entries);
}

export function publicMessage(room, message) {
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

export function publicPoll(poll, token) {
  if (!poll) return null;
  const votes = Object.values(poll.votes);
  const counts = poll.finished ? poll.options.map((_, i) => votes.filter(v => v === i).length) : null;
  return {
    id: poll.id, options: poll.options, finished: poll.finished, voteCount: votes.length, counts,
    myChoice: poll.votes[token] ?? null
  };
}

export function playbackState(room, seek = false) {
  return {
    room: room.id, mediaId: room.mediaId, time: currentTime(room), playing: room.playing,
    serverTime: Date.now(), version: room.syncVersion, seek
  };
}

export function sharedState(room, withMessages = false) {
  const state = {
    ...playbackState(room), users: userList(room), hostName: room.hostName,
    media: room.media, title: room.title, roulette: room.roulette, chatId: room.chatId
  };
  if (withMessages) state.messages = room.messages.map(message => publicMessage(room, message));
  return state;
}

export function broadcast(room, withMessages = false) {
  const state = sharedState(room, withMessages);
  for (const user of room.users.values()) {
    user.socket.emit('room-state', {...state, poll: publicPoll(room.poll, user.token)});
  }
}

export function inbox(room, token) {
  return room.letters.filter(letter => letter.to === token).map(letter => ({
    id: letter.id, name: letter.name, read: !!letter.read, text: letter.read ? letter.text : null, at: letter.at
  }));
}

export function sendInbox(room, token) {
  const payload = {room: room.id, items: inbox(room, token)};
  for (const user of room.users.values()) {
    if (user.token === token) user.socket.emit('wish-inbox', payload);
  }
}

export function roomHistory(room) {
  return room.history.slice(-100).reverse().map(({room, ...item})=>item);
}
