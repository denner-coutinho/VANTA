import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import {
  CATEGORY_TUNING,
  CollisionWorld,
  DEG,
  INTERP_DELAY_TICKS,
  MOVE,
  TICK_DT,
  TICK_MS,
  applyCommand,
  clamp,
  cloneCombatant,
  combatantEye,
  createCombatant,
  currentSpread,
  encodeCommand,
  eyeHeight,
  isReloading,
  raycastWorld,
  viewDir,
  type Combatant,
  type MapDefinition,
  type MatchEventWire,
  type MatchInfo,
  type MatchPhase,
  type PlayerCommand,
  type PlayerMatchStats,
  type ServerMessage,
  type Snapshot,
  type Vec3,
  type WeaponStats,
  type WireCommand,
  type WireOther,
  ANIM_FLAG,
} from "@vanta/shared";
import { InputManager } from "./input";
import { GameAudio } from "./audio";
import { buildMap, type BuiltMap } from "./mapBuilder";
import { ViewModel } from "./viewmodel";
import { Effects } from "./effects";
import { CharacterRig } from "../three/characters";
import type { GameSettings, Quality } from "./GameRuntime";

export const TEAM_COLORS = ["#287BFF", "#FF2E63"] as const;

export interface OnlinePlayerRow {
  id: string;
  username: string;
  team: 0 | 1;
  kills: number;
  deaths: number;
  assists: number;
  alive: boolean;
  connected: boolean;
  /** Vida (só aliados e você). */
  hp: number | null;
  you: boolean;
}

export interface OnlineHud {
  health: number;
  alive: boolean;
  weapon: { code: string; name: string; category: WeaponStats["category"]; ammo: number; magazine: number; reserve: number; reloadP: number | null };
  slots: Array<{ code: string; name: string; active: boolean }>;
  spreadPx: number;
  aiming: boolean;
  scoped: boolean;
  phase: MatchPhase;
  phaseEndsIn: number;
  round: number;
  score: [number, number];
  yourTeam: 0 | 1;
  roundsToWin: number;
  players: OnlinePlayerRow[];
  fps: number;
  rtt: number;
  connected: boolean;
}

export type OnlineEvent =
  | { type: "hit"; headshot: boolean; kill: boolean; damage: number }
  | { type: "damaged"; angle: number; amount: number }
  | { type: "killfeed"; killer: string; victim: string; weapon: string; headshot: boolean; killerTeam: 0 | 1; victimTeam: 0 | 1; involvesYou: boolean }
  | { type: "died"; by: string }
  | { type: "round_start"; round: number }
  | { type: "round_end"; round: number; winner: 0 | 1 | null; reason: string; score: [number, number] }
  | { type: "match_end"; winner: 0 | 1 | null; score: [number, number]; reason: string; stats: PlayerMatchStats[] }
  | { type: "player"; username: string; connected: boolean; abandoned: boolean }
  | { type: "pause" }
  | { type: "resume" };

const QUALITY: Record<Quality, { pixelRatio: number; bloom: boolean; shadows: boolean }> = {
  low: { pixelRatio: 0.75, bloom: false, shadows: false },
  medium: { pixelRatio: 1, bloom: true, shadows: false },
  high: { pixelRatio: 1.25, bloom: true, shadows: true },
  ultra: { pixelRatio: 2, bloom: true, shadows: true },
};

interface SnapOthers {
  tick: number;
  byId: Map<string, WireOther>;
}

interface Remote {
  info: MatchInfo["players"][number];
  avatar: CharacterRig;
  pos: THREE.Vector3;
  alive: boolean;
  hp: number;
  connected: boolean;
}

const MAX_PENDING = 240;

/**
 * Runtime da partida online. O cliente só envia comandos; tudo é decidido pelo servidor.
 * - Predição: o próprio jogador é simulado localmente com o mesmo código do servidor.
 * - Reconciliação: a cada snapshot, volta ao estado autoritativo e reaplica comandos não confirmados.
 * - Interpolação: os outros jogadores são desenhados ~100 ms no passado, entre dois snapshots.
 * - Compensação de latência: cada comando informa o tick que o jogador via (`viewTick`).
 */
export class OnlineRuntime {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private map: BuiltMap;
  private world: CollisionWorld;
  private input: InputManager;
  private audio: GameAudio;
  private vm: ViewModel;
  private fx: Effects;

  private me: Combatant;
  private loadout: WeaponStats[];
  private seq: number;
  private pending: PlayerCommand[] = [];
  private outbox: WireCommand[] = [];
  private wantSlot = 0;
  private yaw: number;
  private pitch = 0;
  private recoilDebt = 0;
  private prevPos: Vec3;
  private visualOffset = new THREE.Vector3();
  private deathT = 0;

  private remotes = new Map<string, Remote>();
  private snaps: SnapOthers[] = [];
  private tickOffset: number | null = null;
  private lastSnap: Snapshot | null = null;
  private phase: MatchPhase = "warmup";
  private kd = new Map<string, [number, number, number]>();
  /** Últimas eliminações recebidas (para testes e para o placar). */
  private killLog: Array<{ killer: string; victim: string; weapon: string; head: boolean }> = [];

  private accumulator = 0;
  private raf = 0;
  private lastFrame = performance.now();
  private lastRender = 0;
  private locked = false;
  private disposed = false;
  private hudTimer = 0;
  private fpsFrames = 0;
  private fpsT = 0;
  private fps = 0;
  private stepDist = 0;
  private wasOnGround = true;
  private mouseFrame = { x: 0, y: 0 };
  private ended = false;
  private connected = true;
  rtt = 0;

  constructor(
    private container: HTMLElement,
    private mapDef: MapDefinition,
    weapons: Map<string, WeaponStats>,
    private info: MatchInfo,
    private settings: GameSettings,
    private send: (cmds: WireCommand[]) => void,
    private onHud: (h: OnlineHud) => void,
    private onEvent: (e: OnlineEvent) => void,
  ) {
    const q = QUALITY[settings.quality];
    this.renderer = new THREE.WebGLRenderer({ antialias: settings.quality !== "low", powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    const atm = mapDef.atmosphere;
    this.scene.background = new THREE.Color(atm.sky);
    this.scene.fog = new THREE.FogExp2(atm.fog, atm.fogDensity);
    this.scene.add(new THREE.HemisphereLight(atm.ambient, "#2a3048", 2.6));
    const sun = atm.sun;
    const moon = new THREE.DirectionalLight(sun?.color ?? 0xb8c8ff, sun ? sun.intensity : atm.theme === "lab" ? 0.25 : 1.8);
    if (sun) moon.position.set(sun.dir.x * 50, sun.dir.y * 50, sun.dir.z * 50);
    else moon.position.set(-20, 40, -10);
    moon.castShadow = q.shadows;
    moon.shadow.mapSize.set(2048, 2048);
    Object.assign(moon.shadow.camera, { left: -36, bottom: -36, right: 36, top: 36, far: 120 });
    this.scene.add(moon);

    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 300);
    this.camera.rotation.order = "YXZ";
    this.map = buildMap(mapDef, { shadows: q.shadows });
    this.scene.add(this.map.group);
    this.world = new CollisionWorld(mapDef.solids.map((s) => s.box));
    this.fx = new Effects();
    this.scene.add(this.fx.group);

    const mine = info.players.find((p) => p.id === info.you)!;
    this.loadout = mine.loadout.map((c) => weapons.get(c)!).filter(Boolean);
    this.vm = new ViewModel(TEAM_COLORS[info.yourTeam]);
    this.vm.prepare(this.loadout);
    this.vm.equip(this.loadout[0]!.code);

    const spawns = info.yourTeam === 0 ? mapDef.spawns.A : mapDef.spawns.B;
    this.me = createCombatant(spawns[0]!, this.loadout, (Math.random() * 2 ** 31) >>> 0);
    this.me.seq = info.lastSeq;
    this.seq = info.lastSeq;
    this.prevPos = { ...this.me.move.pos };
    this.yaw = info.yourTeam === 0 ? mapDef.spawnYaw.A : mapDef.spawnYaw.B;

    for (const p of info.players) {
      if (p.id === info.you) continue;
      const ally = p.team === info.yourTeam;
      const avatar = new CharacterRig(p.character, { accent: p.color, team: TEAM_COLORS[p.team], name: ally ? p.username : null, detail: "low" });
      this.scene.add(avatar.root);
      this.remotes.set(p.id, { info: p, avatar, pos: new THREE.Vector3(0, -100, 0), alive: true, hp: 100, connected: p.connected });
    }

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (q.bloom) this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.5, 0.55));
    this.composer.addPass(new OutputPass());

    this.audio = new GameAudio(settings.volume);
    this.audio.startAmbience(mapDef.atmosphere.theme);
    this.input = new InputManager(this.renderer.domElement, (locked) => {
      this.locked = locked;
      if (locked) this.audio.resume();
      this.onEvent({ type: locked ? "resume" : "pause" });
    });
    window.addEventListener("resize", this.resize);
    this.resize();
    this.loop();
  }

  start() {
    this.audio.resume();
    this.input.requestLock();
  }

  setSettings(s: Partial<GameSettings>) {
    this.settings = { ...this.settings, ...s };
    this.audio.setVolume(this.settings.volume);
  }

  setConnected(c: boolean) {
    this.connected = c;
  }

  /** Reinicia a numeração de comandos após reconexão (o servidor informa o último aceito). */
  resync(info: MatchInfo) {
    this.info = info;
    this.seq = info.lastSeq;
    this.me.seq = info.lastSeq;
    this.pending = [];
    this.outbox = [];
    this.tickOffset = null;
    this.snaps = [];
    for (const p of info.players) {
      const r = this.remotes.get(p.id);
      if (r) r.connected = p.connected;
    }
  }

  // ───────────── Rede ─────────────

  handleMessage(msg: ServerMessage) {
    if (msg.t !== "snap") return;
    this.onSnapshot(msg);
  }

  private estServerTick(now = performance.now()) {
    return this.tickOffset === null ? 0 : now / TICK_MS + this.tickOffset;
  }

  private renderTick() {
    return this.estServerTick() - INTERP_DELAY_TICKS;
  }

  private onSnapshot(s: Snapshot) {
    const now = performance.now();
    const sample = s.tick - now / TICK_MS;
    // Segue o snapshot mais recente rapidamente; atrasos (jitter) só puxam para trás devagar.
    if (this.tickOffset === null || Math.abs(sample - this.tickOffset) > 30) this.tickOffset = sample;
    else if (sample > this.tickOffset) this.tickOffset += (sample - this.tickOffset) * 0.5;
    else this.tickOffset += (sample - this.tickOffset) * 0.05;

    this.lastSnap = s;
    this.phase = s.phase;
    this.snaps.push({ tick: s.tick, byId: new Map(s.others.map((o) => [o[0], o])) });
    if (this.snaps.length > 40) this.snaps.shift();
    for (const [id, k, d, a] of s.kd) this.kd.set(id, [k, d, a]);
    for (const ev of s.ev) this.onMatchEvent(ev);
    this.reconcile(s);
  }

  private reconcile(s: Snapshot) {
    const w = s.you;
    const before = { ...this.me.move.pos };
    const wasAlive = this.me.alive;
    const m = this.me.move;
    m.pos = { ...w.pos };
    m.vel = { ...w.vel };
    m.onGround = w.onGround;
    m.crouched = w.crouched;
    m.crouchBlend = w.crouchBlend;
    m.sprinting = w.sprinting;
    m.jumpCooldown = w.jumpCooldown;
    this.me.slot = w.slot;
    this.me.health = w.health;
    this.me.alive = w.alive;
    this.me.seq = w.seq;
    w.weapons.forEach((ww, i) => {
      const ws = this.me.weapons[i];
      if (ws) Object.assign(ws, ww); // shotSeed local é mantido: a dispersão real é sigilosa no servidor
    });
    this.pending = this.pending.filter((c) => c.seq > w.seq);
    const frozen = s.phase !== "live";
    for (const c of this.pending) applyCommand(this.me, c, { world: this.world, loadout: this.loadout, frozen, zones: this.mapDef.zones });

    const dx = before.x - this.me.move.pos.x;
    const dy = before.y - this.me.move.pos.y;
    const dz = before.z - this.me.move.pos.z;
    const err = Math.hypot(dx, dy, dz);
    if (err > 0.0001) {
      // Erro pequeno: suaviza visualmente. Grande (teleporte/novo round): aplica direto.
      if (err < 1.5) this.visualOffset.add(new THREE.Vector3(dx, dy, dz));
      else this.visualOffset.set(0, 0, 0);
      this.prevPos = { x: this.prevPos.x - dx, y: this.prevPos.y - dy, z: this.prevPos.z - dz };
    }
    if (wasAlive && !this.me.alive) this.deathT = 0;
    if (this.me.slot !== this.wantSlot && this.pending.length === 0) this.wantSlot = this.me.slot;
  }

  private name(id: string) {
    return this.info.players.find((p) => p.id === id)?.username ?? "?";
  }
  private teamOf(id: string): 0 | 1 {
    return this.info.players.find((p) => p.id === id)?.team ?? 0;
  }

  private onMatchEvent(ev: MatchEventWire) {
    switch (ev.k) {
      case "shot": {
        if (ev.by === this.info.you) return; // o próprio tiro já foi desenhado na predição
        const r = this.remotes.get(ev.by);
        r?.avatar.shoot();
        this.audio.shot(ev.cat as WeaponStats["category"], ev.from, ev.w);
        const enemy = this.teamOf(ev.by) !== this.info.yourTeam;
        const from = r ? { x: r.pos.x, y: r.pos.y + 1.4, z: r.pos.z } : ev.from;
        for (const end of ev.ends.slice(0, 3)) {
          this.fx.tracer(from, end, enemy);
          this.fx.impact(end, { x: from.x - end.x, y: from.y - end.y, z: from.z - end.z }, false);
        }
        break;
      }
      case "hit":
        if (ev.by === this.info.you) {
          this.audio.hit(ev.head);
          this.onEvent({ type: "hit", headshot: ev.head, kill: ev.kill, damage: ev.dmg });
        }
        if (ev.target === this.info.you) {
          const r = this.remotes.get(ev.by);
          const p = this.me.move.pos;
          const from = r?.pos ?? new THREE.Vector3(p.x, p.y, p.z - 1);
          const rel = Math.atan2(-(from.x - p.x), -(from.z - p.z)) - this.yaw;
          this.onEvent({ type: "damaged", angle: -Math.atan2(Math.sin(rel), Math.cos(rel)), amount: ev.dmg });
          this.audio.hurt();
        }
        break;
      case "kill": {
        const you = this.info.you;
        this.killLog.push({ killer: this.name(ev.killer), victim: this.name(ev.victim), weapon: ev.weapon, head: ev.head });
        if (this.killLog.length > 20) this.killLog.shift();
        if (ev.killer === you) this.audio.kill();
        if (ev.victim === you) {
          this.audio.death();
          this.onEvent({ type: "died", by: this.name(ev.killer) });
        }
        this.onEvent({ type: "killfeed", killer: this.name(ev.killer), victim: this.name(ev.victim), weapon: ev.weapon, headshot: ev.head, killerTeam: this.teamOf(ev.killer), victimTeam: this.teamOf(ev.victim), involvesYou: ev.killer === you || ev.victim === you });
        break;
      }
      case "round_start":
        this.yaw = this.info.yourTeam === 0 ? this.mapDef.spawnYaw.A : this.mapDef.spawnYaw.B;
        this.pitch = 0;
        this.recoilDebt = 0;
        this.wantSlot = 0;
        this.onEvent({ type: "round_start", round: ev.round });
        break;
      case "round_end":
        this.onEvent({ type: "round_end", round: ev.round, winner: ev.winner, reason: ev.reason, score: ev.score });
        break;
      case "match_end":
        this.ended = true;
        this.onEvent({ type: "match_end", winner: ev.winner, score: ev.score, reason: ev.reason, stats: ev.stats });
        break;
      case "player": {
        const r = this.remotes.get(ev.id);
        if (r) r.connected = ev.connected;
        if (ev.id !== this.info.you) this.onEvent({ type: "player", username: this.name(ev.id), connected: ev.connected, abandoned: !!ev.abandoned });
        break;
      }
    }
  }

  // ───────────── Loop ─────────────

  private resize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vm.setAspect(w / h);
  };

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (this.settings.maxFps > 0 && now - this.lastRender < 1000 / this.settings.maxFps - 0.5) return;
    this.lastRender = now;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.fpsFrames++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsT);
      this.fpsFrames = 0;
      this.fpsT = 0;
    }

    this.handleLook();
    // A simulação local continua mesmo sem pointer lock (comandos ociosos), para o relógio
    // de comandos acompanhar o do servidor.
    if (this.tickOffset !== null && !this.ended) {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= TICK_DT && steps < 8) {
        this.tick();
        this.accumulator -= TICK_DT;
        steps++;
      }
      if (steps === 8) this.accumulator = 0;
    }
    if (this.outbox.length) {
      this.send(this.outbox);
      this.outbox = [];
    }
    this.render(dt);
  };

  private handleLook() {
    const m = this.input.takeMouse();
    this.mouseFrame = m;
    if (!this.me.alive || !this.locked) return;
    const stats = this.loadout[this.me.slot]!;
    const zoom = this.input.aim && this.canAim() ? CATEGORY_TUNING[stats.category].adsZoom : 1;
    const k = (this.settings.sensitivity * 0.0022) / zoom;
    this.yaw -= m.x * k;
    this.pitch = clamp(this.pitch - m.y * k, -89 * DEG, 89 * DEG);
    if (m.y > 0) this.recoilDebt = Math.max(0, this.recoilDebt - m.y * k);
  }

  private canAim() {
    const ws = this.me.weapons[this.me.slot]!;
    const now = this.me.seq * TICK_MS;
    return !this.me.move.sprinting && now >= ws.switchEndsAt && !isReloading(ws, now);
  }

  private tick() {
    if (this.pending.length >= MAX_PENDING) return; // sem confirmação do servidor há 4 s: espera
    const inp = this.input;
    const active = this.locked;
    if (active) {
      if (inp.consume("slot1")) this.wantSlot = 0;
      if (inp.consume("slot2")) this.wantSlot = Math.min(1, this.loadout.length - 1);
      if (inp.consume("slot3")) this.wantSlot = Math.min(2, this.loadout.length - 1);
      const wheel = inp.consumeWheel();
      if (wheel !== 0 && this.loadout.length > 1) this.wantSlot = (this.wantSlot + wheel + this.loadout.length) % this.loadout.length;
    }
    const reload = active && inp.consume("reload");
    // Toques rápidos (entre dois ticks, comuns com FPS baixo) também contam; sempre consome para não "sobrar".
    const jumpTap = inp.consume("jump");
    const fireTap = inp.consumeFireTap();
    const cmd: PlayerCommand = {
      seq: ++this.seq,
      forward: active ? (inp.isDown("forward") ? 1 : 0) - (inp.isDown("back") ? 1 : 0) : 0,
      right: active ? (inp.isDown("right") ? 1 : 0) - (inp.isDown("left") ? 1 : 0) : 0,
      jump: active && (inp.isDown("jump") || jumpTap),
      crouch: active && inp.isDown("crouch"),
      sprint: active && inp.isDown("sprint"),
      aim: active && inp.aim,
      fire: active && (inp.fire || fireTap),
      reload,
      slot: this.wantSlot,
      yaw: Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw)),
      pitch: this.pitch,
      viewTick: Math.max(0, Math.floor(this.renderTick())),
    };
    this.prevPos = { ...this.me.move.pos };
    const out = applyCommand(this.me, cmd, { world: this.world, loadout: this.loadout, frozen: this.phase !== "live", zones: this.mapDef.zones });
    this.pending.push(cmd);
    this.outbox.push(encodeCommand(cmd));

    const stats = this.loadout[this.me.slot]!;
    if (out.switched) {
      this.vm.equip(stats.code);
      this.audio.switchWeapon();
    }
    if (out.reloadStarted) {
      const ws = this.me.weapons[this.me.slot]!;
      this.audio.reload(ws.reloadEndsAt! - cmd.seq * TICK_MS);
    }
    if (out.dryFire) this.audio.dryFire();
    if (out.shot) {
      // Feedback imediato (predição); dano e acertos chegam do servidor.
      this.audio.shot(stats.category, undefined, stats.code);
      this.vm.onShot(stats.recoil);
      this.pitch = clamp(this.pitch + out.shot.recoilPitch, -89 * DEG, 89 * DEG);
      this.yaw += out.shot.recoilYaw;
      this.recoilDebt += out.shot.recoilPitch;
      const o = out.shot.origin;
      const muzzle = { x: o.x + Math.sin(-this.yaw) * 0.6 + Math.cos(this.yaw) * 0.12, y: o.y - 0.12, z: o.z - Math.cos(this.yaw) * 0.6 - Math.sin(this.yaw) * 0.12 };
      for (const dir of out.shot.directions.slice(0, 4)) {
        const range = CATEGORY_TUNING[stats.category].maxRange;
        const wall = raycastWorld(this.world, o, dir, range);
        if (wall) {
          this.fx.impact(wall.point, wall.normal);
          if (stats.pelletsPerShot <= 1) this.fx.tracer(muzzle, wall.point);
        } else if (stats.pelletsPerShot <= 1) this.fx.tracer(muzzle, { x: o.x + dir.x * 60, y: o.y + dir.y * 60, z: o.z + dir.z * 60 });
      }
    }
    const ws = this.me.weapons[this.me.slot]!;
    if (cmd.seq * TICK_MS - ws.lastShotAt > 120 && this.recoilDebt > 0) {
      const back = Math.min(this.recoilDebt, this.recoilDebt * 9 * TICK_DT + 0.0005);
      this.pitch -= back * 0.7;
      this.recoilDebt -= back;
    }

    // Passos.
    const p = this.me.move;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    if (p.onGround) {
      this.stepDist += speed * TICK_DT;
      if (this.stepDist > (p.sprinting ? 2.4 : 2.0) && !p.crouched) {
        this.stepDist = 0;
        this.audio.footstep(p.sprinting);
      }
      if (!this.wasOnGround) this.audio.land();
    }
    this.wasOnGround = p.onGround;
  }

  private interpolateOthers(dt: number) {
    const rt = this.renderTick();
    let a: SnapOthers | undefined;
    let b: SnapOthers | undefined;
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      if (this.snaps[i]!.tick <= rt) {
        a = this.snaps[i];
        b = this.snaps[i + 1];
        break;
      }
    }
    if (!a) a = this.snaps[0];
    if (!a) return;
    const t = b ? clamp((rt - a.tick) / (b.tick - a.tick), 0, 1) : 0;
    for (const [id, r] of this.remotes) {
      const oa = a.byId.get(id);
      if (!oa) continue;
      const ob = b?.byId.get(id) ?? oa;
      // Teleporte (início de round): não interpola através do mapa.
      const jump = Math.hypot(ob[1] - oa[1], ob[3] - oa[3]) > 3;
      const k = jump ? 1 : t;
      r.pos.set(oa[1] + (ob[1] - oa[1]) * k, oa[2] + (ob[2] - oa[2]) * k, oa[3] + (ob[3] - oa[3]) * k);
      let dyaw = ob[4] - oa[4];
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      const yaw = oa[4] + dyaw * k;
      const pitch = oa[5] + (ob[5] - oa[5]) * k;
      const crouch = oa[6] + (ob[6] - oa[6]) * k;
      r.alive = (k < 0.5 ? oa : ob)[7] === 1;
      r.hp = (k < 0.5 ? oa : ob)[9];
      const flags = (k < 0.5 ? oa : ob)[10] ?? ANIM_FLAG.onGround;
      r.avatar.updateAt(dt, r.pos, yaw, {
        pitch,
        crouch,
        alive: r.alive,
        onGround: (flags & ANIM_FLAG.onGround) !== 0,
        sprinting: (flags & ANIM_FLAG.sprinting) !== 0,
        reloading: (flags & ANIM_FLAG.reloading) !== 0,
      });
      r.avatar.root.visible = r.connected || r.alive;
    }
  }

  private render(dt: number) {
    const alpha = this.accumulator / TICK_DT;
    const p = this.me.move;
    this.visualOffset.multiplyScalar(Math.exp(-dt * 12));
    const x = this.prevPos.x + (p.pos.x - this.prevPos.x) * alpha + this.visualOffset.x;
    const y = this.prevPos.y + (p.pos.y - this.prevPos.y) * alpha + this.visualOffset.y;
    const z = this.prevPos.z + (p.pos.z - this.prevPos.z) * alpha + this.visualOffset.z;
    const eyeY = y + eyeHeight(p);
    const stats = this.loadout[this.me.slot]!;
    const ws = this.me.weapons[this.me.slot]!;
    const aiming = this.input.aim && this.locked && this.canAim() && this.me.alive;
    const zoom = aiming ? CATEGORY_TUNING[stats.category].adsZoom : 1;
    const targetFov = this.settings.fov / zoom;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 18);
    this.camera.updateProjectionMatrix();

    if (this.me.alive) {
      this.camera.position.set(x, eyeY, z);
      this.camera.rotation.set(this.pitch, this.yaw, 0);
    } else {
      this.deathT += dt;
      const k = Math.min(1, this.deathT / 0.8);
      this.camera.position.set(x, y + 0.3 + (eyeHeight(p) - 0.3) * (1 - k), z);
      this.camera.rotation.set(this.pitch * (1 - k) - k * 0.5, this.yaw, k * 1.2);
    }
    const f = viewDir(this.yaw, this.pitch);
    this.audio.setListener(x, eyeY, z, f.x, f.y, f.z);
    this.interpolateOthers(dt);
    this.fx.update(dt);
    this.map.update(dt);

    const now = this.me.seq * TICK_MS;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const reloadP = ws.reloadEndsAt !== null ? clamp(1 - (ws.reloadEndsAt - now) / stats.reloadMs, 0, 1) : null;
    const switchMs = CATEGORY_TUNING[stats.category].switchMs;
    const switchP = now < ws.switchEndsAt ? 1 - (ws.switchEndsAt - now) / switchMs : null;
    const scoped = aiming && stats.category === "SNIPER" && this.camera.fov < targetFov * 1.15;
    this.vm.update(dt, { speed, onGround: p.onGround, aiming, sprinting: p.sprinting, reloadP, switchP, mouse: this.mouseFrame, category: stats.category, hideForScope: scoped || !this.me.alive });

    this.renderer.clear();
    this.composer.render();
    this.renderer.clearDepth();
    this.renderer.render(this.vm.scene, this.vm.camera);

    this.hudTimer += dt;
    if (this.hudTimer > 1 / 20) {
      this.hudTimer = 0;
      const spreadDeg = currentSpread(stats, ws, { aiming, moveRatio: Math.min(1, speed / MOVE.sprintSpeed), airborne: !p.onGround, crouched: p.crouched, sprinting: p.sprinting });
      const h = this.renderer.domElement.clientHeight || window.innerHeight;
      const s = this.lastSnap;
      const players: OnlinePlayerRow[] = this.info.players.map((pl) => {
        const kd = this.kd.get(pl.id) ?? [0, 0, 0];
        const r = this.remotes.get(pl.id);
        const you = pl.id === this.info.you;
        return { id: pl.id, username: pl.username, team: pl.team, kills: kd[0], deaths: kd[1], assists: kd[2], alive: you ? this.me.alive : (r?.alive ?? true), connected: you ? this.connected : (r?.connected ?? true), hp: you ? this.me.health : r && r.hp >= 0 ? r.hp : null, you };
      });
      this.onHud({
        health: Math.ceil(this.me.health),
        alive: this.me.alive,
        weapon: { code: stats.code, name: stats.name, category: stats.category, ammo: ws.ammo, magazine: stats.magazineSize, reserve: ws.reserve, reloadP },
        slots: this.loadout.map((w, i) => ({ code: w.code, name: w.name, active: i === this.me.slot })),
        spreadPx: (Math.tan(spreadDeg * DEG) / Math.tan((this.camera.fov * DEG) / 2)) * (h / 2),
        aiming,
        scoped,
        phase: s?.phase ?? "warmup",
        phaseEndsIn: s ? Math.max(0, s.phaseEndsIn - (this.estServerTick() - s.tick) * TICK_MS) : 0,
        round: s?.round ?? 0,
        score: s?.score ?? [0, 0],
        yourTeam: this.info.yourTeam,
        roundsToWin: this.info.roundsToWin,
        players,
        fps: this.fps,
        rtt: Math.round(this.rtt),
        connected: this.connected,
      });
    }
  }

  // ───────────── Testes automatizados ─────────────

  debugState() {
    return {
      map: this.info.map,
      team: this.info.yourTeam,
      pos: { ...this.me.move.pos },
      eye: combatantEye(this.me),
      yaw: this.yaw,
      pitch: this.pitch,
      health: this.me.health,
      alive: this.me.alive,
      seq: this.seq,
      pending: this.pending.length,
      ammo: this.me.weapons[this.me.slot]!.ammo,
      phase: this.lastSnap?.phase ?? null,
      round: this.lastSnap?.round ?? 0,
      score: this.lastSnap?.score ?? [0, 0],
      locked: this.locked,
      others: [...this.remotes.entries()].map(([id, r]) => ({ id, character: r.avatar.code, anim: r.avatar.state, overlays: { ...r.avatar.overlays }, pos: { x: r.pos.x, y: r.pos.y, z: r.pos.z }, alive: r.alive })),
      kd: Object.fromEntries(this.kd),
      killLog: [...this.killLog],
      predictedVsServer: this.lastSnap ? Math.hypot(this.lastSnap.you.pos.x - this.me.move.pos.x, this.lastSnap.you.pos.z - this.me.move.pos.z) : null,
      snapshot: cloneCombatant(this.me).move.pos,
    };
  }

  debugAimAt(p: Vec3) {
    const e = combatantEye(this.me);
    const d = { x: p.x - e.x, y: p.y - e.y, z: p.z - e.z };
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.input.dispose();
    this.audio.dispose();
    this.vm.dispose();
    this.fx.dispose();
    for (const r of this.remotes.values()) r.avatar.dispose();
    this.map.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
