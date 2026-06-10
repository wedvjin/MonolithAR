// Shared between the Node server and the browser client.
// Keep this file dependency-free ES module code.

export const MSG = {
  // client -> server
  JOIN: 'join',
  POSE: 'pose',
  SHOOT: 'shoot',
  SHIELD: 'shield',
  PING: 'ping',

  // server -> client
  JOINED: 'joined',
  SNAPSHOT: 'snap',
  EVENT: 'ev',
  PLAYER_JOINED: 'pj',
  PLAYER_LEFT: 'pl',
  ERROR: 'err',
  PONG: 'pong',
};

export const EV = {
  SHOT_FIRED: 'shot',
  MONOLITH_HIT: 'mhit',
  PLAYER_HIT: 'phit',
  WISP_TAKEN: 'wisp',
  MONOLITH_DOWN: 'mdown',
  TOTEM_DOWN: 'tdown',
  MATCH_START: 'start',
  MATCH_END: 'end',
  COUNTDOWN: 'count',
};

export const PHASE = {
  LOBBY: 'lobby',       // < 2 players: free practice
  COUNTDOWN: 'countdown',
  LIVE: 'live',
  ENDED: 'ended',
};

export const GAME = {
  TICK_RATE: 20,            // server simulation Hz
  SNAPSHOT_RATE: 15,        // state broadcast Hz
  MAX_PLAYERS: 8,

  ARENA_RADIUS: 3.0,        // metres (real-world scale in AR)
  MONOLITH_RING_RADIUS: 2.2,
  MONOLITH_HP: 100,
  MONOLITH_HIT_RADIUS: 0.45,
  MONOLITH_HEIGHT: 1.6,

  PLAYER_HIT_RADIUS: 0.30,
  PLAYER_EYE_HEIGHT: 1.6,   // fallback modes only; AR uses the real camera

  ENERGY_START: 50,
  ENERGY_MAX: 100,
  SHOT_COST: 10,
  SHOT_DAMAGE: 12,
  SHOT_SPEED: 6.0,          // m/s
  SHOT_LIFETIME: 2.5,       // s
  SHOT_RADIUS: 0.10,
  SHOT_COOLDOWN: 0.35,      // s
  PLAYER_HIT_DRAIN: 15,     // energy stolen from a player you hit
  PLAYER_HIT_GAIN: 8,

  SHIELD_DRAIN: 9,          // energy per second
  SHIELD_MIN_ENERGY: 2,

  WISP_MAX: 6,
  WISP_SPAWN_INTERVAL: 3.0, // s
  WISP_ENERGY: 15,
  WISP_COLLECT_RADIUS: 0.55,
  WISP_HEIGHT: 1.15,

  TOTEM_HP: 36,             // neutral practice totem (lobby phase)
  TOTEM_ENERGY_REWARD: 20,
  TOTEM_RESPAWN: 4.0,       // s

  COUNTDOWN_SECONDS: 5,
  MATCH_SECONDS: 180,
  ENDED_SECONDS: 8,
};

export const PLAYER_COLORS = [
  '#22d3ee', // cyan
  '#f472b6', // pink
  '#a3e635', // lime
  '#fb923c', // orange
  '#a78bfa', // violet
  '#facc15', // yellow
  '#34d399', // emerald
  '#f87171', // red
];

// Spawn angle (radians) around the monolith ring for a given slot.
export function slotAngle(slot) {
  return (slot / GAME.MAX_PLAYERS) * Math.PI * 2 + Math.PI / GAME.MAX_PLAYERS;
}

export function monolithPosition(slot) {
  const a = slotAngle(slot);
  return [
    Math.cos(a) * GAME.MONOLITH_RING_RADIUS,
    0,
    Math.sin(a) * GAME.MONOLITH_RING_RADIUS,
  ];
}

export function sanitizeName(name) {
  return String(name ?? '')
    .replace(/[^\p{L}\p{N} _\-.]/gu, '')
    .trim()
    .slice(0, 16) || 'Wanderer';
}

export function normalizeRoomCode(code) {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}
