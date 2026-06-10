import { GAME, EV, PHASE } from '/shared/constants.js';
import { Net } from './net.js';
import { World } from './world.js';
import { Hud } from './hud.js';
import { sfx } from './audio.js';
import { ArMode, arSupported } from './modes/ar.js';
import { FlatMode } from './modes/flat.js';

const $ = (id) => document.getElementById(id);

const world = new World($('gl'));
const hud = new Hud();
const net = new Net();

const app = {
  mode: null,          // ArMode | FlatMode
  modeName: null,      // 'ar' | 'flat'
  roster: [],
  mySlot: 0,
  playing: false,
  posing: false,       // true once we should stream poses
  poseAccum: 0,
  lastFrameTime: 0,
  lastPhase: null,
  me: { energy: GAME.ENERGY_START, hp: GAME.MONOLITH_HP },
};

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------

const homeEl = $('home');
const errEl = $('home-error');
const nameInput = $('name-input');
const roomInput = $('room-input');

nameInput.value = localStorage.getItem('monolithar.name') ?? '';

arSupported().then((ok) => {
  const note = $('ar-support-note');
  const btn = $('btn-ar');
  if (ok) {
    btn.disabled = false;
    note.textContent = 'phone / headset';
  } else {
    note.textContent = location.protocol === 'http:' && location.hostname !== 'localhost'
      ? 'needs HTTPS'
      : 'not supported here';
  }
});

function showHomeError(msg) {
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}

$('btn-ar').addEventListener('click', () => enterGame('ar'));
$('btn-flat').addEventListener('click', () => enterGame('flat'));
$('btn-leave').addEventListener('click', leaveGame);

async function enterGame(modeName) {
  errEl.classList.add('hidden');
  sfx.unlock();
  const name = nameInput.value.trim() || 'Wanderer';
  localStorage.setItem('monolithar.name', name);

  try {
    await net.connect();
  } catch (e) {
    showHomeError(e.message);
    return;
  }

  const joined = await new Promise((resolve, reject) => {
    net.on('joined', resolve);
    net.on('error', (m) => reject(new Error(m)));
    net.join(roomInput.value, name);
  }).catch((e) => {
    showHomeError(e.message);
    net.disconnect();
    return null;
  });
  if (!joined) return;

  app.roster = joined.roster;
  app.mySlot = joined.slot;
  app.modeName = modeName;
  world.myId = net.id;
  world.applyRoster(app.roster);
  world.applySnapshot(joined.snap);
  bindNetHandlers();

  hud.setRoom(joined.room);
  roomInput.value = joined.room;
  refreshScoreboard(joined.snap);

  homeEl.classList.add('hidden');
  hud.show();

  if (modeName === 'ar') {
    await startAr();
  } else {
    startFlat();
  }
}

function bindNetHandlers() {
  net.on('snapshot', onSnapshot);
  net.on('playerJoined', (msg) => {
    app.roster = msg.roster;
    world.applyRoster(app.roster);
    if (msg.player.id !== net.id) hud.feed(`${msg.player.name} entered the arena`);
  });
  net.on('playerLeft', (msg) => {
    const gone = app.roster.find((r) => r.id === msg.id);
    app.roster = msg.roster;
    world.applyRoster(app.roster);
    if (gone) hud.feed(`${gone.name} left`);
  });
  net.on('close', () => {
    if (app.playing) {
      leaveGame();
      showHomeError('Connection to the server was lost.');
    }
  });
}

// ---------------------------------------------------------------------------
// Mode startup / teardown
// ---------------------------------------------------------------------------

async function startAr() {
  const fireBtn = $('btn-fire');
  fireBtn.classList.add('hidden'); // in AR you tap the world itself
  hud.configureFor('ar-placing');
  hud.centerMessage('SCAN YOUR FLOOR\nTAP TO ANCHOR THE ARENA', 0);

  // Keep taps on HUD widgets from doubling as shoot gestures.
  for (const id of ['btn-shield', 'btn-leave', 'hud-bottom', 'scoreboard']) {
    $(id).addEventListener('beforexrselect', (e) => e.preventDefault());
  }

  const ar = new ArMode(world, $('hud'), {
    onPlaced: () => {
      sfx.place();
      hud.clearCenterMessage();
      hud.configureFor('ar');
      hud.centerMessage('ARENA ANCHORED', 1400);
      app.posing = true;
    },
    onShoot: () => shoot(),
    onEnd: () => leaveGame(),
  });

  // Shield button works via plain touch events in AR too.
  const shieldBtn = $('btn-shield');
  const shieldOn = (e) => { e.preventDefault(); net.shield(true); shieldBtn.classList.add('held'); };
  const shieldOff = () => { net.shield(false); shieldBtn.classList.remove('held'); };
  shieldBtn.addEventListener('touchstart', shieldOn, { passive: false });
  shieldBtn.addEventListener('touchend', shieldOff);
  shieldBtn.addEventListener('touchcancel', shieldOff);

  app.mode = ar;
  app.playing = true;
  try {
    await ar.start(app.mySlot);
  } catch (err) {
    console.error(err);
    leaveGame();
    showHomeError(`Could not start AR: ${err.message}`);
    return;
  }
  world.renderer.setAnimationLoop(tick);
}

function startFlat() {
  const flat = new FlatMode(world, {
    onShoot: () => shoot(),
    onShield: (on) => net.shield(on),
  });
  hud.configureFor(flat.touch ? 'touch' : 'desktop');
  $('btn-fire').classList.remove('hidden');
  flat.start(app.mySlot);
  app.mode = flat;
  app.playing = true;
  app.posing = true;
  hud.centerMessage(flat.touch ? 'DRAG TO LOOK · JOYSTICK TO MOVE' : 'CLICK TO CAPTURE THE MOUSE', 2600);
  world.renderer.setAnimationLoop(tick);
}

function leaveGame() {
  world.renderer.setAnimationLoop(null);
  app.playing = false;
  app.posing = false;
  const mode = app.mode;
  app.mode = null;
  if (mode instanceof FlatMode) mode.stop();
  if (mode instanceof ArMode) mode.stop();
  net.disconnect();
  world.reset();
  hud.hide();
  hud.clearCenterMessage();
  homeEl.classList.remove('hidden');
  app.lastPhase = null;
}

// ---------------------------------------------------------------------------
// Gameplay
// ---------------------------------------------------------------------------

function shoot() {
  if (!app.playing || !app.posing) return;
  if (app.me.energy < GAME.SHOT_COST) {
    hud.centerMessage('NOT ENOUGH ENERGY — HARVEST WISPS', 1100);
    sfx.drained();
    return;
  }
  const xrCam = app.modeName === 'ar' ? app.mode.getCamera() : null;
  const ray = world.getArenaLocalRay(xrCam);
  net.shoot(ray.o, ray.d);
  sfx.shoot();
}

function onSnapshot(snap) {
  world.applySnapshot(snap);
  hud.setPhase(snap.phase, snap.tl);

  const mine = snap.players.find((p) => p.id === net.id);
  if (mine) {
    app.me.energy = mine.e;
    app.me.hp = mine.hp;
    hud.setBars(mine.e, GAME.ENERGY_MAX, mine.hp, GAME.MONOLITH_HP);
  }
  refreshScoreboard(snap);

  if (snap.phase !== PHASE.ENDED && app.lastPhase === PHASE.ENDED) hud.hideEnd();
  app.lastPhase = snap.phase;

  if (snap.events) for (const ev of snap.events) handleEvent(ev);
}

function refreshScoreboard(snap) {
  const stats = new Map(snap.players.map((p) => [p.id, { hp: p.hp, live: snap.phase === PHASE.LIVE }]));
  // Keep scores fresh: snapshot carries sc per player.
  for (const r of app.roster) {
    const p = snap.players.find((sp) => sp.id === r.id);
    if (p) r.score = p.sc;
  }
  hud.setScoreboard(app.roster, stats, net.id);
}

function nameOf(id) {
  return app.roster.find((r) => r.id === id)?.name ?? '???';
}

function colorIndexOf(id) {
  return app.roster.find((r) => r.id === id)?.color ?? 0;
}

function handleEvent(ev) {
  switch (ev.kind) {
    case EV.SHOT_FIRED:
      if (ev.who !== net.id) sfx.shoot();
      break;

    case EV.WISP_TAKEN:
      world.burst(ev.p, 0x22d3ee, 16, 1.2, 0.5);
      if (ev.who === net.id) sfx.collect();
      break;

    case EV.PLAYER_HIT:
      world.burst(ev.p, 0xf87171, 14, 1.4, 0.5);
      if (ev.who === net.id) {
        sfx.drained();
        hud.damageFlash();
        hud.feed(`${nameOf(ev.by)} drained your energy!`);
      } else if (ev.by === net.id) {
        sfx.hit();
        hud.feed(`You drained ${nameOf(ev.who)} (+${GAME.PLAYER_HIT_GAIN}⚡)`);
      }
      break;

    case EV.MONOLITH_HIT:
      if (ev.blocked) {
        world.burst(ev.p, 0x22d3ee, 10, 1.0, 0.4);
        sfx.blocked();
        if (ev.by === net.id) hud.feed(`${nameOf(ev.who)}'s shield held`);
      } else {
        world.burst(ev.p, world.colorHexOf(colorIndexOf(ev.by)), 18, 1.5, 0.6);
        sfx.hit();
        if (ev.who === net.id) {
          hud.damageFlash();
          hud.feed(`${nameOf(ev.by)} hit your monolith (${ev.hp} HP)`);
        }
      }
      break;

    case EV.MONOLITH_DOWN:
      world.burst([ev.p[0], 0.8, ev.p[2]], 0xfb923c, 60, 2.6, 1.1, 0.05);
      sfx.explode();
      hud.feed(`☠ ${nameOf(ev.by)} shattered ${nameOf(ev.who)}'s monolith`);
      if (ev.who === net.id) hud.centerMessage('YOUR MONOLITH HAS FALLEN', 2200);
      break;

    case EV.TOTEM_DOWN:
      world.burst(ev.p, 0xfacc15, 40, 2.2, 0.9, 0.045);
      sfx.explode();
      if (ev.by === net.id) hud.feed(`Totem shattered (+${GAME.TOTEM_ENERGY_REWARD}⚡)`);
      break;

    case EV.COUNTDOWN:
      sfx.countdown(ev.n);
      hud.centerMessage(String(ev.n), 900);
      break;

    case EV.MATCH_START:
      sfx.matchStart();
      hud.hideEnd();
      hud.centerMessage('DESTROY THE RIVAL MONOLITHS', 2000);
      break;

    case EV.MATCH_END: {
      const iWon = ev.winners.includes(net.id);
      const lines = ev.winners.length
        ? [`${ev.names.join(' & ')} ${ev.winners.length > 1 ? 'share the' : 'takes the'} crown`]
        : ['All monoliths fell. The void wins.'];
      hud.showEnd(ev.winners.length === 0 ? null : iWon, lines);
      if (iWon) sfx.victory(); else sfx.defeat();
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

const POSE_INTERVAL = 1 / 15;

function tick(time, frame) {
  const dt = Math.min(0.1, app.lastFrameTime ? (time - app.lastFrameTime) / 1000 : 0.016);
  app.lastFrameTime = time;

  if (app.mode instanceof ArMode) app.mode.onFrame(frame);
  if (app.mode instanceof FlatMode) app.mode.update(dt);

  world.update(dt);

  if (app.posing) {
    app.poseAccum += dt;
    if (app.poseAccum >= POSE_INTERVAL) {
      app.poseAccum = 0;
      const xrCam = app.modeName === 'ar' ? app.mode.getCamera() : null;
      const pose = world.getArenaLocalPose(xrCam);
      net.sendPose(pose.p, pose.q);
    }
  }

  world.renderer.render(world.scene, world.camera);
}
