/**
 * Sons de interface sintetizados em tempo real com Web Audio (assets 100% originais, zero download).
 * Respeita o volume salvo nas configurações locais.
 */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function volume(): number {
  try {
    const v = Number(localStorage.getItem("vanta.uiVolume") ?? "0.5");
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
  } catch {
    return 0.5;
  }
}

function blip(freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number) {
  const a = audio();
  if (!a) return;
  const v = volume() * gain;
  if (v <= 0) return;
  const osc = a.createOscillator();
  const g = a.createGain();
  const t = a.currentTime;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const uiSound = {
  hover: () => blip(1850, 0.045, "sine", 0.05),
  click: () => {
    blip(620, 0.07, "square", 0.05, 980);
    setTimeout(() => blip(1400, 0.05, "sine", 0.04), 35);
  },
  error: () => blip(220, 0.18, "sawtooth", 0.05, 140),
  success: () => {
    blip(660, 0.08, "triangle", 0.07);
    setTimeout(() => blip(990, 0.12, "triangle", 0.07), 80);
  },
  boot: () => {
    blip(90, 0.9, "sawtooth", 0.05, 45);
    setTimeout(() => blip(1320, 0.4, "sine", 0.04, 2640), 200);
  },
};
