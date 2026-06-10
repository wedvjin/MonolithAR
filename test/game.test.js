import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/game.js';
import { GAME, PHASE, EV, monolithPosition } from '../shared/constants.js';

const DT = 1 / GAME.TICK_RATE;

function makeRoom() {
  return new Room('TEST', () => {});
}

function runSeconds(room, seconds) {
  const ticks = Math.ceil(seconds / DT);
  for (let i = 0; i < ticks; i++) room.tick(DT);
}

function drainEvents(room) {
  return room.snapshot().events ?? [];
}

test('players join, get distinct slots, and the countdown starts at 2 players', () => {
  const room = makeRoom();
  const a = room.addPlayer('a', 'Alice');
  assert.equal(room.phase, PHASE.LOBBY);
  const b = room.addPlayer('b', 'Bob');
  assert.notEqual(a.slot, b.slot);
  assert.equal(room.phase, PHASE.COUNTDOWN);
  runSeconds(room, GAME.COUNTDOWN_SECONDS + 0.1);
  assert.equal(room.phase, PHASE.LIVE);
});

test('room is capped at MAX_PLAYERS', () => {
  const room = makeRoom();
  for (let i = 0; i < GAME.MAX_PLAYERS; i++) {
    assert.ok(room.addPlayer(`p${i}`, `P${i}`));
  }
  assert.equal(room.addPlayer('extra', 'Extra'), null);
});

test('wisps spawn and are collected by a nearby player for energy', () => {
  const room = makeRoom();
  const a = room.addPlayer('a', 'Alice');
  a.energy = 10;
  runSeconds(room, GAME.WISP_SPAWN_INTERVAL * 2 + 0.2);
  assert.ok(room.wisps.length >= 1, 'a wisp should have spawned');
  drainEvents(room);

  // Teleport the player onto the wisp.
  const w = room.wisps[0];
  room.handlePose(a, [...w.pos], [0, 0, 0, 1]);
  room.tick(DT);
  assert.equal(a.energy, 10 + GAME.WISP_ENERGY);
  const evs = drainEvents(room);
  assert.ok(evs.some((e) => e.kind === EV.WISP_TAKEN && e.who === 'a'));
});

test('shooting costs energy, damages a monolith, and destroys it', () => {
  const room = makeRoom();
  const a = room.addPlayer('a', 'Alice');
  const b = room.addPlayer('b', 'Bob');
  runSeconds(room, GAME.COUNTDOWN_SECONDS + 0.1);
  assert.equal(room.phase, PHASE.LIVE);
  drainEvents(room);

  const target = monolithPosition(b.slot);
  // Stand 1m in front of Bob's monolith, aim at its midriff.
  const dir = [target[0], 0.8, target[2]];
  const origin = [target[0] * 0.5, 0.8, target[2] * 0.5];
  room.handlePose(a, origin, [0, 0, 0, 1]);

  const shotsToKill = Math.ceil(GAME.MONOLITH_HP / GAME.SHOT_DAMAGE);
  a.energy = GAME.ENERGY_MAX;
  let fired = 0;
  for (let i = 0; i < 200 && b.monolith.alive; i++) {
    a.energy = Math.max(a.energy, GAME.SHOT_COST); // refill so the test only measures damage
    a.cooldown = 0;
    const before = room.projectiles.length;
    const d = [target[0] - origin[0], 0.8 - origin[1], target[2] - origin[2]];
    room.handleShoot(a, origin, d);
    if (room.projectiles.length > before) fired++;
    runSeconds(room, 0.6); // let the bolt fly
  }
  assert.equal(b.monolith.alive, false);
  assert.equal(fired, shotsToKill);
  assert.equal(room.phase, PHASE.ENDED);
  assert.deepEqual(room.winnerIds, ['a']);
});

test('shield blocks monolith damage and drains energy over time', () => {
  const room = makeRoom();
  const a = room.addPlayer('a', 'Alice');
  const b = room.addPlayer('b', 'Bob');
  runSeconds(room, GAME.COUNTDOWN_SECONDS + 0.1);
  drainEvents(room);

  room.handleShield(b, true);
  assert.equal(b.shield, true);

  const target = monolithPosition(b.slot);
  const origin = [target[0] * 0.5, 0.8, target[2] * 0.5];
  room.handlePose(a, origin, [0, 0, 0, 1]);
  a.energy = GAME.ENERGY_MAX;
  room.handleShoot(a, origin, [target[0] - origin[0], 0, target[2] - origin[2]]);
  runSeconds(room, 1.0);

  assert.equal(b.monolith.hp, GAME.MONOLITH_HP, 'shielded monolith takes no damage');
  const evs = drainEvents(room);
  assert.ok(evs.some((e) => e.kind === EV.MONOLITH_HIT && e.blocked));
  assert.ok(b.energy < GAME.ENERGY_START, 'shield drains energy');

  b.energy = GAME.SHIELD_MIN_ENERGY + 0.5;
  runSeconds(room, 1.0);
  assert.equal(b.shield, false, 'shield auto-drops when energy runs out');
});

test('hitting a rival player steals energy', () => {
  const room = makeRoom();
  const a = room.addPlayer('a', 'Alice');
  const b = room.addPlayer('b', 'Bob');
  runSeconds(room, GAME.COUNTDOWN_SECONDS + 0.1);
  drainEvents(room);

  room.handlePose(a, [0, 1.6, 1], [0, 0, 0, 1]);
  room.handlePose(b, [0, 1.6, -1], [0, 0, 0, 1]);
  const aEnergy = a.energy;
  const bEnergy = b.energy;
  room.handleShoot(a, [0, 1.6, 1], [0, 0, -1]);
  runSeconds(room, 1.0);

  assert.equal(b.energy, bEnergy - GAME.PLAYER_HIT_DRAIN);
  assert.equal(a.energy, aEnergy - GAME.SHOT_COST + GAME.PLAYER_HIT_GAIN);
});

test('solo practice totem can be destroyed and respawns', () => {
  const room = makeRoom();
  const a = room.addPlayer('a', 'Alice');
  assert.equal(room.phase, PHASE.LOBBY);
  room.handlePose(a, [0, 1.0, 1.2], [0, 0, 0, 1]);

  for (let i = 0; i < 30 && room.totem.respawnIn <= 0; i++) {
    a.energy = GAME.ENERGY_MAX;
    a.cooldown = 0;
    room.handleShoot(a, [0, 1.0, 1.2], [0, -0.1, -1]);
    runSeconds(room, 0.5);
  }
  assert.ok(room.totem.respawnIn > 0, 'totem destroyed');
  const evs = drainEvents(room);
  assert.ok(evs.some((e) => e.kind === EV.TOTEM_DOWN && e.by === 'a'));

  runSeconds(room, GAME.TOTEM_RESPAWN + 0.2);
  assert.equal(room.totem.hp, GAME.TOTEM_HP, 'totem respawned at full HP');
});

test('match times out and the healthiest monolith wins', () => {
  const room = makeRoom();
  const a = room.addPlayer('a', 'Alice');
  const b = room.addPlayer('b', 'Bob');
  runSeconds(room, GAME.COUNTDOWN_SECONDS + 0.1);
  b.monolith.hp = 40;
  room.phaseTime = 0.2;
  runSeconds(room, 0.5);
  assert.equal(room.phase, PHASE.ENDED);
  assert.deepEqual(room.winnerIds, ['a']);
  assert.equal(a.score, 1);

  // Room cycles back to a fresh match.
  runSeconds(room, GAME.ENDED_SECONDS + GAME.COUNTDOWN_SECONDS + 0.3);
  assert.equal(room.phase, PHASE.LIVE);
  assert.equal(b.monolith.hp, GAME.MONOLITH_HP);
});

test('a leaving player forfeits: remaining monolith wins', () => {
  const room = makeRoom();
  room.addPlayer('a', 'Alice');
  room.addPlayer('b', 'Bob');
  runSeconds(room, GAME.COUNTDOWN_SECONDS + 0.1);
  assert.equal(room.phase, PHASE.LIVE);
  room.removePlayer('b');
  assert.equal(room.phase, PHASE.ENDED);
  assert.deepEqual(room.winnerIds, ['a']);
});

test('malformed input is rejected without crashing', () => {
  const room = makeRoom();
  const a = room.addPlayer('a', 'Alice');
  room.handlePose(a, [NaN, 0, 0], [0, 0, 0, 1]);
  room.handlePose(a, 'junk', null);
  room.handlePose(a, [999, 0, 0], [0, 0, 0, 1]); // out of bounds
  assert.equal(a.poseSeen, false);
  room.handleShoot(a, [0, 0], [1, 2, 3]);
  room.handleShoot(a, [0, 1, 0], [0, 0, 0]); // zero direction
  assert.equal(room.projectiles.length, 0);
  assert.equal(a.energy, GAME.ENERGY_START);
});

test('snapshot serializes cleanly to JSON', () => {
  const room = makeRoom();
  room.addPlayer('a', 'Alice');
  room.addPlayer('b', 'Bob');
  runSeconds(room, 1);
  const snap = room.snapshot();
  const parsed = JSON.parse(JSON.stringify(snap));
  assert.equal(parsed.players.length, 2);
  assert.ok([PHASE.LOBBY, PHASE.COUNTDOWN, PHASE.LIVE].includes(parsed.phase));
});
