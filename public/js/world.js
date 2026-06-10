import * as THREE from 'three';
import { GAME, PHASE, PLAYER_COLORS, monolithPosition, slotAngle } from '/shared/constants.js';

const LERP_POS = 12; // interpolation stiffness for remote entities

function makeTextSprite(text, color = '#e2e8f0') {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = 'bold 44px "Courier New", monospace';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 28;
  canvas.width = w;
  canvas.height = 64;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(5, 6, 12, 0.55)';
  ctx.beginPath();
  ctx.roundRect(0, 6, w, 52, 12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const scale = 0.0045;
  sprite.scale.set(w * scale, 64 * scale, 1);
  return sprite;
}

class HpBar {
  constructor(width = 0.5) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 128;
    this.canvas.height = 20;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, depthTest: false, transparent: true }));
    this.sprite.scale.set(width, width * 20 / 128, 1);
    this.value = -1;
    this.set(1);
  }

  set(frac) {
    frac = Math.max(0, Math.min(1, frac));
    if (Math.abs(frac - this.value) < 0.005) return;
    this.value = frac;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, 128, 20);
    ctx.fillStyle = 'rgba(5,6,12,0.7)';
    ctx.beginPath();
    ctx.roundRect(0, 0, 128, 20, 9);
    ctx.fill();
    const color = frac > 0.5 ? '#a3e635' : frac > 0.25 ? '#facc15' : '#f87171';
    ctx.fillStyle = color;
    if (frac > 0) {
      ctx.beginPath();
      ctx.roundRect(3, 3, 122 * frac, 14, 6);
      ctx.fill();
    }
    this.tex.needsUpdate = true;
  }
}

function colorOf(index) {
  return new THREE.Color(PLAYER_COLORS[index % PLAYER_COLORS.length]);
}

// ---------------------------------------------------------------------------

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true, // transparent over the camera feed in AR
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 60);
    this.camera.position.set(0, GAME.PLAYER_EYE_HEIGHT, GAME.ARENA_RADIUS * 1.1);

    const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x202038, 1.2);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(2, 5, 1);
    this.scene.add(dir);

    // Everything gameplay-related lives under arenaGroup, so anchoring the
    // arena in AR is just a matter of setting this group's transform.
    this.arena = new THREE.Group();
    this.arena.visible = false;
    this.scene.add(this.arena);

    this.buildArena();
    this.buildTotem();
    this.buildReticle();

    this.players = new Map();    // id -> { group, body, label, colorIndex, target {p,q} }
    this.monoliths = new Map();  // slot -> { group, mesh, glyphs, hpBar, shield, alive }
    this.wisps = new Map();      // id -> { mesh, target }
    this.shots = new Map();      // id -> { mesh, light?, target, dir }
    this.particles = [];
    this.flatEnv = null;
    this.time = 0;
    this.myId = null;

    window.addEventListener('resize', () => {
      if (this.renderer.xr.isPresenting) return;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ---- static geometry ----------------------------------------------------

  buildArena() {
    const R = GAME.ARENA_RADIUS;

    // Floor disc: subtle radial gradient via vertex colors.
    const discGeo = new THREE.CircleGeometry(R, 64);
    discGeo.rotateX(-Math.PI / 2);
    const disc = new THREE.Mesh(
      discGeo,
      new THREE.MeshBasicMaterial({ color: 0x0a1020, transparent: true, opacity: 0.55 })
    );
    disc.position.y = 0.001;
    this.arena.add(disc);

    // Concentric glow rings on the floor.
    for (const [r, c, o] of [[R, 0x5eead4, 0.9], [R * 0.66, 0x3b82a6, 0.4], [R * 0.33, 0x3b82a6, 0.3]]) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r - 0.02, r, 96),
        new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.003;
      this.arena.add(ring);
    }

    // Radial spokes to each monolith pad.
    const spokeMat = new THREE.LineBasicMaterial({ color: 0x29455e, transparent: true, opacity: 0.7 });
    for (let s = 0; s < GAME.MAX_PLAYERS; s++) {
      const a = slotAngle(s);
      const pts = [
        new THREE.Vector3(Math.cos(a) * 0.4, 0.004, Math.sin(a) * 0.4),
        new THREE.Vector3(Math.cos(a) * (R - 0.1), 0.004, Math.sin(a) * (R - 0.1)),
      ];
      this.arena.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), spokeMat));
    }

    // Slowly rotating rune ring, floating above the rim.
    const runes = new THREE.Group();
    const runeMat = new THREE.MeshBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.85 });
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const rune = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.12 + (i % 3) * 0.05), runeMat);
      rune.position.set(Math.cos(a) * (R - 0.05), 0.06, Math.sin(a) * (R - 0.05));
      rune.lookAt(0, 0.06, 0);
      runes.add(rune);
    }
    this.runeRing = runes;
    this.arena.add(runes);

    // Boundary pillars between monolith pads.
    const pillarGeo = new THREE.CylinderGeometry(0.02, 0.035, 0.5, 6);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x111827, emissive: 0x5eead4, emissiveIntensity: 0.4, roughness: 0.4,
    });
    for (let i = 0; i < GAME.MAX_PLAYERS; i++) {
      const a = (i / GAME.MAX_PLAYERS) * Math.PI * 2;
      const p = new THREE.Mesh(pillarGeo, pillarMat);
      p.position.set(Math.cos(a) * R, 0.25, Math.sin(a) * R);
      this.arena.add(p);
    }
  }

  buildTotem() {
    const g = new THREE.Group();
    const crystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.22, 0),
      new THREE.MeshStandardMaterial({
        color: 0x0f172a, emissive: 0xfacc15, emissiveIntensity: 0.9,
        roughness: 0.2, metalness: 0.4,
      })
    );
    crystal.position.y = 0.85;
    g.add(crystal);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.26, 0.35, 6),
      new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.8 })
    );
    base.position.y = 0.18;
    g.add(base);
    const hpBar = new HpBar(0.45);
    hpBar.sprite.position.y = 1.35;
    g.add(hpBar.sprite);
    g.visible = false;
    this.totem = { group: g, crystal, hpBar };
    this.arena.add(g);
  }

  buildReticle() {
    // AR placement reticle (lives in world space, driven by hit-test results).
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.15, 32),
      new THREE.MeshBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    g.add(ring);
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.02, 16),
      new THREE.MeshBasicMaterial({ color: 0xc084fc })
    );
    dot.rotation.x = -Math.PI / 2;
    dot.position.y = 0.001;
    g.add(dot);
    g.matrixAutoUpdate = false;
    g.visible = false;
    this.reticle = g;
    this.scene.add(g);
  }

  /** Dark void + stars + outer grid for the non-AR fallback mode. */
  enableFlatEnvironment() {
    if (this.flatEnv) { this.flatEnv.visible = true; return; }
    const env = new THREE.Group();
    this.scene.background = new THREE.Color(0x05060c);
    this.scene.fog = new THREE.FogExp2(0x05060c, 0.045);

    const starGeo = new THREE.BufferGeometry();
    const n = 600;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 20 + Math.random() * 25;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.95); // bias above horizon
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    env.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x8ea8c8, size: 0.06 })));

    const grid = new THREE.GridHelper(60, 60, 0x14304a, 0x0b1828);
    grid.position.y = -0.01;
    env.add(grid);

    this.flatEnv = env;
    this.scene.add(env);
  }

  disableFlatEnvironment() {
    if (this.flatEnv) this.flatEnv.visible = false;
    this.scene.background = null;
    this.scene.fog = null;
  }

  // ---- dynamic entities ----------------------------------------------------

  ensureMonolith(slot, colorIndex, name) {
    let m = this.monoliths.get(slot);
    if (m) return m;
    const color = colorOf(colorIndex);
    const group = new THREE.Group();
    const [x, , z] = monolithPosition(slot);
    group.position.set(x, 0, z);
    group.lookAt(0, 0, 0);

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, GAME.MONOLITH_HEIGHT, 0.16),
      new THREE.MeshStandardMaterial({
        color: 0x05070d, roughness: 0.25, metalness: 0.6,
        emissive: color, emissiveIntensity: 0.25,
      })
    );
    mesh.position.y = GAME.MONOLITH_HEIGHT / 2;
    group.add(mesh);

    // Glowing edge frame.
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color })
    );
    edges.position.copy(mesh.position);
    group.add(edges);

    // Orbiting glyph shards.
    const glyphs = new THREE.Group();
    const glyphMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
    for (let i = 0; i < 4; i++) {
      const shard = new THREE.Mesh(new THREE.TetrahedronGeometry(0.045), glyphMat);
      shard.userData.angle = (i / 4) * Math.PI * 2;
      glyphs.add(shard);
    }
    glyphs.position.y = GAME.MONOLITH_HEIGHT * 0.78;
    group.add(glyphs);

    // Base pad.
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.5, 0.04, 24),
      new THREE.MeshStandardMaterial({ color: 0x101826, emissive: color, emissiveIntensity: 0.12, roughness: 0.7 })
    );
    pad.position.y = 0.02;
    group.add(pad);

    const hpBar = new HpBar(0.55);
    hpBar.sprite.position.y = GAME.MONOLITH_HEIGHT + 0.28;
    group.add(hpBar.sprite);

    const label = makeTextSprite(name ?? '', PLAYER_COLORS[colorIndex % PLAYER_COLORS.length]);
    label.position.y = GAME.MONOLITH_HEIGHT + 0.52;
    group.add(label);

    // Shield bubble (hidden unless active).
    const shield = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 24, 16),
      new THREE.MeshBasicMaterial({
        color: 0x22d3ee, transparent: true, opacity: 0.16,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    shield.position.y = GAME.MONOLITH_HEIGHT / 2;
    shield.scale.y = 1.15;
    shield.visible = false;
    group.add(shield);

    this.arena.add(group);
    m = { group, mesh, edges, glyphs, hpBar, shield, label, alive: true, colorIndex };
    this.monoliths.set(slot, m);
    return m;
  }

  removeMonolith(slot) {
    const m = this.monoliths.get(slot);
    if (!m) return;
    this.arena.remove(m.group);
    this.monoliths.delete(slot);
  }

  ensurePlayer(id, colorIndex, name) {
    let p = this.players.get(id);
    if (p) return p;
    const color = colorOf(colorIndex);
    const group = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.14, 0),
      new THREE.MeshStandardMaterial({
        color: 0x0b1020, emissive: color, emissiveIntensity: 1.0,
        roughness: 0.3, metalness: 0.3,
      })
    );
    group.add(body);

    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.2, 0.012, 8, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 })
    );
    halo.rotation.x = Math.PI / 2;
    group.add(halo);

    // Gaze indicator: small cone showing where they're looking.
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.045, 0.12, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -0.2;
    group.add(nose);

    const label = makeTextSprite(name ?? '?', PLAYER_COLORS[colorIndex % PLAYER_COLORS.length]);
    label.position.y = 0.32;
    group.add(label);

    group.visible = false;
    this.arena.add(group);
    p = {
      group, body, halo,
      target: { p: new THREE.Vector3(), q: new THREE.Quaternion() },
      seen: false,
      colorIndex,
    };
    this.players.set(id, p);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.arena.remove(p.group);
    this.players.delete(id);
  }

  spawnShotMesh(id, colorIndex) {
    const color = colorOf(colorIndex);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(GAME.SHOT_RADIUS, 12, 8),
      new THREE.MeshBasicMaterial({ color })
    );
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(GAME.SHOT_RADIUS * 2.2, 12, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false })
    );
    mesh.add(glow);
    this.arena.add(mesh);
    const shot = { mesh, target: new THREE.Vector3(), dir: new THREE.Vector3(), fresh: true };
    this.shots.set(id, shot);
    return shot;
  }

  // ---- particles ------------------------------------------------------------

  burst(pos, colorHex, count = 24, speed = 1.6, life = 0.7, size = 0.035) {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = [];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = pos[0];
      positions[i * 3 + 1] = pos[1];
      positions[i * 3 + 2] = pos[2];
      const v = new THREE.Vector3(
        Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5
      ).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      velocities.push(v);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: colorHex, size, transparent: true, opacity: 1, depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    this.arena.add(points);
    this.particles.push({ points, velocities, life, maxLife: life });
  }

  // ---- snapshot ingestion ----------------------------------------------------

  /**
   * roster: [{id, name, slot, color}] — identity info.
   * snap:   server snapshot — positions & stats.
   */
  applyRoster(roster) {
    const ids = new Set(roster.map((r) => r.id));
    const slots = new Set(roster.map((r) => r.slot));
    for (const id of [...this.players.keys()]) if (!ids.has(id)) this.removePlayer(id);
    for (const slot of [...this.monoliths.keys()]) if (!slots.has(slot)) this.removeMonolith(slot);
    for (const r of roster) {
      this.ensureMonolith(r.slot, r.color, r.name);
      if (r.id !== this.myId) this.ensurePlayer(r.id, r.color, r.name);
    }
    this.rosterCache = roster;
  }

  applySnapshot(snap) {
    const bySlot = new Map((this.rosterCache ?? []).map((r) => [r.id, r.slot]));

    for (const ps of snap.players) {
      const slot = bySlot.get(ps.id);
      if (slot !== undefined) {
        const m = this.monoliths.get(slot);
        if (m) {
          m.hpBar.set(ps.hp / GAME.MONOLITH_HP);
          m.shield.visible = Boolean(ps.sh) && ps.hp > 0;
          const alive = ps.hp > 0 || snap.phase !== PHASE.LIVE;
          if (m.alive && !alive) this.collapseMonolith(m);
          if (!m.alive && alive) this.restoreMonolith(m);
        }
      }
      if (ps.id === this.myId) continue;
      const p = this.players.get(ps.id);
      if (!p) continue;
      p.target.p.fromArray(ps.p);
      p.target.q.fromArray(ps.q);
      if (!p.seen) {
        p.group.position.copy(p.target.p);
        p.group.quaternion.copy(p.target.q);
        p.seen = true;
        p.group.visible = true;
      }
    }

    // Wisps
    const wispIds = new Set();
    for (const ws of snap.wisps) {
      wispIds.add(ws.id);
      let w = this.wisps.get(ws.id);
      if (!w) {
        const mesh = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.07, 0),
          new THREE.MeshBasicMaterial({ color: 0x22d3ee })
        );
        const glow = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.13, 1),
          new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.2, depthWrite: false })
        );
        mesh.add(glow);
        mesh.position.fromArray(ws.p);
        this.arena.add(mesh);
        w = { mesh, target: new THREE.Vector3().fromArray(ws.p) };
        this.wisps.set(ws.id, w);
      }
      w.target.fromArray(ws.p);
    }
    for (const [id, w] of this.wisps) {
      if (!wispIds.has(id)) {
        this.arena.remove(w.mesh);
        this.wisps.delete(id);
      }
    }

    // Projectiles
    const shotIds = new Set();
    for (const ss of snap.shots) {
      shotIds.add(ss.id);
      let s = this.shots.get(ss.id);
      if (!s) {
        s = this.spawnShotMesh(ss.id, ss.c);
        s.mesh.position.fromArray(ss.p);
      }
      s.target.fromArray(ss.p);
      s.dir.fromArray(ss.d);
    }
    for (const [id, s] of this.shots) {
      if (!shotIds.has(id)) {
        this.arena.remove(s.mesh);
        this.shots.delete(id);
      }
    }

    // Practice totem
    if (snap.totem) {
      this.totem.group.visible = Boolean(snap.totem.up);
      this.totem.hpBar.set(snap.totem.hp / GAME.TOTEM_HP);
    } else {
      this.totem.group.visible = false;
    }
  }

  collapseMonolith(m) {
    m.alive = false;
    m.mesh.rotation.z = 0.5;
    m.mesh.position.y = GAME.MONOLITH_HEIGHT * 0.22;
    m.edges.rotation.z = 0.5;
    m.edges.position.y = m.mesh.position.y;
    m.mesh.material.emissiveIntensity = 0.04;
    m.glyphs.visible = false;
  }

  restoreMonolith(m) {
    m.alive = true;
    m.mesh.rotation.z = 0;
    m.mesh.position.y = GAME.MONOLITH_HEIGHT / 2;
    m.edges.rotation.z = 0;
    m.edges.position.y = m.mesh.position.y;
    m.mesh.material.emissiveIntensity = 0.25;
    m.glyphs.visible = true;
  }

  // ---- per-frame update -------------------------------------------------------

  update(dt) {
    this.time += dt;
    const t = this.time;

    this.runeRing.rotation.y = t * 0.15;

    for (const p of this.players.values()) {
      if (!p.seen) continue;
      const k = 1 - Math.exp(-LERP_POS * dt);
      p.group.position.lerp(p.target.p, k);
      p.group.quaternion.slerp(p.target.q, k);
      p.body.rotation.y = t * 1.5;
    }

    for (const w of this.wisps.values()) {
      w.mesh.position.lerp(w.target, 1 - Math.exp(-8 * dt));
      const s = 1 + Math.sin(t * 5 + w.mesh.id) * 0.15;
      w.mesh.scale.setScalar(s);
      w.mesh.rotation.y = t * 2;
    }

    for (const s of this.shots.values()) {
      // Dead-reckon along velocity, gently corrected toward server position.
      s.mesh.position.addScaledVector(s.dir, GAME.SHOT_SPEED * dt);
      s.mesh.position.lerp(s.target, 1 - Math.exp(-6 * dt));
    }

    for (const m of this.monoliths.values()) {
      if (!m.alive) continue;
      let i = 0;
      for (const shard of m.glyphs.children) {
        const a = shard.userData.angle + t * 0.9;
        shard.position.set(Math.cos(a) * 0.38, Math.sin(t * 2 + i) * 0.06, Math.sin(a) * 0.38);
        shard.rotation.x = t * 2 + i;
        shard.rotation.y = t * 1.4;
        i++;
      }
      if (m.shield.visible) {
        m.shield.material.opacity = 0.12 + Math.sin(t * 6) * 0.05;
      }
    }

    if (this.totem.group.visible) {
      this.totem.crystal.rotation.y = t * 1.2;
      this.totem.crystal.position.y = 0.85 + Math.sin(t * 2) * 0.05;
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const ptc = this.particles[i];
      ptc.life -= dt;
      if (ptc.life <= 0) {
        this.arena.remove(ptc.points);
        ptc.points.geometry.dispose();
        ptc.points.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      const arr = ptc.points.geometry.attributes.position.array;
      for (let j = 0; j < ptc.velocities.length; j++) {
        const v = ptc.velocities[j];
        v.y -= 1.5 * dt; // light gravity
        arr[j * 3] += v.x * dt;
        arr[j * 3 + 1] += v.y * dt;
        arr[j * 3 + 2] += v.z * dt;
      }
      ptc.points.geometry.attributes.position.needsUpdate = true;
      ptc.points.material.opacity = ptc.life / ptc.maxLife;
    }
  }

  /** Camera pose expressed in arena-local coordinates: what we report to the server. */
  getArenaLocalPose(xrCamera) {
    const cam = xrCamera ?? this.camera;
    cam.updateMatrixWorld();
    this.arena.updateMatrixWorld();
    const inv = new THREE.Matrix4().copy(this.arena.matrixWorld).invert();
    const local = new THREE.Matrix4().multiplyMatrices(inv, cam.matrixWorld);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    local.decompose(p, q, s);
    return { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] };
  }

  /** Forward ray of the camera in arena-local coordinates: shot origin + direction. */
  getArenaLocalRay(xrCamera) {
    const pose = this.getArenaLocalPose(xrCamera);
    const q = new THREE.Quaternion().fromArray(pose.q);
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    return { o: pose.p, d: [d.x, d.y, d.z] };
  }

  colorHexOf(index) {
    return colorOf(index).getHex();
  }

  reset() {
    for (const id of [...this.players.keys()]) this.removePlayer(id);
    for (const slot of [...this.monoliths.keys()]) this.removeMonolith(slot);
    for (const [, w] of this.wisps) this.arena.remove(w.mesh);
    this.wisps.clear();
    for (const [, s] of this.shots) this.arena.remove(s.mesh);
    this.shots.clear();
    for (const ptc of this.particles) this.arena.remove(ptc.points);
    this.particles = [];
    this.rosterCache = [];
    this.arena.visible = false;
    this.reticle.visible = false;
  }
}
