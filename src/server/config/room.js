import crypto from 'node:crypto';

export const maxRooms = 500;
export const maxConnections = 200;
export const spinDuration = 5000;
export const winnerIndex = 24;
export const badges = new Set(['🎀', '🐈', '🦊', '💖', '🐒']);
export const reactions = new Set(['🔥', '🥹', '😍', '🤤', '❤️']);
export const uid = () => crypto.randomBytes(16).toString('hex');
export const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isRoom = value => typeof value === 'string' && /^[\w-]{3,80}$/.test(value);
export const isToken = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const channel = id => 'cinema:' + id;
export const array = value => Array.isArray(value) ? value.filter(isRecord) : [];
