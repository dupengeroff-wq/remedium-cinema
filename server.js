
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000
});

const rooms = new Map();
const dataFile = path.join(dir, 'cinema-data.json');

function newToken() {
  return randomBytes(24).toString('hex');
}

function parseMedia(raw) {
  try {
    const u = new URL(String(raw || '').trim());

    if (!['http:', 'https:'].includes(u.protocol)) {
      return null;
    }

    const host = u.hostname.toLowerCase();
    let id = null;

    if (host === 'youtu.be') {
      id = u.pathname.split('/')[1];
    }

    if ([
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com'
    ].includes(host)) {
      id = u.searchParams.get('v') ||
        u.pathname.match(
          /^\/(?:embed|shorts|live)\/([^/]+)/
        )?.[1];
    }

    if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return {
        type: 'youtube',
        id,
        url: 'https://www.youtube.com/watch?v=' + id
      };
    }

    if ([
      'vk.com',
      'www.vk.com',
      'm.vk.com',
      'vkvideo.ru',
      'www.vkvideo.ru',
      'm.vkvideo.ru'
    ].includes(host)) {
      const match = u.pathname.match(
        /video(-?\d+)_(\d+)/
      );

      const oid = match?.[1] ||
        u.searchParams.get('oid');

      const vid = match?.[2] ||
        u.searchParams.get('id');

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

        const hash = u.searchParams.get('hash');

        if (hash) {
          embed.searchParams.set('hash', hash);
        }

        return {
          type: 'vk',
          url: u.origin + u.pathname,
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
  } catch {
    return null;
  }
}

function currentTime(room) {
  if (!room.playing) {
    return room.time;
  }

  return room.time +
    Math.max(0, (Date.now() - room.updated) / 1000);
}

function saveRooms() {
  const data = {};

  for (const [id, room] of rooms) {
    data[id] = {
      media: room.media,
      time: currentTime(room),
      playing: false,
      messages: room.messages.slice(-150),
      hostToken: room.hostToken,
      hostName: room.hostName,
      credentials: [...room.credentials]
    };
  }

  try {
    fs.writeFileSync(
      dataFile + '.tmp',
      JSON.stringify(data)
    );

    fs.renameSync(
      dataFile + '.tmp',
      dataFile
    );
  } catch (error) {
    console.error(
      'Ошибка сохранения:',
      error.message
    );
  }
}

function loadRooms() {
  try {
    if (!fs.existsSync(dataFile)) {
      return;
    }

    const data = JSON.parse(
      fs.readFileSync(dataFile, 'utf8')
    );

    for (const [id, saved] of Object.entries(data)) {
      if (!/^[a-zA-Z0-9_-]{4,80}$/.test(id)) {
        continue;
      }

      rooms.set(id, {
        media: saved.media || null,
        time: Number(saved.time) || 0,
        playing: false,
        updated: Date.now(),
        messages: Array.isArray(saved.messages)
          ? saved.messages.slice(-150)
          : [],
        hostToken: saved.hostToken || newToken(),
        hostName: saved.hostName || 'Создатель',
        credentials: new Map(
          Array.isArray(saved.credentials)
            ? saved.credentials
            : []
        ),
        users: new Map()
      });
    }

    console.log(
      'Загружено комнат:',
      rooms.size
    );
  } catch (error) {
    console.error(
      'Ошибка загрузки:',
      error.message
    );
  }
}

loadRooms();

function isHost(socket, room) {
  return Boolean(
    room &&
    socket.data.token &&
    socket.data.token === room.hostToken
  );
}

function roomState(room) {
  return {
    media: room.media,
    playing: room.playing,
    time: currentTime(room),
    hostName: room.hostName,
    messages: room.messages,
    users: [...room.users.values()].map(user => ({
      id: user.id,
      name: user.name,
      isHost: user.token === room.hostToken
    }))
  };
}

function broadcastRoom(id) {
  const room = rooms.get(id);

  if (!room) {
    return;
  }

  io.to(id).emit(
    'room-state',
    roomState(room)
  );
}

function leaveRoom(socket) {
  const id = socket.data.room;

  if (!id) {
    return;
  }

  const room = rooms.get(id);

  socket.leave(id);
  socket.data.room = null;

  if (!room) {
    return;
  }

  room.users.delete(socket.id);

  if (room.users.size === 0) {
    room.time = currentTime(room);
    room.playing = false;
    room.updated = Date.now();
    saveRooms();
  }

  broadcastRoom(id);
}

function getRoom(socket) {
  return rooms.get(socket.data.room);
}

io.on('connection', socket => {

  socket.on('join', (data = {}, ack) => {
    const reply = typeof ack === 'function'
      ? ack
      : () => {};

    const id = String(data.room || '').trim();

    const name = String(data.name || 'Гость')
      .trim()
      .slice(0, 24) || 'Гость';

    if (!/^[a-zA-Z0-9_-]{4,80}$/.test(id)) {
      return reply({
        error: 'Неверный код комнаты'
      });
    }

    const oldRoomId = socket.data.room;
    const oldRoom = rooms.get(oldRoomId);

    // Не выходим из комнаты при простой смене имени.
    if (oldRoomId && oldRoomId !== id) {
      leaveRoom(socket);
    }

    let room = rooms.get(id);
    const created = !room;

    if (!room) {
      room = {
        media: null,
        time: 0,
        playing: false,
        updated: Date.now(),
        messages: [],
        hostToken: '',
        hostName: name,
        credentials: new Map(),
        users: new Map()
      };

      rooms.set(id, room);
    }

    const requestedToken = String(
      data.token || ''
    );

    let userToken;

    // Сохраняем личность пользователя при смене имени.
    if (
      requestedToken &&
      room.credentials.has(requestedToken)
    ) {
      userToken = requestedToken;
    } else if (
      oldRoom === room &&
      socket.data.token &&
      room.credentials.has(socket.data.token)
    ) {
      userToken = socket.data.token;
    } else {
      userToken = newToken();
    }

    room.credentials.set(
      userToken,
      name
    );

    if (created) {
      room.hostToken = userToken;
      room.hostName = name;
    }

    // Если имя меняет создатель, обновляем его имя.
    if (userToken === room.hostToken) {
      room.hostName = name;
    }

    socket.join(id);

    socket.data.room = id;
    socket.data.name = name;
    socket.data.token = userToken;

    room.users.set(socket.id, {
      id: socket.id,
      name,
      token: userToken
    });

    reply({
      ok: true,
      id: socket.id,
      token: userToken,
      isHost: isHost(socket, room)
    });

    broadcastRoom(id);
    saveRooms();
  });

  socket.on('media', (data = {}, ack) => {
    const reply = typeof ack === 'function'
      ? ack
      : () => {};

    const room = getRoom(socket);

    if (!room) {
      return reply({
        error: 'Сначала войдите в комнату'
      });
    }

    if (!isHost(socket, room)) {
      return reply({
        error: 'Только создатель выбирает фильм'
      });
    }

    const media = parseMedia(data.url);

    if (!media) {
      return reply({
        error: 'Поддерживаются YouTube, VK Видео и MP4/WebM'
      });
    }

    room.media = media;
    room.time = 0;
    room.playing = false;
    room.updated = Date.now();

    reply({ ok: true });

    broadcastRoom(socket.data.room);
    saveRooms();
  });

  socket.on('sync', data => {
    const room = getRoom(socket);

    // Только создатель управляет общим просмотром.
    if (!room?.media || !isHost(socket, room)) {
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

    socket.to(socket.data.room).emit(
      'sync',
      {
        time: room.time,
        playing: room.playing
      }
    );

    saveRooms();
  });

  socket.on('request-sync', () => {
    const room = getRoom(socket);

    if (!room?.media) {
      return;
    }

    socket.emit('sync', {
      time: currentTime(room),
      playing: room.playing
    });
  });

  socket.on('chat', value => {
    const room = getRoom(socket);

    if (!room) {
      return;
    }

    const text = String(value ?? '')
      .trim()
      .slice(0, 1000);

    if (!text) {
      return;
    }

    // Сервер определяет администратора по токену.
    // Гость не может сам назначить себе корону.
    const admin = isHost(socket, room);

    const message = {
      id: newToken().slice(0, 12),
      sender: socket.id,
      name: socket.data.name || 'Гость',
      text,
      at: Date.now(),
      isHost: admin
    };

    room.messages.push(message);

    if (room.messages.length > 150) {
      room.messages.shift();
    }

    io.to(socket.data.room).emit(
      'chat',
      message
    );

    saveRooms();
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
  });

});

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    rooms: rooms.size
  });
});

app.get('/', (_, res) => {
  res.sendFile(
    path.join(dir, 'index.html')
  );
});

app.get('/index.html', (_, res) => {
  res.sendFile(
    path.join(dir, 'index.html')
  );
});

setInterval(saveRooms, 30000);

process.on('SIGTERM', () => {
  saveRooms();
  process.exit(0);
});

server.listen(
  process.env.PORT || 3000,
  '0.0.0.0',
  () => {
    console.log(
      'REMEDIUM CINEMA 2.0 запущен'
    );
  }
);
