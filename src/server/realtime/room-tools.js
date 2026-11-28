import crypto from 'node:crypto';
import {clean,winnerIndex} from '../config/room.js';

export function defaultTitle(media) {
  if (media.type === 'youtube') return 'YouTube';
  if (media.type === 'vk') return 'VK Видео';
  try {
    return clean(decodeURIComponent(new URL(media.url).pathname.split('/').at(-1)), 120) || 'Видео';
  } catch {
    return 'Видео';
  }
}

export function makeCards(items) {
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
