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
 * Handheld WebXR AR mode: hit-test driven arena placement, then tap-to-shoot.
 */
export class ArMode {
  constructor(world, hudRoot, { onShoot, onPlaced, onEnd }) {
    this.world = world;
    this.hudRoot = hudRoot;
    this.onShoot = onShoot;
    this.onPlaced = onPlaced;
    this.onEnd = onEnd;
    this.session = null;
    this.hitTestSource = null;
    this.localSpace = null;
    this.viewerSpace = null;
    this.placed = false;
    this.mySlot = 0;
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

    this.viewerSpace = await session.requestReferenceSpace('viewer');
    this.localSpace = await session.requestReferenceSpace('local-floor');
    this.hitTestSource = await session.requestHitTestSource({ space: this.viewerSpace });

    session.addEventListener('select', this.handleSelect);
    session.addEventListener('end', () => {
      this.hitTestSource = null;
      this.session = null;
      this.onEnd?.();
    });
  }

  handleSelect = () => {
    if (!this.placed) {
      if (this.world.reticle.visible) this.placeArena();
      return;
    }
    this.onShoot?.();
  };

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
    if (this.placed || !frame || !this.hitTestSource) return;
    const hits = frame.getHitTestResults(this.hitTestSource);
    if (hits.length > 0) {
      const pose = hits[0].getPose(this.localSpace);
      if (pose) {
        this.world.reticle.visible = true;
        this.world.reticle.matrix.fromArray(pose.transform.matrix);
        return;
      }
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
