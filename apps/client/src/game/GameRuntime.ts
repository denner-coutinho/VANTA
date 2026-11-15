import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import {
  CATEGORY_TUNING,
  CollisionWorld,
  DEG,
  MOVE,
  TICK_DT,
  beginSwitchTo,
  clamp,
  createPlayerState,
  createWeaponState,
  currentSpread,
  damageAt,
  eyeHeight,
  fireBlockReason,
  fireWeapon,
  isReloading,
  raycastEntities,
  raycastWorld,
  startReload,
  stepPlayer,
  updateWeapon,
  viewDir,
  type HitZone,
  type MapDefinition,
  type PlayerState,
  type Vec3,
  type WeaponState,
  type WeaponStats,
  type WeaponSkinMaterial,
} from "@vanta/shared";
import { InputManager } from "./input";
import { GameAudio } from "./audio";
import { buildMap, type BuiltMap } from "./mapBuilder";
import { ViewModel } from "./viewmodel";
import { Effects } from "./effects";
import { SentinelDrone, TrainingTarget, targetGeometry, type TargetGeometry } from "./training";

export type Quality = "low" | "medium" | "high" | "ultra";

export interface GameSettings {
  sensitivity: number;
  fov: number;
  maxFps: number;
  volume: number;
  quality: Quality;
}

export interface TrainingStats {
  shots: number;
  hits: number;
  headshots: number;
  kills: number;
  damage: number;
  deaths: number;
  /** Tempo médio entre o primeiro acerto e a eliminação (ms). */
  avgTtkMs: number | null;
}

export interface HudState {
  health: number;
  alive: boolean;
  respawnIn: number;
  weapon: { code: string; name: string; category: WeaponStats["category"]; ammo: number; magazine: number; reserve: number; reloadP: number | null };
  slots: Array<{ code: string; name: string; active: boolean }>;
  spreadPx: number;
  aiming: boolean;
  scoped: boolean;
  sprinting: boolean;
  crouched: boolean;
  speed: number;
  stats: TrainingStats;
  fps: number;
  interactHint: string | null;
  droneEnabled: boolean;
  noAmmoHint: boolean;
}

export type GameEvent =
  | { type: "hit"; headshot: boolean; kill: boolean; damage: number; target: string }
  | { type: "damaged"; angle: number; amount: number }
  | { type: "died"; by: string }
  | { type: "killfeed"; text: string; headshot: boolean }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "interact"; action: "loadout" };

const QUALITY: Record<Quality, { pixelRatio: number; bloom: boolean; shadows: boolean }> = {
  low: { pixelRatio: 0.75, bloom: false, shadows: false },
  medium: { pixelRatio: 1, bloom: true, shadows: false },
  high: { pixelRatio: 1.25, bloom: true, shadows: true },
  ultra: { pixelRatio: 2, bloom: true, shadows: true },
};

const PLAYER_MAX_HP = 100;
const DRONE_DAMAGE = 9;

/**
 * Runtime do modo treinamento. Simulação em tick fixo (60 Hz) com o mesmo código
 * de `@vanta/shared` que o servidor autoritativo usará na Fase 3; renderização desacoplada
 * com interpolação e limite de FPS configurável.
 */
export class GameRuntime {
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
  private targets: TrainingTarget[] = [];
  private targetGeo: TargetGeometry;
  private drone: SentinelDrone;

  private player: PlayerState;
  private prevPos: Vec3;
  private yaw: number;
  private pitch = 0;
  private recoilDebt = 0;
  private health = PLAYER_MAX_HP;
  private alive = true;
  private deathT = 0;
  private lastDamageAt = -1e9;

  private weapons = new Map<string, WeaponStats>();
  private loadout: string[] = [];
  private weaponStates = new Map<string, WeaponState>();
  private slot = 0;

  private simTimeMs = 0;
  private accumulator = 0;
  private raf = 0;
  private lastFrame = performance.now();
  private lastRender = 0;
  private paused = true;
  private disposed = false;
  private stepDist = 0;
  private wasOnGround = true;
  private hudTimer = 0;
  private fpsFrames = 0;
  private fpsT = 0;
  private fps = 0;
  private firstHitAt = new Map<object, number>();
  private ttks: number[] = [];
  private stats: TrainingStats = { shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0, deaths: 0, avgTtkMs: null };
  private mouseFrame = { x: 0, y: 0 };
  private emptyClickAt = 0;
  private noAmmoHint = false;
  private terminalScreen!: THREE.Mesh;

  constructor(
    private container: HTMLElement,
    private mapDef: MapDefinition,
    weaponList: WeaponStats[],
    loadout: string[],
    private settings: GameSettings,
    private onHud: (s: HudState) => void,
    private onEvent: (e: GameEvent) => void,
    weaponSkins: Record<string, WeaponSkinMaterial> = {},
  ) {
    const q = QUALITY[settings.quality];
    this.renderer = new THREE.WebGLRenderer({ antialias: settings.quality !== "low", powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    const sc = moon.shadow.camera;
    sc.left = sc.bottom = -36;
    sc.right = sc.top = 36;
    sc.far = 120;
    moon.shadow.bias = -0.0005;
    this.scene.add(moon);

    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 300);
    this.camera.rotation.order = "YXZ";

    this.map = buildMap(mapDef, { shadows: q.shadows });
    this.scene.add(this.map.group);
    this.world = new CollisionWorld(mapDef.solids.map((s) => s.box));

    this.fx = new Effects();
    this.scene.add(this.fx.group);

    this.targetGeo = targetGeometry();
    for (const t of mapDef.training.targets) {
      const target = new TrainingTarget(t, this.targetGeo);
      this.targets.push(target);
      this.scene.add(target.mesh);
    }
    this.drone = new SentinelDrone(mapDef.training.droneSpawns[0]!);
    this.scene.add(this.drone.mesh);

    // Terminal holográfico de armas (interação com E).
    const tp = this.terminalPosition();
    const term = new THREE.Group();
    const termMat = new THREE.MeshStandardMaterial({ color: 0x222938, metalness: 0.7, roughness: 0.4 });
    const holoMat = new THREE.MeshBasicMaterial({ color: 0x287bff, transparent: true, opacity: 0.55, toneMapped: false, side: THREE.DoubleSide });
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.1, 0.4), termMat);
    pillar.position.y = 0.55;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), holoMat);
    screen.position.set(0, 1.45, 0);
    term.add(pillar, screen, new THREE.PointLight(0x287bff, 3, 4));
    term.position.set(tp.x, tp.y, tp.z);
    this.terminalScreen = screen;
    this.scene.add(term);

    weaponList.forEach((w) => this.weapons.set(w.code, w));
    this.vm = new ViewModel();
    this.vm.setSkins(weaponSkins);
    this.setLoadout(loadout);

    const spawn = mapDef.spawns.A[0]!;
    this.player = createPlayerState({ ...spawn, y: spawn.y + 0.05 });
    this.prevPos = { ...this.player.pos };
    this.yaw = mapDef.spawnYaw.A;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (q.bloom) this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.5, 0.55));
    this.composer.addPass(new OutputPass());

    this.audio = new GameAudio(settings.volume);
    this.audio.startAmbience(mapDef.atmosphere.theme);
    this.input = new InputManager(this.renderer.domElement, (locked) => {
      this.paused = !locked;
      if (locked) this.audio.resume();
      this.onEvent({ type: locked ? "resume" : "pause" });
    });

    window.addEventListener("resize", this.resize);
    this.resize();
    this.loop();
  }

  /** Inicia (precisa de um gesto do usuário por causa do pointer lock). */
  start() {
    this.audio.resume();
    this.input.requestLock();
  }

  setLoadout(codes: string[]) {
    const valid = codes.filter((c) => this.weapons.has(c)).slice(0, 3);
    this.loadout = valid;
    this.vm.prepare(valid.map((c) => this.weapons.get(c)!));
    valid.forEach((c, i) => {
      if (!this.weaponStates.has(c)) this.weaponStates.set(c, createWeaponState(this.weapons.get(c)!, this.simTimeMs, 1000 + i * 77));
    });
    this.slot = Math.min(this.slot, valid.length - 1);
    this.switchTo(this.slot, true);
  }

  setSettings(s: Partial<GameSettings>) {
    this.settings = { ...this.settings, ...s };
    this.audio.setVolume(this.settings.volume);
  }

  setDroneEnabled(on: boolean) {
    this.drone.enabled = on;
  }

  resetStats() {
    this.stats = { shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0, deaths: 0, avgTtkMs: null };
    this.ttks = [];
  }

  private get activeCode() {
    return this.loadout[this.slot]!;
  }
  private get activeStats() {
    return this.weapons.get(this.activeCode)!;
  }
  private get activeState() {
    return this.weaponStates.get(this.activeCode)!;
  }

  private switchTo(slot: number, instant = false) {
    if (slot < 0 || slot >= this.loadout.length) return;
    if (slot === this.slot && !instant) return;
    this.slot = slot;
    const stats = this.activeStats;
    const ws = this.activeState;
    if (instant) ws.switchEndsAt = this.simTimeMs;
    else {
      beginSwitchTo(stats, ws, this.simTimeMs);
      this.audio.switchWeapon();
    }
    this.vm.equip(stats.code);
  }

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
    // Limite de FPS (0 = ilimitado/vsync).
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

    if (!this.paused) {
      this.handleLook();
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= TICK_DT && steps < 8) {
        this.tick();
        this.accumulator -= TICK_DT;
        steps++;
      }
    }
    this.render(dt);
  };

  /** Mouse é lido por frame (resposta imediata), a simulação usa o yaw/pitch atual no tick. */
  private handleLook() {
    const m = this.input.takeMouse();
    this.mouseFrame = m;
    if (!this.alive) return;
    const stats = this.activeStats;
    const zoom = this.input.aim && this.canAim() ? CATEGORY_TUNING[stats.category].adsZoom : 1;
    const k = this.settings.sensitivity * 0.0022 / zoom;
    this.yaw -= m.x * k;
    this.pitch = clamp(this.pitch - m.y * k, -89 * DEG, 89 * DEG);
    // Se o jogador puxar o mouse para baixo durante o recuo, ele “paga” a dívida de recuo.
    if (m.y > 0) this.recoilDebt = Math.max(0, this.recoilDebt - m.y * k);
  }

  private canAim() {
    return !this.player.sprinting && this.simTimeMs >= this.activeState.switchEndsAt && !isReloading(this.activeState, this.simTimeMs);
  }

  private tick() {
    this.simTimeMs += TICK_DT * 1000;
    const tMs = this.simTimeMs;
    const inp = this.input;

    if (!this.alive) {
      this.deathT += TICK_DT;
      if (this.deathT >= 3) this.respawn();
      this.updateWorld(TICK_DT);
      return;
    }

    // Troca de armas.
    if (inp.consume("slot1")) this.switchTo(0);
    if (inp.consume("slot2")) this.switchTo(1);
    if (inp.consume("slot3")) this.switchTo(2);
    const wheel = inp.consumeWheel();
    if (wheel !== 0 && this.loadout.length > 1) this.switchTo((this.slot + wheel + this.loadout.length) % this.loadout.length);

    const stats = this.activeStats;
    const ws = this.activeState;
    if (inp.consume("reload") && startReload(stats, ws, tMs)) this.audio.reload(ws.reloadEndsAt! - tMs);

    // Interação (E): terminal de armas perto do spawn.
    const nearTerminal = this.distanceToTerminal() < 2.5;
    if (inp.consume("interact") && nearTerminal) {
      this.onEvent({ type: "interact", action: "loadout" });
      document.exitPointerLock();
    }

    const aiming = inp.aim && this.canAim();
    const jumpTap = inp.consume("jump"); // toque rápido entre ticks também pula
    this.prevPos = { ...this.player.pos };
    stepPlayer(
      this.player,
      {
        forward: (inp.isDown("forward") ? 1 : 0) - (inp.isDown("back") ? 1 : 0),
        right: (inp.isDown("right") ? 1 : 0) - (inp.isDown("left") ? 1 : 0),
        jump: inp.isDown("jump") || jumpTap,
        crouch: inp.isDown("crouch"),
        sprint: inp.isDown("sprint"),
        aiming,
        yaw: this.yaw,
        pitch: this.pitch,
        weaponSpeedMult: stats.moveSpeedMult,
      },
      this.world,
    );
    // Correr cancela a recarga? Não: só impede atirar/mirar (comportamento comum em FPS tático).
    const speed = Math.hypot(this.player.vel.x, this.player.vel.z);

    // Passos e pouso.
    if (this.player.onGround) {
      this.stepDist += speed * TICK_DT;
      const stride = this.player.sprinting ? 2.4 : 2.0;
      if (this.stepDist > stride && !this.player.crouched) {
        this.stepDist = 0;
        this.audio.footstep(this.player.sprinting);
      }
      if (!this.wasOnGround) this.audio.land();
    }
    this.wasOnGround = this.player.onGround;

    // Armas.
    for (const [code, st] of this.weaponStates) updateWeapon(this.weapons.get(code)!, st, tMs, TICK_DT * 1000);
    if (!inp.fire) ws.triggerReleased = true;
    if (inp.fire) {
      const block = fireBlockReason(stats, ws, tMs, this.player.sprinting);
      if (!block) this.shoot(stats, ws, aiming, speed);
      else if (block === "empty" && ws.triggerReleased && tMs - this.emptyClickAt > 250) {
        this.emptyClickAt = tMs;
        this.audio.dryFire();
        ws.triggerReleased = false;
        // Recarga automática ao tentar atirar sem munição.
        if (startReload(stats, ws, tMs)) this.audio.reload(ws.reloadEndsAt! - tMs);
      }
    }
    this.noAmmoHint = ws.ammo === 0 && ws.reserve === 0;

    // Recuperação do recuo quando não está atirando.
    if (tMs - ws.lastShotAt > 120 && this.recoilDebt > 0) {
      const back = Math.min(this.recoilDebt, this.recoilDebt * 9 * TICK_DT + 0.0005);
      this.pitch -= back * 0.7;
      this.recoilDebt -= back;
    }

    // Regeneração de vida no treino após 5 s sem dano.
    if (tMs - this.lastDamageAt > 5000 && this.health < PLAYER_MAX_HP) this.health = Math.min(PLAYER_MAX_HP, this.health + 12 * TICK_DT);

    this.updateWorld(TICK_DT);
  }

  private eye(): Vec3 {
    return { x: this.player.pos.x, y: this.player.pos.y + eyeHeight(this.player), z: this.player.pos.z };
  }

  private shoot(stats: WeaponStats, ws: WeaponState, aiming: boolean, speed: number) {
    const origin = this.eye();
    const forward = viewDir(this.yaw, this.pitch);
    const shot = fireWeapon(stats, ws, this.simTimeMs, forward, {
      aiming,
      moveRatio: Math.min(1, speed / MOVE.sprintSpeed),
      airborne: !this.player.onGround,
      crouched: this.player.crouched,
      sprinting: this.player.sprinting,
    });
    this.stats.shots++;
    this.audio.shot(stats.category, undefined, stats.code);
    this.vm.onShot(stats.recoil);
    this.pitch = clamp(this.pitch + shot.recoilPitch, -89 * DEG, 89 * DEG);
    this.yaw += shot.recoilYaw;
    this.recoilDebt += shot.recoilPitch;

    // Acerto por alvo neste disparo (escopeta: soma os projéteis).
    const perTarget = new Map<TrainingTarget | SentinelDrone, { dmg: number; head: boolean }>();
    const entities = [
      ...this.targets.map((t) => ({ entity: t as TrainingTarget | SentinelDrone, hitboxes: t.hitboxes() })),
      { entity: this.drone as TrainingTarget | SentinelDrone, hitboxes: this.drone.hitboxes() },
    ];
    const muzzle = { x: origin.x + forward.x * 0.6 + Math.cos(this.yaw) * 0.12, y: origin.y - 0.12, z: origin.z + forward.z * 0.6 - Math.sin(this.yaw) * 0.12 };
    for (const dir of shot.directions) {
      const maxRange = CATEGORY_TUNING[stats.category].maxRange;
      const wall = raycastWorld(this.world, origin, dir, maxRange);
      const hit = raycastEntities(entities, origin, dir, wall ? wall.t : maxRange);
      if (hit) {
        const dmg = damageAt(stats, hit.t, hit.zone as HitZone);
        const acc = perTarget.get(hit.entity) ?? { dmg: 0, head: false };
        acc.dmg += dmg;
        acc.head ||= hit.zone === "head";
        perTarget.set(hit.entity, acc);
        this.fx.impact(hit.point, { x: -dir.x, y: -dir.y, z: -dir.z }, false);
        if (stats.pelletsPerShot <= 1) this.fx.tracer(muzzle, hit.point);
      } else if (wall) {
        this.fx.impact(wall.point, wall.normal);
        if (stats.pelletsPerShot <= 1 || Math.random() < 0.3) this.fx.tracer(muzzle, wall.point);
        if (Math.random() < 0.3) this.audio.impact(wall.point);
      }
    }
    if (perTarget.size) this.stats.hits++;
    for (const [entity, { dmg, head }] of perTarget) {
      if (head) this.stats.headshots++;
      this.stats.damage += dmg;
      if (!this.firstHitAt.has(entity)) this.firstHitAt.set(entity, this.simTimeMs);
      const killed = entity.damage(dmg);
      const name = entity instanceof SentinelDrone ? "Drone sentinela" : "Alvo de treino";
      this.audio.hit(head);
      this.onEvent({ type: "hit", headshot: head, kill: killed, damage: dmg, target: name });
      if (killed) {
        this.stats.kills++;
        const ttk = this.simTimeMs - this.firstHitAt.get(entity)!;
        this.firstHitAt.delete(entity);
        this.ttks.push(ttk);
        if (this.ttks.length > 30) this.ttks.shift();
        this.stats.avgTtkMs = Math.round(this.ttks.reduce((a, b) => a + b, 0) / this.ttks.length);
        this.audio.kill();
        if (entity instanceof SentinelDrone) this.audio.droneDown(entity.pos);
        this.onEvent({ type: "killfeed", text: `${stats.name} → ${name}`, headshot: head });
      }
    }
  }

  private updateWorld(dt: number) {
    const eye = this.eye();
    for (const t of this.targets) t.update(dt, eye);
    const shot = this.drone.update(dt, eye, this.alive, this.world);
    if (shot) {
      this.audio.droneShot(shot.from);
      const wall = raycastWorld(this.world, shot.from, shot.dir, 60);
      const end = wall ? wall.point : { x: shot.from.x + shot.dir.x * 60, y: shot.from.y + shot.dir.y * 60, z: shot.from.z + shot.dir.z * 60 };
      if (shot.hit) {
        this.fx.tracer(shot.from, eye, true);
        this.takeDamage(DRONE_DAMAGE, shot.from, "Drone sentinela");
      } else {
        this.fx.tracer(shot.from, end, true);
        if (wall) this.fx.impact(wall.point, wall.normal);
      }
    }
  }

  private takeDamage(amount: number, from: Vec3, by: string) {
    if (!this.alive) return;
    this.health -= amount;
    this.lastDamageAt = this.simTimeMs;
    // Ângulo da origem do dano relativo à visão (0 = à frente, sentido horário).
    const dx = from.x - this.player.pos.x;
    const dz = from.z - this.player.pos.z;
    const worldAngle = Math.atan2(-dx, -dz);
    let rel = worldAngle - this.yaw;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    this.onEvent({ type: "damaged", angle: -rel, amount });
    this.audio.hurt();
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.deathT = 0;
      this.stats.deaths++;
      this.audio.death();
      this.onEvent({ type: "died", by });
    }
  }

  private respawn() {
    const spawn = this.mapDef.spawns.A[Math.floor(Math.random() * this.mapDef.spawns.A.length)]!;
    this.player = createPlayerState({ ...spawn, y: spawn.y + 0.05 });
    this.prevPos = { ...this.player.pos };
    this.yaw = this.mapDef.spawnYaw.A;
    this.pitch = 0;
    this.health = PLAYER_MAX_HP;
    this.alive = true;
    for (const code of this.loadout) {
      const w = this.weapons.get(code)!;
      const st = this.weaponStates.get(code)!;
      st.ammo = w.magazineSize;
      st.reserve = w.reserveAmmo;
      st.reloadEndsAt = null;
    }
  }

  private distanceToTerminal() {
    const s = this.mapDef.spawns.A[0]!;
    return Math.hypot(this.player.pos.x - (s.x - 3.5), this.player.pos.z - (s.z - 1));
  }

  private render(dt: number) {
    const alpha = this.paused ? 1 : this.accumulator / TICK_DT;
    const p = this.player;
    const x = this.prevPos.x + (p.pos.x - this.prevPos.x) * alpha;
    const y = this.prevPos.y + (p.pos.y - this.prevPos.y) * alpha;
    const z = this.prevPos.z + (p.pos.z - this.prevPos.z) * alpha;
    const eyeY = y + eyeHeight(p);

    const stats = this.activeStats;
    const ws = this.activeState;
    const aiming = this.input.aim && this.canAim() && this.alive;
    const zoom = aiming ? CATEGORY_TUNING[stats.category].adsZoom : 1;
    const targetFov = this.settings.fov / zoom;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 18);
    this.camera.updateProjectionMatrix();

    if (this.alive) {
      this.camera.position.set(x, eyeY, z);
      this.camera.rotation.set(this.pitch, this.yaw, 0);
    } else {
      // Animação de morte: câmera cai e inclina.
      const k = Math.min(1, this.deathT / 0.8);
      this.camera.position.set(x, y + 0.3 + (eyeHeight(p) - 0.3) * (1 - k), z);
      this.camera.rotation.set(this.pitch * (1 - k) - k * 0.5, this.yaw, k * 1.2);
    }
    const f = viewDir(this.yaw, this.pitch);
    this.audio.setListener(x, eyeY, z, f.x, f.y, f.z);

    this.fx.update(dt);
    this.map.update(dt);
    this.terminalScreen.rotation.y = Math.atan2(x - this.terminalScreen.parent!.position.x, z - this.terminalScreen.parent!.position.z);
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const reloadP = ws.reloadEndsAt !== null ? 1 - (ws.reloadEndsAt - this.simTimeMs) / stats.reloadMs : null;
    const switchMs = CATEGORY_TUNING[stats.category].switchMs;
    const switchP = this.simTimeMs < ws.switchEndsAt ? 1 - (ws.switchEndsAt - this.simTimeMs) / switchMs : null;
    const scoped = aiming && stats.category === "SNIPER" && this.camera.fov < targetFov * 1.15;
    this.vm.update(dt, { speed, onGround: p.onGround, aiming, sprinting: p.sprinting, reloadP, switchP, mouse: this.mouseFrame, category: stats.category, hideForScope: scoped || !this.alive });

    this.renderer.clear();
    this.composer.render();
    this.renderer.clearDepth();
    this.renderer.render(this.vm.scene, this.vm.camera);

    this.hudTimer += dt;
    if (this.hudTimer > 1 / 30) {
      this.hudTimer = 0;
      const spreadDeg = currentSpread(stats, ws, { aiming, moveRatio: Math.min(1, speed / MOVE.sprintSpeed), airborne: !p.onGround, crouched: p.crouched, sprinting: p.sprinting });
      const h = this.renderer.domElement.clientHeight || window.innerHeight;
      const spreadPx = (Math.tan(spreadDeg * DEG) / Math.tan((this.camera.fov * DEG) / 2)) * (h / 2);
      this.onHud({
        health: Math.ceil(this.health),
        alive: this.alive,
        respawnIn: this.alive ? 0 : Math.max(0, 3 - this.deathT),
        weapon: { code: stats.code, name: stats.name, category: stats.category, ammo: ws.ammo, magazine: stats.magazineSize, reserve: ws.reserve, reloadP },
        slots: this.loadout.map((c, i) => ({ code: c, name: this.weapons.get(c)!.name, active: i === this.slot })),
        spreadPx,
        aiming,
        scoped,
        sprinting: p.sprinting,
        crouched: p.crouched,
        speed,
        stats: { ...this.stats },
        fps: this.fps,
        interactHint: this.distanceToTerminal() < 2.5 ? "Pressione E para trocar o arsenal" : null,
        droneEnabled: this.drone.enabled,
        noAmmoHint: this.noAmmoHint,
      });
    }
  }

  /** Posição do terminal de armas (para o cliente desenhar). */
  terminalPosition(): Vec3 {
    const s = this.mapDef.spawns.A[0]!;
    return { x: s.x - 3.5, y: 0, z: s.z - 1 };
  }

  /** Só para testes automatizados: estado de depuração. */
  debugState() {
    return { pos: { ...this.player.pos }, yaw: this.yaw, pitch: this.pitch, health: this.health, slot: this.slot, simTimeMs: this.simTimeMs, ammo: this.activeState.ammo, stats: { ...this.stats }, paused: this.paused };
  }

  /** Só para testes automatizados: mira num ponto do mundo. */
  debugAimAt(p: Vec3) {
    const e = this.eye();
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
    this.targets.forEach((t) => t.dispose());
    this.drone.dispose();
    Object.values(this.targetGeo).forEach((g) => g.dispose());
    this.map.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
