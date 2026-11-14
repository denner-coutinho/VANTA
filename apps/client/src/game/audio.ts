import type { WeaponCategory } from "@vanta/shared";

/**
 * Áudio de combate sintetizado (Web Audio): disparos por categoria, recarga, impactos,
 * passos e alertas. Tudo original e gerado em tempo real; posicional (panner HRTF) para
 * sons do mundo, como o drone e os impactos.
 */
export class GameAudio {
  readonly ctx: AudioContext;
  private master: GainNode;
  private noise: AudioBuffer;

  constructor(volume = 0.6) {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 1, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  setVolume(v: number) {
    this.master.gain.value = v;
  }
  resume() {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Posição do ouvinte (câmera). */
  setListener(x: number, y: number, z: number, fx: number, fy: number, fz: number) {
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(x, t);
      l.positionY.setValueAtTime(y, t);
      l.positionZ.setValueAtTime(z, t);
      l.forwardX.setValueAtTime(fx, t);
      l.forwardY.setValueAtTime(fy, t);
      l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    }
  }

  private out(pos?: { x: number; y: number; z: number }): AudioNode {
    if (!pos) return this.master;
    const p = this.ctx.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = 2;
    p.rolloffFactor = 1.2;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    p.connect(this.master);
    return p;
  }

  private burst(opts: { dur: number; gain: number; filter: BiquadFilterType; freq: number; freqEnd?: number; q?: number; pos?: { x: number; y: number; z: number }; delay?: number }) {
    const t = this.ctx.currentTime + (opts.delay ?? 0);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter();
    f.type = opts.filter;
    f.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd) f.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + opts.dur);
    f.Q.value = opts.q ?? 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(opts.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    src.connect(f).connect(g).connect(this.out(opts.pos));
    src.start(t, Math.random() * 0.5, opts.dur + 0.05);
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, freqEnd?: number, delay = 0, pos?: { x: number; y: number; z: number }) {
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out(pos));
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  shot(category: WeaponCategory, pos?: { x: number; y: number; z: number }) {
    const p = {
      ASSAULT_RIFLE: { body: 1400, dur: 0.16, thump: 90, gain: 0.9 },
      SMG: { body: 2200, dur: 0.1, thump: 120, gain: 0.7 },
      SNIPER: { body: 900, dur: 0.6, thump: 55, gain: 1.2 },
      SHOTGUN: { body: 700, dur: 0.38, thump: 60, gain: 1.1 },
      PISTOL: { body: 1800, dur: 0.12, thump: 110, gain: 0.75 },
    }[category];
    this.burst({ dur: p.dur, gain: p.gain, filter: "lowpass", freq: p.body * 3, freqEnd: p.body * 0.4, pos });
    this.burst({ dur: 0.03, gain: p.gain * 0.8, filter: "highpass", freq: 3000, pos });
    this.tone(p.thump * 2, p.dur * 0.8, "sine", p.gain * 0.7, p.thump * 0.6, 0, pos);
    // Cauda/eco urbano.
    this.burst({ dur: p.dur * 2.5, gain: p.gain * 0.12, filter: "bandpass", freq: 600, q: 0.6, delay: 0.06, pos });
  }

  dryFire() {
    this.tone(2400, 0.03, "square", 0.08);
  }
  reload(totalMs: number) {
    const s = totalMs / 1000;
    this.tone(900, 0.05, "square", 0.12, 600, 0.05);
    this.burst({ dur: 0.08, gain: 0.25, filter: "bandpass", freq: 2500, q: 2, delay: s * 0.35 });
    this.tone(1200, 0.04, "square", 0.15, 700, s * 0.7);
    this.burst({ dur: 0.05, gain: 0.3, filter: "highpass", freq: 3500, delay: s * 0.9 });
  }
  switchWeapon() {
    this.burst({ dur: 0.12, gain: 0.18, filter: "bandpass", freq: 1800, q: 1.5 });
  }
  hit(headshot: boolean) {
    if (headshot) {
      this.tone(2600, 0.12, "triangle", 0.35, 3200);
      this.tone(1300, 0.1, "sine", 0.2);
    } else this.tone(1700, 0.05, "square", 0.12);
  }
  kill() {
    this.tone(880, 0.09, "triangle", 0.3);
    this.tone(1320, 0.18, "triangle", 0.3, undefined, 0.08);
  }
  impact(pos: { x: number; y: number; z: number }) {
    this.burst({ dur: 0.06, gain: 0.25, filter: "bandpass", freq: 3000 + Math.random() * 2000, q: 3, pos });
  }
  footstep(sprinting: boolean) {
    this.burst({ dur: 0.07, gain: sprinting ? 0.18 : 0.1, filter: "lowpass", freq: 500, freqEnd: 150 });
  }
  land() {
    this.burst({ dur: 0.12, gain: 0.3, filter: "lowpass", freq: 400, freqEnd: 90 });
  }
  hurt() {
    this.tone(180, 0.2, "sawtooth", 0.25, 90);
    this.burst({ dur: 0.15, gain: 0.3, filter: "lowpass", freq: 900 });
  }
  droneShot(pos: { x: number; y: number; z: number }) {
    this.tone(1500, 0.12, "sawtooth", 0.35, 400, 0, pos);
    this.burst({ dur: 0.08, gain: 0.4, filter: "bandpass", freq: 1800, q: 2, pos });
  }
  droneDown(pos: { x: number; y: number; z: number }) {
    this.tone(600, 0.6, "sawtooth", 0.4, 60, 0, pos);
    this.burst({ dur: 0.5, gain: 0.6, filter: "lowpass", freq: 1500, freqEnd: 100, pos });
  }
  death() {
    this.tone(220, 0.9, "sine", 0.4, 55);
  }
  dispose() {
    void this.ctx.close();
  }
}
