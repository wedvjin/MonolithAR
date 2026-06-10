import * as THREE from 'three';
import { GAME, slotAngle } from '/shared/constants.js';

const MOVE_SPEED = 2.2;       // m/s
const LOOK_SENSITIVITY = 0.0024;
const TOUCH_LOOK_SENSITIVITY = 0.0042;

export const isTouchDevice = () =>
  'ontouchstart' in window || navigator.maxTouchPoints > 0;

/**
 * Non-AR fallback: first-person controls inside the arena.
 * Desktop: pointer lock + WASD + click. Mobile: virtual joystick + drag look.
 */
export class FlatMode {
  constructor(world, { onShoot, onShield }) {
    this.world = world;
    this.onShoot = onShoot;
    this.onShield = onShield;
    this.touch = isTouchDevice();
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.joy = { active: false, id: null, x: 0, y: 0 };
    this.lookTouch = { id: null, x: 0, y: 0 };
    this.shieldHeld = false;
    this.active = false;
    this.listeners = [];
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push(() => target.removeEventListener(type, fn, opts));
  }

  start(mySlot) {
    this.active = true;
    const world = this.world;
    world.enableFlatEnvironment();
    world.arena.position.set(0, 0, 0);
    world.arena.rotation.set(0, 0, 0);
    world.arena.scale.setScalar(1);
    world.arena.visible = true;
    world.arena.updateMatrixWorld();

    // Spawn next to your own monolith, facing the arena centre.
    const a = slotAngle(mySlot);
    const r = GAME.MONOLITH_RING_RADIUS + 0.45;
    world.camera.position.set(Math.cos(a) * r, GAME.PLAYER_EYE_HEIGHT, Math.sin(a) * r);
    // Face the arena centre: camera forward is (-sin yaw, -cos yaw) on the
    // ground plane, and the direction to the centre is (-cos a, -sin a).
    this.yaw = Math.atan2(Math.cos(a), Math.sin(a));
    this.pitch = 0;
    this.applyLook();

    const canvas = world.renderer.domElement;
    if (this.touch) {
      this.bindTouch(canvas);
    } else {
      this.bindDesktop(canvas);
    }
  }

  bindDesktop(canvas) {
    this.on(canvas, 'click', () => {
      if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock();
      } else {
        this.onShoot?.();
      }
    });
    this.on(document, 'mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.yaw -= e.movementX * LOOK_SENSITIVITY;
      this.pitch -= e.movementY * LOOK_SENSITIVITY;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
      this.applyLook();
    });
    this.on(document, 'keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyF') this.setShield(true);
      if (e.code === 'Space') {
        e.preventDefault();
        this.onShoot?.();
      }
    });
    this.on(document, 'keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyF') this.setShield(false);
    });
    this.on(document, 'pointerlockchange', () => {
      if (document.pointerLockElement !== canvas) this.keys.clear();
    });
  }

  bindTouch(canvas) {
    const joyEl = document.getElementById('joystick');
    const knob = document.getElementById('joystick-knob');
    joyEl.classList.remove('hidden');
    this.joyEl = joyEl;

    const joyCenter = () => {
      const r = joyEl.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, rad: r.width / 2 };
    };

    this.on(joyEl, 'touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this.joy.active = true;
      this.joy.id = t.identifier;
    }, { passive: false });

    const moveJoy = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.joy.id) continue;
        const c = joyCenter();
        let dx = (t.clientX - c.x) / c.rad;
        let dy = (t.clientY - c.y) / c.rad;
        const len = Math.hypot(dx, dy);
        if (len > 1) { dx /= len; dy /= len; }
        this.joy.x = dx;
        this.joy.y = dy;
        knob.style.transform =
          `translate(calc(-50% + ${dx * c.rad * 0.55}px), calc(-50% + ${dy * c.rad * 0.55}px))`;
      }
    };
    this.on(joyEl, 'touchmove', (e) => { e.preventDefault(); moveJoy(e); }, { passive: false });
    const endJoy = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.joy.id) continue;
        this.joy.active = false;
        this.joy.id = null;
        this.joy.x = 0;
        this.joy.y = 0;
        knob.style.transform = 'translate(-50%, -50%)';
      }
    };
    this.on(joyEl, 'touchend', endJoy);
    this.on(joyEl, 'touchcancel', endJoy);

    // Look: drag anywhere on the canvas.
    this.on(canvas, 'touchstart', (e) => {
      const t = e.changedTouches[0];
      if (this.lookTouch.id !== null) return;
      this.lookTouch.id = t.identifier;
      this.lookTouch.x = t.clientX;
      this.lookTouch.y = t.clientY;
    });
    this.on(canvas, 'touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.lookTouch.id) continue;
        this.yaw -= (t.clientX - this.lookTouch.x) * TOUCH_LOOK_SENSITIVITY;
        this.pitch -= (t.clientY - this.lookTouch.y) * TOUCH_LOOK_SENSITIVITY;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
        this.lookTouch.x = t.clientX;
        this.lookTouch.y = t.clientY;
        this.applyLook();
      }
    });
    const endLook = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.lookTouch.id) this.lookTouch.id = null;
      }
    };
    this.on(canvas, 'touchend', endLook);
    this.on(canvas, 'touchcancel', endLook);

    // Fire / shield buttons (shared with HUD).
    const fireBtn = document.getElementById('btn-fire');
    const shieldBtn = document.getElementById('btn-shield');
    this.on(fireBtn, 'touchstart', (e) => { e.preventDefault(); this.onShoot?.(); }, { passive: false });
    this.on(shieldBtn, 'touchstart', (e) => { e.preventDefault(); this.setShield(true); }, { passive: false });
    this.on(shieldBtn, 'touchend', () => this.setShield(false));
    this.on(shieldBtn, 'touchcancel', () => this.setShield(false));
  }

  setShield(on) {
    if (this.shieldHeld === on) return;
    this.shieldHeld = on;
    document.getElementById('btn-shield')?.classList.toggle('held', on);
    this.onShield?.(on);
  }

  applyLook() {
    this.world.camera.rotation.set(0, 0, 0);
    this.world.camera.rotateY(this.yaw);
    this.world.camera.rotateX(this.pitch);
  }

  update(dt) {
    if (!this.active) return;
    const cam = this.world.camera;
    let fwd = 0, strafe = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fwd += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fwd -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1;
    if (this.joy.active) {
      fwd -= this.joy.y;
      strafe += this.joy.x;
    }
    if (fwd === 0 && strafe === 0) return;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // Camera forward on the ground plane.
    const dx = (-sin * fwd) + (cos * strafe);
    const dz = (-cos * fwd) + (-sin * strafe);
    cam.position.x += dx * MOVE_SPEED * dt;
    cam.position.z += dz * MOVE_SPEED * dt;

    // Stay inside the arena.
    const maxR = GAME.ARENA_RADIUS - 0.15;
    const r = Math.hypot(cam.position.x, cam.position.z);
    if (r > maxR) {
      cam.position.x *= maxR / r;
      cam.position.z *= maxR / r;
    }
    cam.position.y = GAME.PLAYER_EYE_HEIGHT;
  }

  stop() {
    this.active = false;
    this.setShield(false);
    for (const off of this.listeners) off();
    this.listeners = [];
    this.keys.clear();
    this.joyEl?.classList.add('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
    this.world.disableFlatEnvironment();
  }
}
