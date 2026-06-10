import { PHASE, PLAYER_COLORS } from '/shared/constants.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'),
      phase: $('phase-banner'),
      room: $('room-chip'),
      scoreboard: $('scoreboard'),
      killfeed: $('killfeed'),
      centerMsg: $('center-msg'),
      reticle: $('reticle-2d'),
      vignette: $('hit-vignette'),
      energyFill: $('energy-fill'),
      energyNum: $('energy-num'),
      hpFill: $('hp-fill'),
      hpNum: $('hp-num'),
      touch: $('touch-controls'),
      keyHints: $('key-hints'),
      end: $('endscreen'),
      endTitle: $('end-title'),
      endDetail: $('end-detail'),
    };
    this.centerTimer = null;
  }

  show() { this.el.hud.classList.remove('hidden'); }
  hide() {
    this.el.hud.classList.add('hidden');
    this.el.end.classList.add('hidden');
    this.el.killfeed.innerHTML = '';
  }

  setRoom(code) { this.el.room.textContent = `ROOM ${code}`; }

  setPhase(phase, t) {
    const e = this.el.phase;
    switch (phase) {
      case PHASE.LOBBY:
        e.textContent = 'WAITING FOR RIVALS — PRACTICE ON THE TOTEM';
        break;
      case PHASE.COUNTDOWN:
        e.textContent = `MATCH STARTS IN ${Math.ceil(t)}`;
        break;
      case PHASE.LIVE: {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60).toString().padStart(2, '0');
        e.textContent = `⚔ ${m}:${s}`;
        break;
      }
      case PHASE.ENDED:
        e.textContent = 'MATCH OVER';
        break;
      default:
        e.textContent = '';
    }
  }

  setBars(energy, energyMax, hp, hpMax) {
    this.el.energyFill.style.width = `${(energy / energyMax) * 100}%`;
    this.el.energyNum.textContent = Math.round(energy);
    this.el.hpFill.style.width = `${(hp / hpMax) * 100}%`;
    this.el.hpNum.textContent = Math.round(hp);
  }

  setScoreboard(roster, statsById, myId) {
    const rows = roster
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map((r) => {
        const st = statsById.get(r.id) ?? { hp: 0, alive: true };
        const color = PLAYER_COLORS[r.color % PLAYER_COLORS.length];
        const dead = st.hp <= 0 && st.live;
        const you = r.id === myId ? ' ◂' : '';
        return `<div class="score-row${dead ? ' dead' : ''}">
          <span class="score-dot" style="background:${color};box-shadow:0 0 6px ${color}"></span>
          <span class="score-name">${escapeHtml(r.name)}${you}</span>
          <span class="mini-bar"><span class="mini-fill" style="width:${st.hp}%;display:block"></span></span>
          <span class="score-wins">★${r.score ?? 0}</span>
        </div>`;
      });
    this.el.scoreboard.innerHTML = rows.join('');
  }

  feed(text) {
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.textContent = text;
    this.el.killfeed.appendChild(item);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.firstChild.remove();
    setTimeout(() => item.classList.add('fading'), 3500);
    setTimeout(() => item.remove(), 4400);
  }

  centerMessage(text, holdMs = 1600) {
    clearTimeout(this.centerTimer);
    this.el.centerMsg.textContent = text;
    this.el.centerMsg.classList.remove('hidden');
    if (holdMs > 0) {
      this.centerTimer = setTimeout(() => this.el.centerMsg.classList.add('hidden'), holdMs);
    }
  }

  clearCenterMessage() {
    clearTimeout(this.centerTimer);
    this.el.centerMsg.classList.add('hidden');
  }

  damageFlash() {
    this.el.vignette.classList.add('flash');
    requestAnimationFrame(() =>
      requestAnimationFrame(() => this.el.vignette.classList.remove('flash')));
  }

  showEnd(won, lines) {
    this.el.endTitle.textContent = won === null ? 'DRAW' : won ? '☼ VICTORY ☼' : 'DEFEAT';
    this.el.endTitle.style.color = won === false ? 'var(--danger)' : 'var(--accent)';
    this.el.endDetail.innerHTML = lines.map(escapeHtml).join('<br>');
    this.el.end.classList.remove('hidden');
  }

  hideEnd() { this.el.end.classList.add('hidden'); }

  configureFor(mode) {
    this.el.reticle.classList.toggle('hidden', mode === 'ar-placing');
    this.el.keyHints.classList.toggle('hidden', mode !== 'desktop');
    this.el.touch.classList.toggle('hidden', mode !== 'touch' && mode !== 'ar');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
