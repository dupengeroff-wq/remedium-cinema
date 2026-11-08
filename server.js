
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const server = createServer(app);
const io = new Server(server);
const here = path.dirname(fileURLToPath(import.meta.url));
const rooms = new Map();

app.get('/', (_req, res) =>
  res.sendFile(path.join(here, 'index.html'))
);
app.get('/index.html', (_req, res) =>
  res.sendFile(path.join(here, 'index.html'))
);
app.get('/health', (_req, res) =>
  res.json({ ok: true })
);

function parseMedia(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;

  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }

  if (!['https:', 'http:'].includes(u.protocol)) return null;

  const host = u.hostname.toLowerCase();
  let id = null;

  if (host === 'youtu.be') {
    id = u.pathname.split('/')[1];
  }

  if ([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com'
  ].includes(host)) {
    id = u.searchParams.get('v') ||
      u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1];
  }

  if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return {
      type: 'youtube',
      id,
      url: `https://www.youtube.com/watch?v=${id}`
    };
  }

  const vkHosts = [
    'vk.com',
    'www.vk.com',
    'm.vk.com',
    'vkvideo.ru',
    'www.vkvideo.ru',
    'm.vkvideo.ru',
    'vk.ru',
    'www.vk.ru',
    'm.vk.ru'
  ];

  if (vkHosts.includes(host)) {
    const match = u.pathname.match(/\/video(-?\d+)_(\d+)/);

    let oid = match?.[1];
    let vid = match?.[2];

    if (!oid || !vid) {
      oid = u.searchParams.get('oid');
      vid = u.searchParams.get('id');
    }

    if (
      oid &&
      vid &&
      /^-?\d+$/.test(oid) &&
      /^\d+$/.test(vid)
    ) {
      const embed = new URL('https://vk.com/video_ext.php');

      embed.searchParams.set('oid', oid);
      embed.searchParams.set('id', vid);
      embed.searchParams.set('js_api', '1');

      const hash = u.searchParams.get('hash');
      if (hash) embed.searchParams.set('hash', hash);

      return {
        type: 'vk',
        url: `https://vkvideo.ru/video${oid}_${vid}`,
        embed: embed.href
      };
    }
  }

  if (/\.(mp4|webm)$/i.test(u.pathname)) {
    return {
      type: 'video',
      url: u.href
    };
  }

  return null;
}

function snapshot(r) {
  return {
    media: r.media,
    playing: r.playing,
    time: r.time,
    updated: r.updated,
    users: [...r.users.values()],
    messages: r.messages
  };
}

function broadcast(id) {
  const r = rooms.get(id);
  if (r) {
    io.to(id).emit('room-state', snapshot(r));
  }
}

function leave(socket) {
  const id = socket.data.room;
  if (!id) return;

  const r = rooms.get(id);
  socket.leave(id);
  socket.data.room = null;

  if (!r) return;

  r.users.delete(socket.id);

  if (r.users.size === 0) {
    rooms.delete(id);
  } else {
    broadcast(id);
  }
}

io.on('connection', socket => {
  socket.on('join', (data, ack = () => {}) => {
    const id = String(data?.room || '').trim();
    const name = String(data?.name || 'Гость')
      .trim()
      .slice(0, 24) || 'Гость';

    if (!/^[\w-]{1,80}$/.test(id)) {
      return ack({ error: 'Недопустимый код комнаты' });
    }

    leave(socket);

    let r = rooms.get(id);

    if (!r) {
      r = {
        media: null,
        playing: false,
        time: 0,
        updated: Date.now(),
        users: new Map(),
        messages: []
      };
      rooms.set(id, r);
    }

    socket.join(id);
    socket.data.room = id;
    socket.data.name = name;

    r.users.set(socket.id, {
      id: socket.id,
      name
    });

    ack({ ok: true, id: socket.id });
    broadcast(id);
  });

  socket.on('media', (data, ack = () => {}) => {
    const r = rooms.get(socket.data.room);

    if (!r) {
      return ack({ error: 'Сначала войдите в комнату' });
    }

    const media = parseMedia(data?.url);

    if (!media) {
      return ack({
        error: 'Неподдерживаемая ссылка. Нужны YouTube, VK Видео или прямой MP4/WebM.'
      });
    }

    r.media = media;
    r.playing = false;
    r.time = 0;
    r.updated = Date.now();

    ack({ ok: true });
    broadcast(socket.data.room);
  });

  socket.on('sync', data => {
    const r = rooms.get(socket.data.room);
    if (!r || !r.media) return;

    const time = Number(data?.time);

    if (
      !Number.isFinite(time) ||
      time < 0 ||
      time > 10000000 ||
      typeof data?.playing !== 'boolean'
    ) return;

    r.time = time;
    r.playing = data.playing;
    r.updated = Date.now();

    socket.to(socket.data.room).emit('sync', {
      time,
      playing: r.playing
    });
  });

  socket.on('request-sync', () => {
    const r = rooms.get(socket.data.room);
    if (!r || !r.media) return;

    const time = r.time +
      (r.playing ? (Date.now() - r.updated) / 1000 : 0);

    socket.emit('sync', {
      time,
      playing: r.playing
    });
  });

  socket.on('chat', value => {
    const r = rooms.get(socket.data.room);
    if (!r) return;

    const message = String(value ?? '')
      .trim()
      .slice(0, 1000);

    if (!message) return;

    const msg = {
      sender: socket.id,
      name: socket.data.name || 'Гость',
      text: message,
      at: Date.now()
    };

    r.messages.push(msg);

    if (r.messages.length > 100) {
      r.messages.shift();
    }

    io.to(socket.data.room).emit('chat', msg);
  });

  socket.on('disconnect', () => leave(socket));
});

server.listen(
  process.env.PORT || 3000,
  '0.0.0.0',
  () => console.log('REMEDIUM CINEMA server started')
);
