import * as THREE from 'three';
import { slotAngle } from '/shared/constants.js';

// The arena is shrunk slightly in AR so a ~4m play space fits the whole ring.
// Pose maths is unaffected: poses are reported in arena-local units, so the
// scale simply amplifies physical movement a little.
const AR_ARENA_SCALE = 0.7;

export const arSupported = async () => {
  if (!('xr' in navigator)) return false;
  try {
    return await navigator.xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
};

/**
 * WebXR AR mode for both handheld (phone) and headset (Meta Quest) devices.
 *
 * Input is unified through three.js XR controllers: on phones a screen tap
 * surfaces as a transient controller with targetRayMode 'screen'; on Quest
 * each Touch controller (or tracked hand) is a 'tracked-pointer'.
 *   - trigger / tap  → place arena, then shoot
 *   - grip squeeze   → hold shield (headset; phones use the HUD button)
 * Tracked pointers aim along the controller ray and get a laser pointer +
 * haptic feedback; screen taps shoot along the camera ray (the crosshair).
 */
export class ArMode {
  constructor(world, hudRoot, { onShoot, onShield, onPlaced, onEnd }) {
    this.world = world;
    this.hudRoot = hudRoot;
    this.onShoot = onShoot;
    this.onShield = onShield;
    this.onPlaced = onPlaced;
    this.onEnd = onEnd;
    this.session = null;
    this.viewerHitTestSource = null;
    this.localSpace = null;
    this.placed = false;
    this.mySlot = 0;
    this.controllers = [];
    this.hasTrackedPointer = false;
  }

  async start(mySlot) {
    this.mySlot = mySlot;
    this.placed = false;
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'local-floor'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: this.hudRoot },
    });
    this.session = session;

    this.world.renderer.xr.setReferenceSpaceType('local-floor');
    await this.world.renderer.xr.setSession(session);

    const viewerSpace = await session.requestReferenceSpace('viewer');
    this.localSpace = await session.requestReferenceSpace('local-floor');
    this.viewerHitTestSource = await session.requestHitTestSource({ space: viewerSpace });

    this.setupControllers();

    session.addEventListener('end', () => {
      this.teardownControllers();
      this.viewerHitTestSource = null;
      this.session = null;
      this.onEnd?.();
    });
  }

  /** True when the HUD DOM overlay is actually being composited (phones).
   *  Quest Browser has no dom-overlay, so headsets need the in-world HUD. */
  get domOverlayActive() {
    return Boolean(this.session?.domOverlayState?.type);
  }

  setupControllers() {
    for (const i of [0, 1]) {
      const c = this.world.renderer.xr.getController(i);
      c.userData.rayMode = null;
      c.userData.source = null;
      c.userData.hitTestSource = null;

      c.userData.onConnected = (e) => {
        c.userData.rayMode = e.data.targetRayMode;
        c.userData.source = e.data;
        if (e.data.targetRayMode === 'tracked-pointer') {
          this.hasTrackedPointer = true;
          this.attachLaser(c);
          // Aim arena placement with the controller ray.
          this.session?.requestHitTestSource({ space: e.data.targetRaySpace })
            .then((src) => { c.userData.hitTestSource = src; })
            .catch(() => {});
        }
      };
      c.userData.onDisconnected = () => {
        c.userData.rayMode = null;
        c.userData.source = null;
        c.userData.hitTestSource?.cancel?.();
        c.userData.hitTestSource = null;
        this.removeLaser(c);
      };
      c.userData.onSelect = () => this.handleSelectFrom(c);
      c.userData.onSqueezeStart = () => this.onShield?.(true);
      c.userData.onSqueezeEnd = () => this.onShield?.(false);

      c.addEventListener('connected', c.userData.onConnected);
      c.addEventListener('disconnected', c.userData.onDisconnected);
      c.addEventListener('select', c.userData.onSelect);
      c.addEventListener('squeezestart', c.userData.onSqueezeStart);
      c.addEventListener('squeezeend', c.userData.onSqueezeEnd);

      this.world.scene.add(c);
      this.controllers.push(c);
    }
  }

  teardownControllers() {
    for (const c of this.controllers) {
      c.removeEventListener('connected', c.userData.onConnected);
      c.removeEventListener('disconnected', c.userData.onDisconnected);
      c.removeEventListener('select', c.userData.onSelect);
      c.removeEventListener('squeezestart', c.userData.onSqueezeStart);
      c.removeEventListener('squeezeend', c.userData.onSqueezeEnd);
      c.userData.hitTestSource?.cancel?.();
      c.userData.hitTestSource = null;
      this.removeLaser(c);
      this.world.scene.remove(c);
    }
    this.controllers = [];
    this.hasTrackedPointer = false;
  }

  attachLaser(controller) {
    if (controller.userData.laser) return;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -3),
    ]);
    const laser = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.6 })
    );
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xc084fc })
    );
    tip.position.z = -3;
    laser.add(tip);
    controller.add(laser);
    controller.userData.laser = laser;
  }

  removeLaser(controller) {
    const laser = controller.userData.laser;
    if (!laser) return;
    controller.remove(laser);
    laser.geometry.dispose();
    laser.material.dispose();
    controller.userData.laser = null;
  }

  pulse(controller, intensity = 0.5, ms = 40) {
    controller.userData.source?.gamepad?.hapticActuators?.[0]?.pulse?.(intensity, ms);
  }

  handleSelectFrom(controller) {
    if (!this.placed) {
      if (this.world.reticle.visible) {
        this.placeArena();
        this.pulse(controller, 0.8, 80);
      }
      return;
    }
    if (controller.userData.rayMode === 'tracked-pointer') {
      this.onShoot?.(this.world.getArenaLocalRayFrom(controller));
      this.pulse(controller);
    } else {
      // Screen tap / gaze: shoot where the player is looking.
      this.onShoot?.();
    }
  }

  placeArena() {
    const arena = this.world.arena;
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    this.world.reticle.matrix.decompose(pos, q, s);

    // Yaw the arena so the local player's monolith pad sits on their side.
    const cam = this.world.renderer.xr.getCamera();
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const toCam = camPos.clone().sub(pos);
    const worldAngle = Math.atan2(toCam.z, toCam.x);

    arena.position.copy(pos);
    arena.rotation.set(0, slotAngle(this.mySlot) - worldAngle, 0);
    arena.scale.setScalar(AR_ARENA_SCALE);
    arena.visible = true;
    arena.updateMatrixWorld();

    this.world.reticle.visible = false;
    this.placed = true;
    this.onPlaced?.();
  }

  /** Call once per rendered frame with the XRFrame. */
  onFrame(frame) {
    if (this.placed || !frame) return;

    // Prefer controller-ray hits (point at the floor) over head-gaze hits.
    const sources = [];
    for (const c of this.controllers) {
      if (c.userData.hitTestSource) sources.push(c.userData.hitTestSource);
    }
    if (this.viewerHitTestSource) sources.push(this.viewerHitTestSource);

    for (const src of sources) {
      const hits = frame.getHitTestResults(src);
      if (hits.length === 0) continue;
      const pose = hits[0].getPose(this.localSpace);
      if (!pose) continue;
      this.world.reticle.visible = true;
      this.world.reticle.matrix.fromArray(pose.transform.matrix);
      return;
    }
    this.world.reticle.visible = false;
  }

  getCamera() {
    return this.world.renderer.xr.getCamera();
  }

  async stop() {
    if (this.session) {
      try { await this.session.end(); } catch { /* already ended */ }
    }
  }
}
