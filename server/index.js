import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Room } from './game.js';
import { MSG, GAME, sanitizeName, normalizeRoomCode } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const app = express();
app.use(express.static(path.join(root, 'public')));
app.use('/shared', express.static(path.join(root, 'shared')));
// Serve three.js straight out of node_modules so the client needs no bundler.
app.use('/vendor/three', express.static(path.join(root, 'node_modules/three')));

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map(); // code -> Room

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = new Room(code, (c) => rooms.delete(c));
    rooms.set(code, room);
  }
  return room;
}

function randomRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const send = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN && client.room === room) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(6).toString('base64url');
  ws.room = null;
  ws.player = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (raw.length > 2048) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('message handling failed:', err);
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

function handleMessage(ws, msg) {
  switch (msg.t) {
    case MSG.JOIN: {
      if (ws.room) leaveRoom(ws);
      const code = normalizeRoomCode(msg.room) || randomRoomCode();
      const room = getOrCreateRoom(code);
      if (room.size >= GAME.MAX_PLAYERS) {
        send(ws, { t: MSG.ERROR, msg: `Room ${code} is full (${GAME.MAX_PLAYERS} players max).` });
        return;
      }
      const name = sanitizeName(msg.name);
      const player = room.addPlayer(ws.id, name);
      if (!player) {
        send(ws, { t: MSG.ERROR, msg: `Room ${code} is full.` });
        return;
      }
      ws.room = room;
      ws.player = player;
      send(ws, {
        t: MSG.JOINED,
        id: ws.id,
        room: code,
        slot: player.slot,
        color: player.colorIndex,
        roster: room.roster(),
        snap: room.snapshot(),
      });
      broadcast(room, {
        t: MSG.PLAYER_JOINED,
        player: { id: ws.id, name, slot: player.slot, color: player.colorIndex, score: 0 },
        roster: room.roster(),
      });
      console.log(`[${code}] ${name} joined (${room.size} player${room.size === 1 ? '' : 's'})`);
      break;
    }
    case MSG.POSE:
      if (ws.player && ws.room) ws.room.handlePose(ws.player, msg.p, msg.q);
      break;
    case MSG.SHOOT:
      if (ws.player && ws.room) ws.room.handleShoot(ws.player, msg.o, msg.d);
      break;
    case MSG.SHIELD:
      if (ws.player && ws.room) ws.room.handleShield(ws.player, msg.on);
      break;
    case MSG.PING:
      send(ws, { t: MSG.PONG, n: msg.n });
      break;
    default:
      break;
  }
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  const name = ws.player?.name ?? '?';
  room.removePlayer(ws.id);
  ws.room = null;
  ws.player = null;
  if (rooms.has(room.code)) {
    broadcast(room, { t: MSG.PLAYER_LEFT, id: ws.id, roster: room.roster() });
  }
  console.log(`[${room.code}] ${name} left (${room.size} remaining)`);
}

// ---- main loops -----------------------------------------------------------

const TICK_DT = 1 / GAME.TICK_RATE;
setInterval(() => {
  for (const room of rooms.values()) room.tick(TICK_DT);
}, 1000 / GAME.TICK_RATE);

setInterval(() => {
  for (const room of rooms.values()) {
    broadcast(room, { t: MSG.SNAPSHOT, ...room.snapshot() });
  }
}, 1000 / GAME.SNAPSHOT_RATE);

// Drop dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MonolithAR server listening on http://localhost:${server.address().port}`);
  console.log('Note: WebXR AR requires HTTPS (or localhost). Use a TLS proxy/tunnel for phones.');
});
