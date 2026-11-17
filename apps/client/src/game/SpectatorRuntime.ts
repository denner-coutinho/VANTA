import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import {
  ANIM_FLAG,
  CollisionWorld,
  INTERP_DELAY_TICKS,
  TICK_MS,
  clamp,
  raycastWorld,
  viewDir,
  type MapDefinition,
  type MatchEventWire,
  type MatchPhase,
  type PlayerMatchStats,
  type ServerMessage,
  type SpecFrame,
  type SpectatorInfo,
  type WeaponStats,
  type WireSpec,
} from "@vanta/shared";
import { GameAudio } from "./audio";
import { buildMap, type BuiltMap } from "./mapBuilder";
import { Effects } from "./effects";
import { CharacterRig } from "../three/characters";
import type { GameSettings, Quality } from "./GameRuntime";
import { TEAM_COLORS } from "./OnlineRuntime";

export interface SpecPlayerRow {
  id: string;
  username: string;
  team: 0 | 1;
  kills: number;
  deaths: number;
  assists: number;
  alive: boolean;
  hp: number;
  connected: boolean;
}

export interface SpectatorHud {
  phase: MatchPhase;
  phaseEndsIn: number;
  round: number;
  score: [number, number];
  roundsToWin: number;
  players: SpecPlayerRow[];
  /** Jogador acompanhado (null = câmera livre). */
  target: string | null;
  fps: number;
  /** Já recebeu algum quadro (o atraso faz os primeiros segundos ficarem vazios). */
  started: boolean;
}

export type SpectatorEvent =
  | { type: "killfeed"; killer: string; victim: string; weapon: string; headshot: boolean; killerTeam: 0 | 1; victimTeam: 0 | 1 }
  | { type: "round_end"; winner: 0 | 1 | null; score: [number, number] }
  | { type: "match_end"; winner: 0 | 1 | null; score: [number, number]; stats: PlayerMatchStats[] };

const QUALITY: Record<Quality, { pixelRatio: number; bloom: boolean; shadows: boolean }> = {
  low: { pixelRatio: 0.75, bloom: false, shadows: false },
  medium: { pixelRatio: 1, bloom: true, shadows: false },
  high: { pixelRatio: 1.25, bloom: true, shadows: true },
  ultra: { pixelRatio: 2, bloom: true, shadows: true },
};

interface Actor {
  info: SpectatorInfo["players"][number];
  avatar: CharacterRig;
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  alive: boolean;
  hp: number;
  connected: boolean;
}

/**
 * Modo espectador: desenha todos os jogadores a partir dos quadros atrasados do servidor.
 * Não simula nada: só interpola o que o servidor mandou. Câmera em terceira pessoa atrás
 * de um jogador (Q/E troca) ou livre (WASD + arrastar o mouse; espaço/ctrl sobem e descem).
 * Feito para ser reaproveitado pelo replay e pela kill cam (mesmo formato de quadro).
 */
export class SpectatorRuntime {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private map: BuiltMap;
  private world: CollisionWorld;
  private audio: GameAudio;
  private fx: Effects;
  private actors = new Map<string, Actor>();
  private order: string[];
  private frames: SpecFrame[] = [];
  private last: SpecFrame | null = null;
  private tickOffset: number | null = null;
  private kd = new Map<string, [number, number, number]>();
  private target: string | null;
  private free = { pos: new THREE.Vector3(0, 12, 0), yaw: 0, pitch: -0.5 };
  private keys = new Set<string>();
  private drag: { x: number; y: number } | null = null;
  private raf = 0;
  private lastFrame = performance.now();
  private hudTimer = 0;
  private fpsFrames = 0;
  private fpsT = 0;
  private fps = 0;
  private disposed = false;
  /** Modo replay: todos os quadros já carregados e um relógio próprio (play, pausa, velocidade, busca). */
  private playback: { tick: number; speed: number; playing: boolean } | null = null;

  constructor(
    private container: HTMLElement,
    mapDef: MapDefinition,
    private info: SpectatorInfo,
    settings: GameSettings,
    private onHud: (h: SpectatorHud) => void,
    private onEvent: (e: SpectatorEvent) => void,
  ) {
    const q = QUALITY[settings.quality];
    this.renderer = new THREE.WebGLRenderer({ antialias: settings.quality !== "low", powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.shadowMap.enabled = q.shadows;
    container.appendChild(this.renderer.domElement);

    const atm = mapDef.atmosphere;
    this.scene.background = new THREE.Color(atm.sky);
    this.scene.fog = new THREE.FogExp2(atm.fog, atm.fogDensity);
    this.scene.add(new THREE.HemisphereLight(atm.ambient, "#2a3048", 2.6));
    const sun = atm.sun;
    const light = new THREE.DirectionalLight(sun?.color ?? 0xb8c8ff, sun ? sun.intensity : atm.theme === "lab" ? 0.25 : 1.8);
    if (sun) light.position.set(sun.dir.x * 50, sun.dir.y * 50, sun.dir.z * 50);
    else light.position.set(-20, 40, -10);
    light.castShadow = q.shadows;
    light.shadow.mapSize.set(2048, 2048);
    Object.assign(light.shadow.camera, { left: -36, bottom: -36, right: 36, top: 36, far: 120 });
    this.scene.add(light);

    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 300);
    this.camera.rotation.order = "YXZ";
    this.map = buildMap(mapDef, { shadows: q.shadows });
    this.scene.add(this.map.group);
    this.world = new CollisionWorld(mapDef.solids.map((s) => s.box));
    this.fx = new Effects();
    this.scene.add(this.fx.group);

    for (const p of info.players) {
      // Espectador vê o nome de todos, nas cores do time.
      const avatar = new CharacterRig(p.character, { accent: p.color, team: TEAM_COLORS[p.team], name: p.username, detail: "low", skin: p.cosmetics?.character ?? null });
      this.scene.add(avatar.root);
      this.actors.set(p.id, { info: p, avatar, pos: new THREE.Vector3(0, -100, 0), yaw: 0, pitch: 0, alive: true, hp: 100, connected: p.connected });
    }
    this.order = [...info.players].sort((a, b) => a.team - b.team || a.username.localeCompare(b.username)).map((p) => p.id);
    this.target = this.order[0] ?? null;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (q.bloom) this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.5, 0.55));
    this.composer.addPass(new OutputPass());

    this.audio = new GameAudio(settings.volume * 0.7);
    this.audio.startAmbience(mapDef.atmosphere.theme);

    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKeyUp);
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    this.resize();
    this.loop();
  }

  /** Primeiro gesto do usuário libera o áudio (política dos navegadores). */
  resumeAudio() {
    this.audio.resume();
  }

  follow(id: string | null) {
    if (id && !this.actors.has(id)) return;
    if (!id && this.target) {
      // Câmera livre começa onde a câmera de perseguição estava.
      this.free.pos.copy(this.camera.position);
      this.free.yaw = this.camera.rotation.y;
      this.free.pitch = this.camera.rotation.x;
    }
    this.target = id;
  }

  cycle(dir: 1 | -1) {
    const alive = this.order.filter((id) => this.actors.get(id)!.alive);
    const list = alive.length ? alive : this.order;
    if (!list.length) return;
    const i = this.target ? list.indexOf(this.target) : -1;
    this.target = list[(i + dir + list.length) % list.length]!;
  }

  // ───────────── Replay ─────────────

  /** Carrega um replay inteiro: a partir daqui o relógio é o do replay, não o do servidor. */
  loadReplay(frames: SpecFrame[]) {
    this.frames = frames;
    this.playback = { tick: frames[0]?.tick ?? 0, speed: 1, playing: true };
    this.tickOffset = 0;
    this.applyStateAt(this.playback.tick);
  }

  setPlaying(playing: boolean) {
    if (!this.playback) return;
    if (playing && this.playback.tick >= this.endTick) this.seek(this.startTick);
    this.playback.playing = playing;
    if (playing) this.resumeAudio();
  }

  setSpeed(speed: number) {
    if (this.playback) this.playback.speed = clamp(speed, 0.25, 8);
  }

  /** Pula para um instante (sem disparar os eventos do meio: o placar e o K/D vêm do quadro). */
  seek(tick: number) {
    if (!this.playback) return;
    this.playback.tick = clamp(tick, this.startTick, this.endTick);
    this.applyStateAt(this.playback.tick);
  }

  get startTick() {
    return this.frames[0]?.tick ?? 0;
  }
  get endTick() {
    return this.frames[this.frames.length - 1]?.tick ?? 0;
  }

  playbackState() {
    const p = this.playback;
    return p ? { tick: p.tick, playing: p.playing, speed: p.speed, start: this.startTick, end: this.endTick } : null;
  }

  /** Início de cada round (marcadores na linha do tempo). */
  roundMarks(): Array<{ round: number; tick: number }> {
    const out: Array<{ round: number; tick: number }> = [];
    for (const f of this.frames) if (f.phase !== "warmup" && out[out.length - 1]?.round !== f.round) out.push({ round: f.round, tick: f.tick });
    return out;
  }

  /** Índice do último quadro com tick ≤ t (busca binária: replays têm milhares de quadros). */
  private frameIndexAt(t: number) {
    let lo = 0;
    let hi = this.frames.length - 1;
    if (hi < 0 || this.frames[0]!.tick > t) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.frames[mid]!.tick <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private applyStateAt(t: number) {
    const i = Math.max(0, this.frameIndexAt(t));
    const f = this.frames[i];
    if (!f) return;
    this.last = f;
    this.kd.clear();
    for (const [id, k, d, a] of f.kd) this.kd.set(id, [k, d, a]);
  }

  private advancePlayback(dt: number) {
    const p = this.playback!;
    if (!p.playing) return;
    const from = p.tick;
    p.tick = Math.min(this.endTick, p.tick + (dt * 1000 * p.speed) / TICK_MS);
    // Eventos dos quadros que passaram (tiros, abates, fim de round), como se fosse ao vivo.
    let i = this.frameIndexAt(from) + 1;
    for (; i < this.frames.length && this.frames[i]!.tick <= p.tick; i++) {
      const f = this.frames[i]!;
      this.last = f;
      for (const [id, k, d, a] of f.kd) this.kd.set(id, [k, d, a]);
      for (const ev of f.ev) this.onMatchEvent(ev);
    }
    if (p.tick >= this.endTick) p.playing = false;
  }

  handleMessage(m: ServerMessage) {
    if (m.t !== "spec" || this.playback) return;
    const now = performance.now();
    const sample = m.tick - now / TICK_MS;
    if (this.tickOffset === null || Math.abs(sample - this.tickOffset) > 30) this.tickOffset = sample;
    else this.tickOffset += (sample - this.tickOffset) * (sample > this.tickOffset ? 0.5 : 0.05);
    this.last = m;
    this.frames.push(m);
    if (this.frames.length > 40) this.frames.shift();
    for (const [id, k, d, a] of m.kd) this.kd.set(id, [k, d, a]);
    for (const ev of m.ev) this.onMatchEvent(ev);
  }

  private name(id: string) {
    return this.actors.get(id)?.info.username ?? "?";
  }

  private onMatchEvent(ev: MatchEventWire) {
    switch (ev.k) {
      case "shot": {
        const a = this.actors.get(ev.by);
        a?.avatar.shoot();
        this.audio.shot(ev.cat as WeaponStats["category"], ev.from, ev.w);
        const from = a ? { x: a.pos.x, y: a.pos.y + 1.4, z: a.pos.z } : ev.from;
        for (const end of ev.ends.slice(0, 3)) {
          this.fx.tracer(from, end, a ? a.info.team === 1 : true);
          this.fx.impact(end, { x: from.x - end.x, y: from.y - end.y, z: from.z - end.z }, false);
        }
        break;
      }
      case "kill": {
        const kt = this.actors.get(ev.killer)?.info.team ?? 0;
        const vt = this.actors.get(ev.victim)?.info.team ?? 1;
        this.onEvent({ type: "killfeed", killer: this.name(ev.killer), victim: this.name(ev.victim), weapon: ev.weapon, headshot: ev.head, killerTeam: kt, victimTeam: vt });
        break;
      }
      case "round_end":
        this.onEvent({ type: "round_end", winner: ev.winner, score: ev.score });
        break;
      case "match_end":
        this.onEvent({ type: "match_end", winner: ev.winner, score: ev.score, stats: ev.stats });
        break;
      case "player": {
        const a = this.actors.get(ev.id);
        if (a) a.connected = ev.connected;
        break;
      }
      default:
        break;
    }
  }

  // ───────────── Entrada (câmera livre) ─────────────

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    this.keys.add(e.code);
    if (e.code === "KeyQ") this.cycle(-1);
    else if (e.code === "KeyE") this.cycle(1);
    else if (e.code === "KeyF") this.follow(this.target ? null : (this.order[0] ?? null));
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onDown = (e: PointerEvent) => {
    this.drag = { x: e.clientX, y: e.clientY };
    this.resumeAudio();
  };
  private onMove = (e: PointerEvent) => {
    if (!this.drag || this.target) return;
    this.free.yaw -= (e.clientX - this.drag.x) * 0.004;
    this.free.pitch = clamp(this.free.pitch - (e.clientY - this.drag.y) * 0.004, -1.5, 1.5);
    this.drag = { x: e.clientX, y: e.clientY };
  };
  private onUp = () => {
    this.drag = null;
  };

  // ───────────── Loop ─────────────

  private resize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.fpsFrames++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsT);
      this.fpsFrames = 0;
      this.fpsT = 0;
    }
    if (this.playback) this.advancePlayback(dt);
    this.interpolate(dt);
    this.updateCamera(dt);
    this.fx.update(dt);
    this.map.update(dt);
    this.composer.render();

    this.hudTimer += dt;
    if (this.hudTimer > 1 / 15) {
      this.hudTimer = 0;
      const s = this.last;
      const est = this.playback ? this.playback.tick : this.tickOffset === null ? 0 : performance.now() / TICK_MS + this.tickOffset;
      this.onHud({
        phase: s?.phase ?? "warmup",
        phaseEndsIn: s ? Math.max(0, s.phaseEndsIn - (est - s.tick) * TICK_MS) : 0,
        round: s?.round ?? 0,
        score: s?.score ?? [0, 0],
        roundsToWin: this.info.roundsToWin,
        players: this.order.map((id) => {
          const a = this.actors.get(id)!;
          const kd = this.kd.get(id) ?? [0, 0, 0];
          return { id, username: a.info.username, team: a.info.team, kills: kd[0], deaths: kd[1], assists: kd[2], alive: a.alive, hp: a.hp, connected: a.connected };
        }),
        target: this.target,
        fps: this.fps,
        started: !!s,
      });
    }
  };

  private interpolate(dt: number) {
    if (this.tickOffset === null) return;
    const rt = this.playback ? this.playback.tick : performance.now() / TICK_MS + this.tickOffset - INTERP_DELAY_TICKS;
    const idx = this.frameIndexAt(rt);
    let a: SpecFrame | undefined = idx >= 0 ? this.frames[idx] : undefined;
    let b: SpecFrame | undefined = idx >= 0 ? this.frames[idx + 1] : undefined;
    a ??= this.frames[0];
    if (!a) return;
    const t = b ? clamp((rt - a.tick) / (b.tick - a.tick), 0, 1) : 0;
    const byB = new Map<string, WireSpec>((b ?? a).players.map((p) => [p[0], p]));
    for (const pa of a.players) {
      const act = this.actors.get(pa[0]);
      if (!act) continue;
      const pb = byB.get(pa[0]) ?? pa;
      const k = Math.hypot(pb[1] - pa[1], pb[3] - pa[3]) > 3 ? 1 : t;
      act.pos.set(pa[1] + (pb[1] - pa[1]) * k, pa[2] + (pb[2] - pa[2]) * k, pa[3] + (pb[3] - pa[3]) * k);
      const dyaw = Math.atan2(Math.sin(pb[4] - pa[4]), Math.cos(pb[4] - pa[4]));
      act.yaw = pa[4] + dyaw * k;
      act.pitch = pa[5] + (pb[5] - pa[5]) * k;
      const cur = k < 0.5 ? pa : pb;
      act.alive = cur[7] === 1;
      act.hp = cur[9];
      const flags = cur[10];
      act.avatar.updateAt(dt, act.pos, act.yaw, {
        pitch: act.pitch,
        crouch: pa[6] + (pb[6] - pa[6]) * k,
        alive: act.alive,
        onGround: (flags & ANIM_FLAG.onGround) !== 0,
        sprinting: (flags & ANIM_FLAG.sprinting) !== 0,
        reloading: (flags & ANIM_FLAG.reloading) !== 0,
      });
      act.avatar.root.visible = act.connected || act.alive;
    }
  }

  private updateCamera(dt: number) {
    const target = this.target ? this.actors.get(this.target) : null;
    if (target && target.pos.y > -50) {
      // Terceira pessoa: atrás e acima do ombro, sem atravessar paredes.
      const eye = { x: target.pos.x, y: target.pos.y + 1.55, z: target.pos.z };
      const back = viewDir(target.yaw, target.pitch * 0.6);
      const dir = { x: -back.x, y: -back.y + 0.25, z: -back.z };
      const len = Math.hypot(dir.x, dir.y, dir.z);
      const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
      const hit = raycastWorld(this.world, eye, d, 3.2);
      const dist = hit ? Math.max(0.4, hit.t - 0.2) : 3.2;
      const want = new THREE.Vector3(eye.x + d.x * dist, eye.y + d.y * dist, eye.z + d.z * dist);
      this.camera.position.lerp(want, Math.min(1, dt * 12));
      this.camera.lookAt(eye.x + back.x * 6, eye.y + back.y * 6, eye.z + back.z * 6);
    } else {
      const speed = (this.keys.has("ShiftLeft") ? 22 : 10) * dt;
      const f = viewDir(this.free.yaw, 0);
      const r = { x: -f.z, z: f.x };
      const fw = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
      const rt = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
      const up = (this.keys.has("Space") ? 1 : 0) - (this.keys.has("ControlLeft") ? 1 : 0);
      this.free.pos.x += (f.x * fw + r.x * rt) * speed;
      this.free.pos.z += (f.z * fw + r.z * rt) * speed;
      this.free.pos.y = clamp(this.free.pos.y + up * speed, 0.5, 60);
      this.camera.position.copy(this.free.pos);
      this.camera.rotation.set(this.free.pitch, this.free.yaw, 0);
    }
    const look = new THREE.Vector3();
    this.camera.getWorldDirection(look);
    this.audio.setListener(this.camera.position.x, this.camera.position.y, this.camera.position.z, look.x, look.y, look.z);
  }

  debugState() {
    return {
      target: this.target,
      frames: this.frames.length,
      lastTick: this.last?.tick ?? null,
      players: [...this.actors.entries()].map(([id, a]) => ({ id, username: a.info.username, team: a.info.team, alive: a.alive, hp: a.hp, pos: { x: a.pos.x, y: a.pos.y, z: a.pos.z } })),
    };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.audio.dispose();
    this.fx.dispose();
    for (const a of this.actors.values()) a.avatar.dispose();
    this.map.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
