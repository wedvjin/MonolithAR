/**
 * All sound is synthesized with WebAudio — no audio assets.
 */
class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
  }

  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  tone({ freq = 440, end = freq, dur = 0.15, type = 'sine', gain = 0.3, when = 0 }) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, end), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  noise({ dur = 0.3, gain = 0.25, freq = 800, when = 0 }) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq * 3, t0);
    filter.frequency.exponentialRampToValueAtTime(freq * 0.4, t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t0);
  }

  shoot() {
    this.tone({ freq: 880, end: 160, dur: 0.18, type: 'sawtooth', gain: 0.18 });
    this.tone({ freq: 1760, end: 320, dur: 0.1, type: 'square', gain: 0.06 });
  }

  hit() {
    this.noise({ dur: 0.18, gain: 0.3, freq: 600 });
    this.tone({ freq: 200, end: 60, dur: 0.2, type: 'triangle', gain: 0.25 });
  }

  blocked() {
    this.tone({ freq: 520, end: 520, dur: 0.12, type: 'square', gain: 0.12 });
    this.tone({ freq: 780, end: 780, dur: 0.1, type: 'square', gain: 0.08, when: 0.03 });
  }

  collect() {
    this.tone({ freq: 660, end: 1320, dur: 0.12, type: 'sine', gain: 0.2 });
    this.tone({ freq: 990, end: 1980, dur: 0.14, type: 'sine', gain: 0.12, when: 0.06 });
  }

  drained() {
    this.tone({ freq: 600, end: 150, dur: 0.3, type: 'sawtooth', gain: 0.15 });
  }

  explode() {
    this.noise({ dur: 0.7, gain: 0.45, freq: 400 });
    this.tone({ freq: 110, end: 35, dur: 0.7, type: 'triangle', gain: 0.35 });
  }

  countdown(n) {
    this.tone({ freq: n === 1 ? 880 : 440, dur: 0.12, type: 'square', gain: 0.15 });
  }

  matchStart() {
    [523, 659, 784, 1047].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.18, type: 'square', gain: 0.13, when: i * 0.1 }));
  }

  victory() {
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.25, type: 'triangle', gain: 0.2, when: i * 0.15 }));
  }

  defeat() {
    [392, 330, 262, 196].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.3, type: 'triangle', gain: 0.18, when: i * 0.2 }));
  }

  place() {
    this.tone({ freq: 220, end: 440, dur: 0.25, type: 'sine', gain: 0.25 });
    this.noise({ dur: 0.3, gain: 0.1, freq: 300, when: 0.05 });
  }
}

export const sfx = new Sfx();
