import { GAME, PHASE, EV, slotAngle, monolithPosition } from '../shared/constants.js';

let nextEntityId = 1;
const eid = () => nextEntityId++;

const dist2 = (a, b) => {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

/**
 * One room = one arena = one running simulation.
 * All positions are in "arena space": metres, Y up, arena centre at origin.
 * Each client anchors arena space onto its own floor, so the simulation
 * is fully device-agnostic.
 */
export class Room {
  constructor(code, onEmpty) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.players = new Map();   // id -> player
    this.projectiles = [];
    this.wisps = [];
    this.events = [];           // drained into each snapshot
    this.phase = PHASE.LOBBY;
    this.phaseTime = 0;         // seconds remaining in current phase (where applicable)
    this.wispTimer = 0;
    this.totem = this.makeTotem();
    this.lastCountdownSecond = -1;
    this.winnerIds = [];
  }

  makeTotem() {
    return { hp: GAME.TOTEM_HP, respawnIn: 0, pos: [0, 0, 0] };
  }

  get size() {
    return this.players.size;
  }

  freeSlot() {
    const used = new Set([...this.players.values()].map((p) => p.slot));
    for (let s = 0; s < GAME.MAX_PLAYERS; s++) if (!used.has(s)) return s;
    return -1;
  }

  addPlayer(id, name) {
    const slot = this.freeSlot();
    if (slot < 0) return null;
    const player = {
      id,
      name,
      slot,
      colorIndex: slot % GAME.MAX_PLAYERS,
      pos: monolithPosition(slot).slice(),
      quat: [0, 0, 0, 1],
      energy: GAME.ENERGY_START,
      shield: false,
      cooldown: 0,
      monolith: {
        hp: this.phase === PHASE.LIVE ? 0 : GAME.MONOLITH_HP, // late joiners spectate live matches
        pos: monolithPosition(slot),
        angle: slotAngle(slot),
        alive: this.phase !== PHASE.LIVE,
      },
      score: 0,
      poseSeen: false,
    };
    player.pos[1] = GAME.PLAYER_EYE_HEIGHT;
    this.players.set(id, player);
    this.maybeStartCountdown();
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.projectiles = this.projectiles.filter((pr) => pr.owner !== id);
    if (this.size === 0) {
      this.onEmpty(this.code);
      return;
    }
    if (this.phase === PHASE.LIVE) this.checkVictory();
    if (this.phase === PHASE.COUNTDOWN && this.size < 2) {
      this.phase = PHASE.LOBBY;
      this.lastCountdownSecond = -1;
    }
  }

  maybeStartCountdown() {
    if (this.phase === PHASE.LOBBY && this.size >= 2) {
      this.phase = PHASE.COUNTDOWN;
      this.phaseTime = GAME.COUNTDOWN_SECONDS;
      this.lastCountdownSecond = -1;
    }
  }

  startMatch() {
    this.phase = PHASE.LIVE;
    this.phaseTime = GAME.MATCH_SECONDS;
    this.projectiles = [];
    this.wisps = [];
    this.wispTimer = 0;
    this.winnerIds = [];
    for (const p of this.players.values()) {
      p.energy = GAME.ENERGY_START;
      p.shield = false;
      p.monolith.hp = GAME.MONOLITH_HP;
      p.monolith.alive = true;
    }
    this.pushEvent({ kind: EV.MATCH_START });
  }

  endMatch(winnerIds) {
    this.phase = PHASE.ENDED;
    this.phaseTime = GAME.ENDED_SECONDS;
    this.winnerIds = winnerIds;
    for (const w of winnerIds) {
      const p = this.players.get(w);
      if (p) p.score += 1;
    }
    this.pushEvent({
      kind: EV.MATCH_END,
      winners: winnerIds,
      names: winnerIds.map((w) => this.players.get(w)?.name ?? '?'),
    });
  }

  pushEvent(ev) {
    this.events.push(ev);
  }

  // ---- client input -------------------------------------------------------

  handlePose(player, p, q) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) return;
    if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)) return;
    const r = Math.hypot(p[0], p[2]);
    const maxR = GAME.ARENA_RADIUS * 2; // generous: AR players may step outside
    if (r > maxR || Math.abs(p[1]) > 5) return;
    player.pos = p;
    player.quat = q;
    player.poseSeen = true;
  }

  handleShoot(player, origin, dir) {
    if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite)) return;
    if (!Array.isArray(dir) || dir.length !== 3 || !dir.every(Number.isFinite)) return;
    if (player.cooldown > 0 || player.energy < GAME.SHOT_COST) return;
    if (this.phase === PHASE.ENDED || this.phase === PHASE.COUNTDOWN) return;

    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (len < 1e-4) return;
    const d = [dir[0] / len, dir[1] / len, dir[2] / len];
    // Origin must be near the player's reported head position (anti-cheat-lite).
    if (dist2(origin, player.pos) > 1.0) origin = player.pos.slice();

    player.energy -= GAME.SHOT_COST;
    player.cooldown = GAME.SHOT_COOLDOWN;
    this.projectiles.push({
      id: eid(),
      owner: player.id,
      colorIndex: player.colorIndex,
      pos: origin.slice(),
      dir: d,
      ttl: GAME.SHOT_LIFETIME,
    });
    this.pushEvent({ kind: EV.SHOT_FIRED, who: player.id, p: origin, d });
  }

  handleShield(player, on) {
    player.shield = Boolean(on) && player.energy > GAME.SHIELD_MIN_ENERGY;
  }

  // ---- simulation ---------------------------------------------------------

  tick(dt) {
    if (this.phase === PHASE.COUNTDOWN) {
      this.phaseTime -= dt;
      const sec = Math.ceil(this.phaseTime);
      if (sec !== this.lastCountdownSecond && sec > 0) {
        this.lastCountdownSecond = sec;
        this.pushEvent({ kind: EV.COUNTDOWN, n: sec });
      }
      if (this.phaseTime <= 0) this.startMatch();
    } else if (this.phase === PHASE.LIVE) {
      this.phaseTime -= dt;
      if (this.phaseTime <= 0) this.timeoutVictory();
    } else if (this.phase === PHASE.ENDED) {
      this.phaseTime -= dt;
      if (this.phaseTime <= 0) {
        this.phase = PHASE.LOBBY;
        this.totem = this.makeTotem();
        this.maybeStartCountdown();
      }
    }

    for (const p of this.players.values()) {
      p.cooldown = Math.max(0, p.cooldown - dt);
      if (p.shield) {
        p.energy -= GAME.SHIELD_DRAIN * dt;
        if (p.energy <= GAME.SHIELD_MIN_ENERGY) {
          p.energy = Math.max(0, p.energy);
          p.shield = false;
        }
      }
    }

    this.tickWisps(dt);
    this.tickProjectiles(dt);
    this.tickTotem(dt);
  }

  tickWisps(dt) {
    if (this.phase === PHASE.LIVE || this.phase === PHASE.LOBBY) {
      this.wispTimer -= dt;
      if (this.wispTimer <= 0 && this.wisps.length < GAME.WISP_MAX) {
        this.wispTimer = GAME.WISP_SPAWN_INTERVAL;
        const a = Math.random() * Math.PI * 2;
        const r = 0.4 + Math.random() * (GAME.ARENA_RADIUS - 0.8);
        this.wisps.push({
          id: eid(),
          pos: [Math.cos(a) * r, GAME.WISP_HEIGHT, Math.sin(a) * r],
          seed: Math.random() * 100,
          t: 0,
        });
      }
    }

    for (const w of this.wisps) {
      w.t += dt;
      // Lazy drift on a lissajous-ish path around its spawn point.
      w.pos[0] += Math.sin(w.t * 0.7 + w.seed) * 0.12 * dt;
      w.pos[2] += Math.cos(w.t * 0.5 + w.seed * 1.3) * 0.12 * dt;
      w.pos[1] = GAME.WISP_HEIGHT + Math.sin(w.t * 1.5 + w.seed) * 0.1;
    }

    // Collection by proximity to a player's head.
    const r2 = GAME.WISP_COLLECT_RADIUS * GAME.WISP_COLLECT_RADIUS;
    this.wisps = this.wisps.filter((w) => {
      for (const p of this.players.values()) {
        if (!p.poseSeen) continue;
        if (dist2(w.pos, p.pos) <= r2) {
          p.energy = Math.min(GAME.ENERGY_MAX, p.energy + GAME.WISP_ENERGY);
          this.pushEvent({ kind: EV.WISP_TAKEN, who: p.id, p: w.pos });
          return false;
        }
      }
      return true;
    });
  }

  tickProjectiles(dt) {
    const survivors = [];
    for (const pr of this.projectiles) {
      pr.ttl -= dt;
      if (pr.ttl <= 0) continue;
      pr.pos[0] += pr.dir[0] * GAME.SHOT_SPEED * dt;
      pr.pos[1] += pr.dir[1] * GAME.SHOT_SPEED * dt;
      pr.pos[2] += pr.dir[2] * GAME.SHOT_SPEED * dt;
      if (pr.pos[1] < -0.2 || Math.hypot(pr.pos[0], pr.pos[2]) > GAME.ARENA_RADIUS * 2.5) continue;
      if (this.resolveProjectileHit(pr)) continue;
      survivors.push(pr);
    }
    this.projectiles = survivors;
  }

  resolveProjectileHit(pr) {
    // 1. Rival players (head sphere). Steals energy.
    const pr2 = (GAME.SHOT_RADIUS + GAME.PLAYER_HIT_RADIUS) ** 2;
    for (const p of this.players.values()) {
      if (p.id === pr.owner || !p.poseSeen) continue;
      if (dist2(pr.pos, p.pos) <= pr2) {
        const stolen = Math.min(p.energy, GAME.PLAYER_HIT_DRAIN);
        p.energy -= stolen;
        const shooter = this.players.get(pr.owner);
        if (shooter) shooter.energy = Math.min(GAME.ENERGY_MAX, shooter.energy + GAME.PLAYER_HIT_GAIN);
        this.pushEvent({ kind: EV.PLAYER_HIT, who: p.id, by: pr.owner, p: pr.pos });
        return true;
      }
    }

    // 2. Monoliths (vertical capsule approximated as cylinder).
    if (this.phase === PHASE.LIVE) {
      for (const p of this.players.values()) {
        if (p.id === pr.owner || !p.monolith.alive) continue;
        const m = p.monolith;
        const dx = pr.pos[0] - m.pos[0];
        const dz = pr.pos[2] - m.pos[2];
        const horiz = Math.hypot(dx, dz);
        const within =
          horiz <= GAME.MONOLITH_HIT_RADIUS + GAME.SHOT_RADIUS &&
          pr.pos[1] >= -0.1 &&
          pr.pos[1] <= GAME.MONOLITH_HEIGHT + 0.2;
        if (!within) continue;
        if (p.shield) {
          this.pushEvent({ kind: EV.MONOLITH_HIT, who: p.id, by: pr.owner, blocked: true, p: pr.pos });
          return true;
        }
        m.hp = Math.max(0, m.hp - GAME.SHOT_DAMAGE);
        this.pushEvent({ kind: EV.MONOLITH_HIT, who: p.id, by: pr.owner, hp: m.hp, p: pr.pos });
        if (m.hp <= 0) {
          m.alive = false;
          this.pushEvent({ kind: EV.MONOLITH_DOWN, who: p.id, by: pr.owner, p: m.pos });
          this.checkVictory();
        }
        return true;
      }
    }

    // 3. Practice totem (lobby only).
    if (this.phase === PHASE.LOBBY && this.totem.respawnIn <= 0) {
      const dx = pr.pos[0], dz = pr.pos[2];
      if (Math.hypot(dx, dz) <= 0.35 + GAME.SHOT_RADIUS && pr.pos[1] <= 1.4 && pr.pos[1] >= -0.1) {
        this.totem.hp -= GAME.SHOT_DAMAGE;
        this.pushEvent({ kind: EV.MONOLITH_HIT, who: 'totem', by: pr.owner, hp: this.totem.hp, p: pr.pos });
        if (this.totem.hp <= 0) {
          this.totem.respawnIn = GAME.TOTEM_RESPAWN;
          const shooter = this.players.get(pr.owner);
          if (shooter) shooter.energy = Math.min(GAME.ENERGY_MAX, shooter.energy + GAME.TOTEM_ENERGY_REWARD);
          this.pushEvent({ kind: EV.TOTEM_DOWN, by: pr.owner, p: [0, 0.7, 0] });
        }
        return true;
      }
    }

    return false;
  }

  tickTotem(dt) {
    if (this.totem.respawnIn > 0) {
      this.totem.respawnIn -= dt;
      if (this.totem.respawnIn <= 0) this.totem.hp = GAME.TOTEM_HP;
    }
  }

  checkVictory() {
    if (this.phase !== PHASE.LIVE) return;
    const alive = [...this.players.values()].filter((p) => p.monolith.alive);
    if (alive.length <= 1) {
      this.endMatch(alive.map((p) => p.id));
    }
  }

  timeoutVictory() {
    const alive = [...this.players.values()].filter((p) => p.monolith.alive);
    if (alive.length === 0) return this.endMatch([]);
    const best = Math.max(...alive.map((p) => p.monolith.hp));
    this.endMatch(alive.filter((p) => p.monolith.hp === best).map((p) => p.id));
  }

  // ---- serialization ------------------------------------------------------

  round(v) {
    return Math.round(v * 1000) / 1000;
  }

  snapshot() {
    // NB: this object is spread into { t: MSG.SNAPSHOT, ... } when broadcast,
    // so no key here may be named "t".
    const snap = {
      phase: this.phase,
      tl: this.round(Math.max(0, this.phaseTime)),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        p: p.pos.map(this.round),
        q: p.quat.map(this.round),
        e: Math.round(p.energy),
        sh: p.shield ? 1 : 0,
        hp: p.monolith.hp,
        sc: p.score,
      })),
      wisps: this.wisps.map((w) => ({ id: w.id, p: w.pos.map(this.round) })),
      shots: this.projectiles.map((pr) => ({
        id: pr.id,
        p: pr.pos.map(this.round),
        d: pr.dir.map(this.round),
        c: pr.colorIndex,
        o: pr.owner,
      })),
      totem: this.phase === PHASE.LOBBY
        ? { hp: Math.max(0, this.totem.hp), up: this.totem.respawnIn <= 0 ? 1 : 0 }
        : null,
      winners: this.phase === PHASE.ENDED ? this.winnerIds : undefined,
    };
    if (this.events.length) {
      snap.events = this.events;
      this.events = [];
    }
    return snap;
  }

  roster() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      slot: p.slot,
      color: p.colorIndex,
      score: p.score,
    }));
  }
}
