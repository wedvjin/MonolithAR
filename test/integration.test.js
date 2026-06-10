import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MSG, PHASE, GAME } from '../shared/constants.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let proc;
let port;

before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (chunk) => {
      const m = String(chunk).match(/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.on('exit', () => reject(new Error('server exited early')));
  });
});

after(() => proc?.kill());

class TestClient {
  constructor() {
    this.messages = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${port}/ws`);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        this.messages.push(msg);
        this.waiters = this.waiters.filter((w) => {
          if (!w.pred(msg)) return true;
          w.resolve(msg);
          return false;
        });
      });
    });
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); }

  waitFor(pred, label, ms = 10000) {
    const existing = this.messages.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  close() { this.ws?.close(); }
}

test('two players join a room, see each other, fight, and a winner emerges', async () => {
  const alice = new TestClient();
  const bob = new TestClient();
  await alice.connect();
  await bob.connect();

  // Alice creates a room.
  alice.send({ t: MSG.JOIN, name: 'Alice' });
  const aJoin = await alice.waitFor((m) => m.t === MSG.JOINED, 'alice joined');
  assert.equal(aJoin.roster.length, 1);
  assert.match(aJoin.room, /^[A-Z2-9]{4}$/);

  // Bob joins the same room by code.
  bob.send({ t: MSG.JOIN, name: 'Bob', room: aJoin.room });
  const bJoin = await bob.waitFor((m) => m.t === MSG.JOINED, 'bob joined');
  assert.equal(bJoin.room, aJoin.room);
  assert.notEqual(bJoin.slot, aJoin.slot);

  // Alice is told about Bob.
  const pj = await alice.waitFor((m) => m.t === MSG.PLAYER_JOINED && m.player.name === 'Bob', 'bob announced');
  assert.equal(pj.roster.length, 2);

  // Countdown runs, match goes live.
  await alice.waitFor((m) => m.t === MSG.SNAPSHOT && m.phase === PHASE.LIVE, 'match live', 12000);

  // Both report poses; each sees the other's pose in snapshots.
  alice.send({ t: MSG.POSE, p: [0, 1.6, 1], q: [0, 0, 0, 1] });
  bob.send({ t: MSG.POSE, p: [0, 1.6, -1], q: [0, 0, 0, 1] });
  const snapWithPoses = await alice.waitFor(
    (m) => m.t === MSG.SNAPSHOT
      && m.players.some((p) => p.id === bJoin.id && Math.abs(p.p[2] - -1) < 0.01),
    'bob pose visible to alice'
  );
  assert.equal(snapWithPoses.players.length, 2);

  // Alice shoots Bob in the face — energy is stolen.
  alice.send({ t: MSG.SHOOT, o: [0, 1.6, 1], d: [0, 0, -1] });
  const hitSnap = await alice.waitFor(
    (m) => m.t === MSG.SNAPSHOT && m.events?.some((e) => e.kind === 'phit' && e.who === bJoin.id),
    'player hit event'
  );
  const bobState = hitSnap.players.find((p) => p.id === bJoin.id);
  assert.equal(bobState.e, GAME.ENERGY_START - GAME.PLAYER_HIT_DRAIN);

  // Bob disconnects mid-match: Alice wins by forfeit.
  bob.close();
  const endSnap = await alice.waitFor(
    (m) => m.t === MSG.SNAPSHOT && m.phase === PHASE.ENDED,
    'match ended'
  );
  assert.deepEqual(endSnap.winners, [aJoin.id]);

  alice.close();
});

test('rooms reject the 9th player', async () => {
  const clients = [];
  try {
    const first = new TestClient();
    clients.push(first);
    await first.connect();
    first.send({ t: MSG.JOIN, name: 'P0' });
    const join = await first.waitFor((m) => m.t === MSG.JOINED, 'p0 joined');

    for (let i = 1; i < GAME.MAX_PLAYERS; i++) {
      const c = new TestClient();
      clients.push(c);
      await c.connect();
      c.send({ t: MSG.JOIN, name: `P${i}`, room: join.room });
      await c.waitFor((m) => m.t === MSG.JOINED, `p${i} joined`);
    }

    const extra = new TestClient();
    clients.push(extra);
    await extra.connect();
    extra.send({ t: MSG.JOIN, name: 'Extra', room: join.room });
    const err = await extra.waitFor((m) => m.t === MSG.ERROR, 'room full error');
    assert.match(err.msg, /full/);
  } finally {
    for (const c of clients) c.close();
  }
});

test('healthz responds', async () => {
  const res = await fetch(`http://localhost:${port}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('static client and vendored three.js are served', async () => {
  const page = await fetch(`http://localhost:${port}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /MonolithAR/);

  const three = await fetch(`http://localhost:${port}/vendor/three/build/three.module.js`);
  assert.equal(three.status, 200);

  const shared = await fetch(`http://localhost:${port}/shared/constants.js`);
  assert.equal(shared.status, 200);
});
