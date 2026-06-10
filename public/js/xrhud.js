import * as THREE from 'three';
import { GAME, PHASE } from '/shared/constants.js';

/**
 * In-world HUD for headset AR (Meta Quest etc.), where the DOM overlay HUD
 * isn't composited into the immersive view. A small status panel (energy +
 * monolith HP + phase) rides at the bottom of the player's view, and
 * transient messages appear at eye level. Both are children of the camera,
 * which three.js keeps synced to the headset pose.
 */
export class XrHud {
  constructor(camera) {
    this.group = new THREE.Group();
    this.group.visible = false;
    camera.add(this.group);

    // --- status panel ------------------------------------------------------
    this.panelCanvas = document.createElement('canvas');
    this.panelCanvas.width = 512;
    this.panelCanvas.height = 168;
    this.panelTex = new THREE.CanvasTexture(this.panelCanvas);
    this.panelTex.colorSpace = THREE.SRGBColorSpace;
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.30, 0.30 * 168 / 512),
      new THREE.MeshBasicMaterial({
        map: this.panelTex, transparent: true, depthTest: false, depthWrite: false,
      })
    );
    panel.position.set(0, -0.21, -0.55); // ~21° below the view centre
    panel.renderOrder = 999;
    this.group.add(panel);

    // --- centre message ----------------------------------------------------
    this.msgCanvas = document.createElement('canvas');
    this.msgCanvas.width = 1024;
    this.msgCanvas.height = 160;
    this.msgTex = new THREE.CanvasTexture(this.msgCanvas);
    this.msgTex.colorSpace = THREE.SRGBColorSpace;
    this.msgMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.55, 0.55 * 160 / 1024),
      new THREE.MeshBasicMaterial({
        map: this.msgTex, transparent: true, depthTest: false, depthWrite: false,
      })
    );
    this.msgMesh.position.set(0, 0.07, -0.8);
    this.msgMesh.renderOrder = 999;
    this.msgMesh.visible = false;
    this.group.add(this.msgMesh);

    this.msgTimer = null;
    this.state = { energy: -1, hp: -1, phaseText: '' };
    this.drawPanel();
  }

  enable() {
    this.group.visible = true;
    this.drawPanel();
  }

  disable() {
    this.group.visible = false;
    this.clearCenterMessage();
  }

  setBars(energy, hp) {
    energy = Math.round(energy);
    hp = Math.round(hp);
    if (energy === this.state.energy && hp === this.state.hp) return;
    this.state.energy = energy;
    this.state.hp = hp;
    if (this.group.visible) this.drawPanel();
  }

  setPhase(phase, t) {
    let text;
    switch (phase) {
      case PHASE.LOBBY: text = 'WAITING FOR RIVALS'; break;
      case PHASE.COUNTDOWN: text = `STARTS IN ${Math.ceil(t)}`; break;
      case PHASE.LIVE: {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60).toString().padStart(2, '0');
        text = `MATCH  ${m}:${s}`;
        break;
      }
      case PHASE.ENDED: text = 'MATCH OVER'; break;
      default: text = '';
    }
    if (text === this.state.phaseText) return;
    this.state.phaseText = text;
    if (this.group.visible) this.drawPanel();
  }

  drawPanel() {
    const ctx = this.panelCanvas.getContext('2d');
    const W = this.panelCanvas.width;
    const H = this.panelCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10, 14, 26, 0.78)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(94, 234, 212, 0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = 'bold 30px "Courier New", monospace';
    ctx.fillStyle = '#5eead4';
    ctx.textAlign = 'center';
    ctx.fillText(this.state.phaseText, W / 2, 44);

    const drawBar = (y, frac, color, label, value) => {
      ctx.font = 'bold 26px "Courier New", monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(label, 22, y + 24);
      ctx.fillStyle = 'rgba(2, 6, 18, 0.9)';
      ctx.beginPath();
      ctx.roundRect(64, y, W - 160, 30, 14);
      ctx.fill();
      if (frac > 0) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(68, y + 4, (W - 168) * Math.max(0, Math.min(1, frac)), 22, 10);
        ctx.fill();
      }
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'right';
      ctx.fillText(String(value), W - 22, y + 24);
    };

    const e = Math.max(0, this.state.energy);
    const hp = Math.max(0, this.state.hp);
    drawBar(66, e / GAME.ENERGY_MAX, '#22d3ee', '⚡', e);
    drawBar(112, hp / GAME.MONOLITH_HP, '#a3e635', '⬛', hp);
    this.panelTex.needsUpdate = true;
  }

  centerMessage(text, holdMs = 1600) {
    if (!this.group.visible) return;
    clearTimeout(this.msgTimer);
    const ctx = this.msgCanvas.getContext('2d');
    const W = this.msgCanvas.width;
    const H = this.msgCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const lines = String(text).split('\n');
    ctx.font = 'bold 52px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lineH = 64;
    const y0 = H / 2 - ((lines.length - 1) * lineH) / 2;
    for (let i = 0; i < lines.length; i++) {
      const y = y0 + i * lineH;
      ctx.strokeStyle = 'rgba(5, 6, 12, 0.9)';
      ctx.lineWidth = 8;
      ctx.strokeText(lines[i], W / 2, y);
      ctx.fillStyle = '#5eead4';
      ctx.fillText(lines[i], W / 2, y);
    }
    this.msgTex.needsUpdate = true;
    this.msgMesh.visible = true;
    if (holdMs > 0) {
      this.msgTimer = setTimeout(() => { this.msgMesh.visible = false; }, holdMs);
    }
  }

  clearCenterMessage() {
    clearTimeout(this.msgTimer);
    this.msgMesh.visible = false;
  }
}
