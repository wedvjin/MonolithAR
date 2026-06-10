import { MSG } from '/shared/constants.js';

/**
 * Thin WebSocket wrapper. Emits:
 *   joined, snapshot, event, playerJoined, playerLeft, error, close
 */
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.id = null;
    this.room = null;
  }

  on(type, fn) {
    this.handlers.set(type, fn);
    return this;
  }

  emit(type, ...args) {
    this.handlers.get(type)?.(...args);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not reach the game server.'));
      ws.onclose = () => this.emit('close');
      ws.onmessage = (e) => this.handleMessage(e.data);
      this.ws = ws;
    });
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.t) {
      case MSG.JOINED:
        this.id = msg.id;
        this.room = msg.room;
        this.emit('joined', msg);
        break;
      case MSG.SNAPSHOT:
        this.emit('snapshot', msg);
        break;
      case MSG.PLAYER_JOINED: this.emit('playerJoined', msg); break;
      case MSG.PLAYER_LEFT: this.emit('playerLeft', msg); break;
      case MSG.ERROR: this.emit('error', msg.msg); break;
      default: break;
    }
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  join(room, name) { this.send({ t: MSG.JOIN, room, name }); }
  sendPose(p, q) { this.send({ t: MSG.POSE, p, q }); }
  shoot(o, d) { this.send({ t: MSG.SHOOT, o, d }); }
  shield(on) { this.send({ t: MSG.SHIELD, on }); }

  disconnect() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.id = null;
    this.room = null;
  }
}
