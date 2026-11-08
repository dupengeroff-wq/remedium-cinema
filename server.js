
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const app = express();
const server = createServer(app);
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000
});

const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(here, 'cinema-data.json');
const rooms = new Map();

app.get('/', (req, res) => {
  res.sendFile(path.join(here, 'index.html'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(here, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseMedia(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    return null;
  }

  let url;

  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (!['https:', 'http:'].includes(url.protocol)) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  let youtubeId = null;

  if (host === 'youtu.be') {
    youtubeId = url.pathname.split('/')[1];
  }

  if ([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com'
  ].includes(host)) {
    youtubeId =
      url.searchParams.get('v') ||
      url.pathname.match(
        /^\/(?:shorts|embed|live)\/([^/]+)/
      )?.[1];
  }

  if (
    youtubeId &&
    /^[a-zA-Z0-9_-]{11}$/.test(youtubeId)
  ) {
    return {
      type: 'youtube',
      id: youtubeId,
      url: 'https://www.youtube.com/watch?v=' + youtubeId
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
    const match = url.pathname.match(
      /\/video(-?\d+)_(\d+)/
    );

    let oid = match?.[1];
    let vid = match?.[2];

    if (!oid || !vid) {
      oid = url.searchParams.get('oid');
      vid = url.searchParams.get('id');
    }

    if (
      oid &&
      vid &&
      /^-?\d+$/.test(oid) &&
      /^\d+$/.test(vid)
    ) {
      const embed = new URL(
        'https://vk.com/video_ext.php'
      );

      embed.searchParams.set('oid', oid);
      embed.searchParams.set('id', vid);
      embed.searchParams.set('js_api', '1');

      const hash = url.searchParams.get('hash');

      if (hash) {
        embed.searchParams.set('hash', hash);
      }

      return {
        type: 'vk',
        url: 'https://vkvideo.ru/video' + oid + '_' + vid,
        embed: embed.href
      };
    }
  }

  if (/\.(mp4|webm)$/i.test(url.pathname)) {
    return {
      type: 'video',
      url: url.href
    };
  }

  return null;
}

function currentTime(room) {
  if (!room.playing) {
    return room.time;
  }

  return room.time +
    Math.max(0, Date.now() - room.updated) / 1000;
}

function saveRooms() {
  const data = {};

  for (const [id, room] of rooms) {
    data[id] = {
      media: room.media,
      playing: room.playing,
      time: currentTime(room),
      updated: Date.now(),
      messages: room.messages,
      hostToken: room.hostToken,
      hostName: room.hostName,
      tokens: [...room.tokens.entries()]
    };
  }

  try {
    const temporary = dataFile + '.tmp';

    fs.writeFileSync(
      temporary,
      JSON.stringify(data),
      'utf8'
    );

    fs.renameSync(temporary, dataFile);
  } catch (error) {
    console.error('Save error:', error);
  }
}

function loadRooms() {
  if (!fs.existsSync(dataFile)) {
    return;
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(dataFile, 'utf8')
    );

    for (const [id, saved] of Object.entries(data)) {
      if (!/^[\w-]{1,80}$/.test(id)) {
        continue;
      }

      const tokens = new Map(
        Array.isArray(saved.tokens) ? saved.tokens : []
      );

      rooms.set(id, {
        media: saved.media || null,
        playing: false,
        time: Math.max(0, Number(saved.time) || 0),
        updated: Date.now(),
        messages: Array.isArray(saved.messages)
          ? saved.messages.slice(-100)
          : [],
        users: new Map(),
        tokens,
        hostToken: saved.hostToken || '',
        hostName: saved.hostName || 'Хост'
      });
    }

    console.log('Restored rooms:', rooms.size);
  } catch (error) {
    console.error('Load error:', error);
  }
}

loadRooms();

function snapshot(room) {
  const users = [...room.users.values()].map(user => ({
    id: user.id,
    name: user.name,
    isHost: user.token === room.hostToken
  }));

  return {
    media: room.media,
    playing: room.playing,
    time: currentTime(room),
    updated: Date.now(),
    users,
    hostName: room.hostName,
    messages: room.messages
  };
}

function broadcast(id) {
  const room = rooms.get(id);

  if (room) {
    io.to(id).emit('room-state', snapshot(room));
  }
}

function leave(socket) {
  const id = socket.data.room;

  if (!id) {
    return;
  }

  socket.leave(id);
  socket.data.room = null;

  const room = rooms.get(id);

  if (!room) {
    return;
  }

  room.users.delete(socket.id);

  // Комната сохраняется даже без участников.
  broadcast(id);
}

function getRoom(socket) {
  return rooms.get(socket.data.room);
}

function isHost(socket, room) {
  return Boolean(
    room &&
    socket.data.token &&
    socket.data.token === room.hostToken
  );
}

io.on('connection', socket => {

  socket.on('join', (data, ack = () => {}) => {
    const id = String(data?.room || '').trim();

    const name = String(data?.name || 'Гость')
      .trim()
      .slice(0, 24) || 'Гость';

    if (!/^[\w-]{1,80}$/.test(id)) {
      return ack({
        error: 'Недопустимый код комнаты'
      });
    }

    leave(socket);

    let room = rooms.get(id);
    let created = false;

    if (!room) {
      created = true;

      room = {
        media: null,
        playing: false,
        time: 0,
        updated: Date.now(),
        messages: [],
        users: new Map(),
        tokens: new Map(),
        hostToken: '',
        hostName: name
      };

      rooms.set(id, room);
    }

    const requestedToken = String(
      data?.token || ''
    );

    let token;

    if (
      requestedToken &&
      room.tokens.has(requestedToken)
    ) {
      token = requestedToken;
    } else {
      token = newToken();
      room.tokens.set(token, name);
    }

    if (created) {
      room.hostToken = token;
      room.hostName = name;
    }

    if (token === room.hostToken) {
      room.hostName = name;
    }

    socket.join(id);

    socket.data.room = id;
    socket.data.name = name;
    socket.data.token = token;

    room.users.set(socket.id, {
      id: socket.id,
      name,
      token
    });

    ack({
      ok: true,
      id: socket.id,
      token,
      isHost: isHost(socket, room)
    });

    broadcast(id);
    saveRooms();
  });

  socket.on('media', (data, ack = () => {}) => {
    const room = getRoom(socket);

    if (!room) {
      return ack({
        error: 'Сначала войдите в комнату'
      });
    }

    if (!isHost(socket, room)) {
      return ack({
        error: 'Только хост может менять фильм'
      });
    }

    const media = parseMedia(data?.url);

    if (!media) {
      return ack({
        error: 'Нужна ссылка YouTube, VK Видео или MP4/WebM'
      });
    }

    room.media = media;
    room.playing = false;
    room.time = 0;
    room.updated = Date.now();

    ack({ ok: true });

    broadcast(socket.data.room);
    saveRooms();
  });

  socket.on('sync', data => {
    const room = getRoom(socket);

    if (!room || !room.media) {
      return;
    }

    if (!isHost(socket, room)) {
      return;
    }

    const time = Number(data?.time);

    if (
      !Number.isFinite(time) ||
      time < 0 ||
      time > 10000000 ||
      typeof data?.playing !== 'boolean'
    ) {
      return;
    }

    room.time = time;
    room.playing = data.playing;
    room.updated = Date.now();

    socket.to(socket.data.room).emit('sync', {
      time,
      playing: room.playing
    });

    saveRooms();
  });

  socket.on('request-sync', () => {
    const room = getRoom(socket);

    if (!room || !room.media) {
      return;
    }

    socket.emit('sync', {
      time: currentTime(room),
      playing: room.playing
    });
  });

  socket.on('transfer-host', (data, ack = () => {}) => {
    const room = getRoom(socket);

    if (!room) {
      return ack({
        error: 'Комната не найдена'
      });
    }

    if (!isHost(socket, room)) {
      return ack({
        error: 'Передать роль может только хост'
      });
    }

    const target = room.users.get(
      String(data?.socketId || '')
    );

    if (!target) {
      return ack({
        error: 'Участник не найден'
      });
    }

    if (target.id === socket.id) {
      return ack({
        error: 'Ты уже хост'
      });
    }

    // Передаём права конкретному участнику.
    room.hostToken = target.token;
    room.hostName = target.name;

    ack({ ok: true });

    io.to(socket.data.room).emit('host-changed', {
      name: target.name
    });

    broadcast(socket.data.room);
    saveRooms();
  });

  socket.on('chat', value => {
    const room = getRoom(socket);

    if (!room) {
      return;
    }

    const message = String(value ?? '')
      .trim()
      .slice(0, 1000);

    if (!message) {
      return;
    }

    const msg = {
      sender: socket.id,
      name: socket.data.name || 'Гость',
      text: message,
      at: Date.now()
    };

    room.messages.push(msg);

    if (room.messages.length > 100) {
      room.messages.shift();
    }

    io.to(socket.data.room).emit('chat', msg);

    saveRooms();
  });

  socket.on('disconnect', () => {
    leave(socket);
  });

});

// Периодически сохраняем состояние комнат.
setInterval(saveRooms, 30000);

function shutdown() {
  for (const room of rooms.values()) {
    room.time = currentTime(room);
    room.playing = false;
    room.updated = Date.now();
  }

  saveRooms();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    'REMEDIUM CINEMA running on port ' + PORT
  );
});
