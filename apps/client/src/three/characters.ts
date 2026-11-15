import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { CharacterSkinMaterial } from "@vanta/shared";

/**
 * Os 8 operadores da VANTA como modelos procedurais (assets originais gerados em código, sem
 * arquivos externos). Cada um tem silhueta própria (capacete, ombros, capa, mochila, acessórios),
 * mas todos usam o mesmo esqueleto hierárquico e a mesma altura (1,8 m), porque a hitbox no
 * servidor é igual para todos: a aparência nunca muda a vantagem competitiva.
 *
 * Animações (procedurais, misturadas por peso a cada quadro):
 *   idle · walk · run · crouch · jump · shoot (sobreposta) · reload (sobreposta) · die
 * A frente do modelo é −Z (mesma convenção da câmera do jogo).
 */

export const CHARACTER_CODES = ["RAVEN", "GHOST", "NOVA", "TITAN", "ZERO", "VIPER", "ECHO", "ORION"] as const;
export type CharacterCode = (typeof CHARACTER_CODES)[number];
export type AnimState = "idle" | "walk" | "run" | "crouch" | "jump" | "die";

export interface AnimInput {
  /** Velocidade horizontal em m/s. */
  speed: number;
  sprinting: boolean;
  /** 0 = em pé, 1 = agachado. */
  crouch: number;
  onGround: boolean;
  alive: boolean;
  reloading: boolean;
  /** Inclinação da mira (rad, positivo = para cima). */
  pitch: number;
}

interface Palette {
  armor: string;
  plate: string;
  fabric: string;
  trim: string;
  /** Largura dos ombros/tronco (apenas visual). */
  bulk: number;
}

const PALETTES: Record<CharacterCode, Palette> = {
  RAVEN: { armor: "#2f3a52", plate: "#56627c", fabric: "#1c2232", trim: "#287BFF", bulk: 1 },
  GHOST: { armor: "#3a3f4a", plate: "#5a606c", fabric: "#121418", trim: "#9AA6BF", bulk: 0.92 },
  NOVA: { armor: "#c9c4d8", plate: "#e6e2f0", fabric: "#2a2140", trim: "#823BFF", bulk: 0.9 },
  TITAN: { armor: "#a67c2e", plate: "#5a4a36", fabric: "#2a2a2a", trim: "#FF9A2E", bulk: 1.22 },
  ZERO: { armor: "#d8dce4", plate: "#9aa2b2", fabric: "#2a2f3a", trim: "#E8ECF4", bulk: 0.9 },
  VIPER: { armor: "#2f4436", plate: "#4a6450", fabric: "#1f2a22", trim: "#3FBF7F", bulk: 0.96 },
  ECHO: { armor: "#5f7a88", plate: "#c8d4dc", fabric: "#3a4a54", trim: "#2ED3E6", bulk: 1.05 },
  ORION: { armor: "#3a1a26", plate: "#5a2a3a", fabric: "#1a1016", trim: "#D4AF37", bulk: 1.02 },
};

export function isCharacterCode(code: string): code is CharacterCode {
  return (CHARACTER_CODES as readonly string[]).includes(code);
}

const THIGH = 0.43;
const SHIN = 0.43;
const HIPS_Y = 0.93;
const LEG_PIVOT = HIPS_Y - 0.06;
const ANKLE = 0.035;

const damp = (k: number, dt: number) => 1 - Math.exp(-k * dt);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Ângulo da coxa para que o pé toque o chão com o quadril a `pivotY` (pernas simétricas). */
function legAngleFor(pivotY: number) {
  return Math.acos(Math.min(1, Math.max(0, (pivotY - ANKLE) / (THIGH + SHIN))));
}

export interface CharacterOptions {
  /** Cor de destaque (emissiva). Padrão: cor do operador. */
  accent?: string;
  /** Cor do time (faixa no ombro/capacete) — usada nas partidas. */
  team?: string | null;
  /** Nome exibido acima (aliados). */
  name?: string | null;
  /** "high" = cantos arredondados (menu); "low" = caixas simples (partida). */
  detail?: "high" | "low";
  /** Skin equipada: troca só as cores (mesma silhueta e mesma hitbox). */
  skin?: CharacterSkinMaterial | null;
}

export class CharacterRig {
  readonly root = new THREE.Group();
  readonly code: CharacterCode;
  /** Estado de locomoção atual (para depuração/testes). */
  state: AnimState = "idle";
  /** Sobreposições ativas neste quadro. */
  overlays = { shooting: false, reloading: false };

  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private accent: THREE.MeshStandardMaterial;
  private visor: THREE.MeshStandardMaterial;
  private rounded: boolean;

  private hips = new THREE.Group();
  private spine = new THREE.Group();
  private chest = new THREE.Group();
  private head = new THREE.Group();
  private aim = new THREE.Group();
  private gun = new THREE.Group();
  private mag!: THREE.Object3D;
  private thighs: THREE.Group[] = [];
  private shins: THREE.Group[] = [];
  private feet: THREE.Group[] = [];
  private uppers: THREE.Group[] = [];
  private fores: THREE.Group[] = [];
  /** Peças com balanço secundário (capas, abas do casaco, antenas). */
  private cloth: Array<{ o: THREE.Object3D; base: number; amt: number }> = [];
  private drone: THREE.Group | null = null;
  private flash: THREE.PointLight;
  private nameTag: THREE.Sprite | null = null;

  // Estado da animação.
  private t = Math.random() * 10;
  private phase = 0;
  private wRun = 0;
  private wMove = 0;
  private wAir = 0;
  private airTime = 0;
  private crouch = 0;
  private recoil = 0;
  private shootT = 0;
  private reloadT = 0;
  private reloadW = 0;
  private deathT = 0;
  private deathDir = 1;
  private lastPos = new THREE.Vector3();
  private hasPos = false;

  constructor(code: string, opts: CharacterOptions = {}) {
    this.code = isCharacterCode(code) ? code : "RAVEN";
    const base = PALETTES[this.code];
    const pal: Palette = opts.skin ? { ...base, armor: opts.skin.armor, plate: opts.skin.plate, fabric: opts.skin.fabric, trim: opts.skin.trim } : base;
    this.rounded = opts.detail !== "low";
    const accentHex = opts.skin?.glow ?? opts.accent ?? pal.trim;

    const armor = this.mat(new THREE.MeshStandardMaterial({ color: pal.armor, metalness: 0.45, roughness: 0.42 }));
    const plate = this.mat(new THREE.MeshStandardMaterial({ color: pal.plate, metalness: 0.35, roughness: 0.48 }));
    const fabric = this.mat(new THREE.MeshStandardMaterial({ color: pal.fabric, metalness: 0.05, roughness: 0.9 }));
    const trim = this.mat(new THREE.MeshStandardMaterial({ color: pal.trim, metalness: 0.6, roughness: 0.3 }));
    this.accent = this.mat(new THREE.MeshStandardMaterial({ color: accentHex, emissive: accentHex, emissiveIntensity: 1.5, roughness: 0.3 }));
    this.visor = this.mat(new THREE.MeshStandardMaterial({ color: 0x0a0f1c, emissive: accentHex, emissiveIntensity: 0.9, metalness: 0.9, roughness: 0.1 }));
    const team = opts.team ? this.mat(new THREE.MeshStandardMaterial({ color: opts.team, emissive: opts.team, emissiveIntensity: 2.2, toneMapped: false })) : this.accent;
    const gunMat = this.mat(new THREE.MeshStandardMaterial({ color: 0x151a24, metalness: 0.75, roughness: 0.32 }));
    const M = { armor, plate, fabric, trim, accent: this.accent, visor: this.visor, team, gun: gunMat };
    const bulk = pal.bulk;

    // ── Esqueleto ────────────────────────────────────────────────────────────
    // Escala final: o topo do capacete fica em ~1,80 m, a altura da hitbox em pé no servidor.
    this.root.scale.setScalar(0.94);
    this.root.add(this.hips);
    this.hips.position.y = HIPS_Y;
    this.part(this.hips, 0.34 * bulk, 0.16, 0.22, armor);
    this.part(this.hips, 0.36 * bulk, 0.03, 0.235, team, 0, 0.05, 0);

    for (const side of [-1, 1]) {
      const thigh = new THREE.Group();
      thigh.position.set(side * 0.11 * Math.min(bulk, 1.1), -0.06, 0);
      this.hips.add(thigh);
      this.part(thigh, 0.15 * Math.min(bulk, 1.1), THIGH, 0.17, fabric, 0, -THIGH / 2, 0);
      this.part(thigh, 0.16, 0.18, 0.05, plate, 0, -0.18, -0.08);
      const shin = new THREE.Group();
      shin.position.y = -THIGH;
      thigh.add(shin);
      this.part(shin, 0.13 * Math.min(bulk, 1.1), SHIN - 0.02, 0.15, fabric, 0, -SHIN / 2, 0);
      this.part(shin, 0.15, 0.13, 0.07, armor, 0, -0.02, -0.07); // joelheira
      const foot = new THREE.Group();
      foot.position.y = -SHIN + 0.045;
      shin.add(foot);
      this.part(foot, 0.15, 0.08, 0.27, armor, 0, -0.04, -0.05); // bota
      this.feet.push(foot);
      this.thighs.push(thigh);
      this.shins.push(shin);
    }

    this.spine.position.y = 0.08;
    this.hips.add(this.spine);
    this.part(this.spine, 0.32 * bulk, 0.2, 0.2, fabric, 0, 0.1, 0);
    this.chest.position.y = 0.22;
    this.spine.add(this.chest);
    this.part(this.chest, 0.44 * bulk, 0.34, 0.27, armor, 0, 0.14, 0, 0.05);
    this.part(this.chest, 0.36 * bulk, 0.2, 0.06, plate, 0, 0.13, -0.15);
    this.part(this.chest, 0.22, 0.02, 0.012, this.accent, 0, 0.2, -0.185);

    const neck = new THREE.Group();
    neck.position.y = 0.33;
    this.chest.add(neck);
    this.part(neck, 0.11, 0.08, 0.11, fabric, 0, 0.03, 0);
    this.head.position.y = 0.09;
    neck.add(this.head);

    // Mira: ombros, braços e arma giram juntos com o pitch.
    this.aim.position.y = 0.25;
    this.chest.add(this.aim);
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.27 * bulk, 0, 0);
      this.aim.add(shoulder);
      const upper = new THREE.Group();
      shoulder.add(upper);
      this.part(upper, 0.1, 0.29, 0.11, fabric, 0, -0.145, 0);
      const fore = new THREE.Group();
      fore.position.y = -0.29;
      upper.add(fore);
      this.part(fore, 0.095, 0.27, 0.1, plate, 0, -0.135, 0);
      this.part(fore, 0.08, 0.08, 0.09, fabric, 0, -0.3, 0); // luva
      this.uppers.push(upper);
      this.fores.push(fore);
    }

    // Arma de terceira pessoa (silhueta genérica; cada operador muda os detalhes).
    this.gun.position.set(0.07, -0.1, -0.36);
    this.aim.add(this.gun);
    this.part(this.gun, 0.07, 0.1, 0.5, gunMat, 0, 0, 0, 0.015);
    this.part(this.gun, 0.045, 0.045, 0.3, gunMat, 0, 0.015, -0.38);
    this.part(this.gun, 0.06, 0.1, 0.2, plate, 0, -0.01, 0.32);
    this.part(this.gun, 0.072, 0.012, 0.3, this.accent, 0, 0.02, -0.05);
    this.part(this.gun, 0.04, 0.05, 0.1, gunMat, 0, 0.075, -0.02);
    this.mag = this.part(this.gun, 0.05, 0.14, 0.07, gunMat, 0, -0.11, -0.06);
    this.flash = new THREE.PointLight(0xffd29a, 0, 4);
    this.flash.position.set(0, 0.02, -0.6);
    this.gun.add(this.flash);

    this.buildIdentity(M, bulk);

    if (opts.name) this.nameTag = this.makeNameTag(opts.name, opts.team ?? accentHex);
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    this.applyPose(0);
  }

  // ── Identidade visual de cada operador ─────────────────────────────────────
  private buildIdentity(M: Record<"armor" | "plate" | "fabric" | "trim" | "accent" | "visor" | "team" | "gun", THREE.MeshStandardMaterial>, bulk: number) {
    const h = this.head;
    const c = this.chest;
    const shoulderPads = (w: number, hgt: number, mat: THREE.Material) => {
      for (const side of [-1, 1]) this.part(c, w, hgt, 0.22, mat, side * (0.27 * bulk + w * 0.25), 0.3, 0, 0.04);
    };
    switch (this.code) {
      case "RAVEN": {
        // Capacete tático com viseira larga, colete com bolsos e ombreiras.
        this.part(h, 0.23, 0.25, 0.26, M.armor, 0, 0.11, 0, 0.09);
        this.part(h, 0.25, 0.08, 0.27, M.plate, 0, 0.21, 0.01, 0.03);
        this.part(h, 0.2, 0.075, 0.05, M.visor, 0, 0.12, -0.125, 0.02);
        this.part(h, 0.012, 0.11, 0.06, M.accent, 0.12, 0.12, 0);
        for (const x of [-0.11, 0, 0.11]) this.part(c, 0.08, 0.09, 0.05, M.fabric, x * bulk, 0.02, -0.17);
        shoulderPads(0.15, 0.1, M.plate);
        this.part(c, 0.08, 0.03, 0.2, M.team, -0.32, 0.36, 0);
        break;
      }
      case "GHOST": {
        // Capuz pontudo, máscara lisa com fenda, sobretudo com abas.
        this.part(h, 0.21, 0.24, 0.24, M.fabric, 0, 0.11, 0, 0.08);
        this.part(h, 0.17, 0.02, 0.03, M.visor, 0, 0.13, -0.12);
        const hood = this.mesh(new THREE.ConeGeometry(0.19, 0.2, 4), M.fabric);
        hood.position.set(0, 0.13, 0.03);
        hood.rotation.set(-0.12, Math.PI / 4, 0);
        h.add(hood);
        for (const side of [-1, 1]) {
          const tail = new THREE.Group();
          tail.position.set(side * 0.1, -0.02, 0.06);
          this.hips.add(tail);
          this.part(tail, 0.16, 0.55, 0.03, M.fabric, 0, -0.27, 0);
          this.cloth.push({ o: tail, base: 0.08, amt: 0.6 });
        }
        this.part(c, 0.46 * bulk, 0.06, 0.29, M.fabric, 0, 0.3, 0.01); // gola
        this.part(c, 0.05, 0.03, 0.2, M.team, 0.26, 0.33, 0);
        break;
      }
      case "NOVA": {
        // Capacete esférico, antenas, mochila tecnológica e drone de apoio flutuando.
        const dome = this.mesh(new THREE.SphereGeometry(0.145, 14, 10), M.armor);
        dome.position.y = 0.12;
        h.add(dome);
        this.part(h, 0.22, 0.07, 0.12, M.visor, 0, 0.12, -0.08, 0.03);
        for (const side of [-1, 1]) {
          const ant = this.mesh(new THREE.CylinderGeometry(0.005, 0.008, 0.12, 5), M.trim);
          ant.position.set(side * 0.1, 0.22, 0.02);
          ant.rotation.z = -side * 0.3;
          h.add(ant);
          this.cloth.push({ o: ant, base: -side * 0.3, amt: 0.15 });
        }
        this.part(c, 0.3, 0.3, 0.12, M.plate, 0, 0.14, 0.19, 0.03);
        this.part(c, 0.2, 0.03, 0.02, M.accent, 0, 0.22, 0.255);
        const drone = new THREE.Group();
        drone.position.set(0.45, 0.42, 0.12);
        this.part(drone, 0.12, 0.05, 0.12, M.armor, 0, 0, 0, 0.02);
        this.part(drone, 0.06, 0.02, 0.02, M.accent, 0, 0, -0.065);
        for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) this.part(drone, 0.07, 0.008, 0.07, M.fabric, x * 0.08, 0.03, z * 0.08);
        c.add(drone);
        this.drone = drone;
        this.part(c, 0.05, 0.03, 0.2, M.team, -0.26, 0.33, 0);
        break;
      }
      case "TITAN": {
        // Exoesqueleto industrial: capacete cilíndrico com grade, ombreiras enormes, pistões e célula de energia.
        const helm = this.mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.27, 10), M.armor);
        helm.position.y = 0.11;
        h.add(helm);
        for (let i = 0; i < 3; i++) this.part(h, 0.16, 0.015, 0.03, M.visor, 0, 0.08 + i * 0.035, -0.15);
        this.part(h, 0.18, 0.04, 0.3, M.plate, 0, 0.26, 0.01);
        shoulderPads(0.24, 0.16, M.armor);
        for (const side of [-1, 1]) this.part(c, 0.26, 0.04, 0.24, M.team, side * 0.38, 0.39, 0);
        this.part(c, 0.34, 0.4, 0.18, M.plate, 0, 0.12, 0.22, 0.04);
        this.part(c, 0.12, 0.26, 0.04, M.accent, 0, 0.14, 0.32);
        for (const thigh of this.thighs) {
          const piston = this.mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.5, 6), M.trim);
          piston.position.set(0, -0.3, 0.1);
          thigh.add(piston);
        }
        break;
      }
      case "ZERO": {
        // Capacete liso, implante ocular (lente única), cachecol longo nas costas.
        this.part(h, 0.21, 0.24, 0.25, M.armor, 0, 0.11, 0, 0.1);
        this.part(h, 0.2, 0.05, 0.04, M.fabric, 0, 0.13, -0.115, 0.015);
        const eye = this.mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.05, 12), M.accent);
        eye.rotation.x = Math.PI / 2;
        eye.position.set(0.05, 0.13, -0.135);
        h.add(eye);
        this.part(h, 0.015, 0.06, 0.18, M.plate, -0.11, 0.2, 0.04);
        const scarf = new THREE.Group();
        scarf.position.set(0.05, 0.33, 0.15);
        c.add(scarf);
        this.part(scarf, 0.12, 0.6, 0.02, M.accent, 0, -0.3, 0);
        this.cloth.push({ o: scarf, base: 0.12, amt: 0.8 });
        this.part(c, 0.3 * bulk, 0.07, 0.29, M.fabric, 0, 0.32, 0);
        this.part(c, 0.05, 0.03, 0.2, M.team, -0.26, 0.33, 0);
        break;
      }
      case "VIPER": {
        // Capuz arredondado, respirador com dois filtros, alças cruzadas no peito.
        this.part(h, 0.24, 0.27, 0.27, M.fabric, 0, 0.12, 0.01, 0.1);
        this.part(h, 0.18, 0.05, 0.04, M.visor, 0, 0.15, -0.125, 0.015);
        this.part(h, 0.14, 0.08, 0.06, M.plate, 0, 0.06, -0.13, 0.025);
        for (const side of [-1, 1]) {
          const filter = this.mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 10), M.trim);
          filter.rotation.z = Math.PI / 2;
          filter.position.set(side * 0.09, 0.05, -0.13);
          h.add(filter);
        }
        for (const side of [-1, 1]) {
          const strap = this.part(c, 0.05, 0.44, 0.02, M.trim, 0, 0.13, -0.17);
          strap.rotation.z = side * 0.6;
        }
        this.part(this.hips, 0.4 * bulk, 0.05, 0.25, M.trim, 0, -0.04, 0); // bandoleira
        this.part(c, 0.05, 0.03, 0.2, M.team, 0.26, 0.33, 0);
        break;
      }
      case "ECHO": {
        // Sensores auditivos grandes, antena parabólica nas costas e parka com gola de pele.
        this.part(h, 0.22, 0.24, 0.25, M.armor, 0, 0.11, 0, 0.09);
        this.part(h, 0.19, 0.06, 0.04, M.visor, 0, 0.12, -0.12, 0.02);
        for (const side of [-1, 1]) {
          const ear = this.mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 14), M.plate);
          ear.rotation.z = Math.PI / 2;
          ear.position.set(side * 0.14, 0.11, 0);
          h.add(ear);
          this.part(h, 0.012, 0.06, 0.06, M.accent, side * 0.175, 0.11, 0);
        }
        const collar = this.mesh(new THREE.TorusGeometry(0.13, 0.05, 6, 12), M.plate);
        collar.rotation.x = Math.PI / 2;
        collar.position.y = 0.32;
        c.add(collar);
        this.part(c, 0.48 * bulk, 0.3, 0.3, M.fabric, 0, 0.1, 0, 0.06); // parka
        const mast = new THREE.Group();
        mast.position.set(-0.1, 0.32, 0.18);
        c.add(mast);
        this.part(mast, 0.02, 0.22, 0.02, M.trim, 0, 0.11, 0);
        const dish = this.mesh(new THREE.CylinderGeometry(0.1, 0.02, 0.05, 12), M.plate);
        dish.position.y = 0.23;
        dish.rotation.x = -0.5;
        mast.add(dish);
        this.cloth.push({ o: mast, base: 0, amt: 0.12 });
        this.part(c, 0.05, 0.03, 0.2, M.team, 0.28, 0.33, 0);
        break;
      }
      case "ORION": {
        // Capacete com crista, capa, detalhes dourados e emblema no peito.
        this.part(h, 0.23, 0.25, 0.26, M.armor, 0, 0.11, 0, 0.09);
        this.part(h, 0.2, 0.06, 0.05, M.visor, 0, 0.12, -0.125, 0.02);
        this.part(h, 0.03, 0.06, 0.3, M.trim, 0, 0.245, 0.02);
        shoulderPads(0.17, 0.12, M.trim);
        const emblem = this.mesh(new THREE.OctahedronGeometry(0.05), M.accent);
        emblem.position.set(0, 0.15, -0.19);
        c.add(emblem);
        const cape = new THREE.Group();
        cape.position.set(0, 0.32, 0.16);
        c.add(cape);
        this.part(cape, 0.46 * bulk, 0.95, 0.02, M.fabric, 0, -0.47, 0);
        this.part(cape, 0.46 * bulk, 0.03, 0.025, M.trim, 0, -0.94, 0);
        this.cloth.push({ o: cape, base: 0.1, amt: 0.7 });
        this.part(c, 0.05, 0.03, 0.2, M.team, -0.3, 0.4, 0);
        break;
      }
    }
  }

  // ── API ───────────────────────────────────────────────────────────────────
  setAccent(hex: string) {
    this.accent.color.set(hex);
    this.accent.emissive.set(hex);
    this.visor.emissive.set(hex);
  }

  /** Disparo: coice no tronco/arma e clarão no cano. */
  shoot() {
    this.recoil = 1;
    this.shootT = 0.25;
    this.flash.intensity = 6;
  }

  /** Posiciona o boneco (pés em `pos`) e avança a animação, derivando a velocidade do movimento. */
  updateAt(dt: number, pos: THREE.Vector3, yaw: number, input: Omit<AnimInput, "speed">) {
    let speed = 0;
    if (this.hasPos) {
      const d = Math.hypot(pos.x - this.lastPos.x, pos.z - this.lastPos.z);
      speed = d > 3 ? 0 : dt > 0 ? Math.min(9, d / dt) : 0; // >3 m = teleporte (novo round)
    }
    this.hasPos = true;
    this.lastPos.copy(pos);
    this.root.position.copy(pos);
    this.root.rotation.y = yaw;
    this.update(dt, { ...input, speed });
  }

  update(dt: number, i: AnimInput) {
    this.t += dt;
    this.flash.intensity = Math.max(0, this.flash.intensity - dt * 60);
    this.recoil = Math.max(0, this.recoil - dt * 7);
    this.shootT = Math.max(0, this.shootT - dt);

    if (!i.alive) {
      if (this.deathT === 0) this.deathDir = Math.random() < 0.5 ? -1 : 1;
      this.deathT = Math.min(1, this.deathT + dt * 1.8);
      this.state = "die";
      this.overlays = { shooting: false, reloading: false };
      if (this.nameTag) this.nameTag.visible = false;
      this.applyPose(dt);
      return;
    }
    if (this.deathT > 0) {
      // Renasceu (novo round): volta ao estado neutro de uma vez.
      this.deathT = 0;
      this.root.rotation.x = 0;
      this.root.rotation.z = 0;
    }
    if (this.nameTag) this.nameTag.visible = true;

    this.airTime = i.onGround ? 0 : this.airTime + dt;
    const airborne = this.airTime > 0.06;
    const moving = Math.min(1, i.speed / 3);
    const running = i.sprinting && i.speed > 3 ? 1 : 0;
    this.wMove = lerp(this.wMove, moving, damp(10, dt));
    this.wRun = lerp(this.wRun, running, damp(8, dt));
    this.wAir = lerp(this.wAir, airborne ? 1 : 0, damp(14, dt));
    this.crouch = lerp(this.crouch, i.crouch, damp(16, dt));
    this.reloadW = lerp(this.reloadW, i.reloading ? 1 : 0, damp(10, dt));
    this.reloadT = i.reloading ? this.reloadT + dt : 0;
    // Passada: a frequência acompanha a velocidade (sem "patinar").
    if (!airborne) this.phase += dt * (2.2 + i.speed * 1.35);

    this.state = airborne ? "jump" : this.wRun > 0.5 ? "run" : i.crouch > 0.5 ? "crouch" : this.wMove > 0.3 ? "walk" : "idle";
    this.overlays = { shooting: this.shootT > 0, reloading: i.reloading };
    this.pitch = i.pitch;
    this.applyPose(dt);
  }

  private pitch = 0;
  private look = new THREE.Vector2();

  /** Menu: a cabeça acompanha o cursor. */
  setLook(x: number, y: number) {
    this.look.set(x, y);
  }

  private applyPose(dt: number) {
    const t = this.t;
    const breathe = Math.sin(t * 1.7);
    const s = Math.sin(this.phase);
    const c = Math.cos(this.phase);
    const run = this.wRun;
    const move = this.wMove;
    const air = this.wAir;
    const cr = this.crouch;

    // ── Pernas: agachamento resolvido analiticamente (pés no chão) + passada ──
    const hipDrop = cr * 0.4 + Math.abs(c) * 0.03 * move * (1 + run);
    const pivot = LEG_PIVOT - hipDrop;
    const bend = legAngleFor(pivot);
    const stride = move * (0.45 + run * 0.4) * (1 - air) * (1 - cr * 0.4);
    for (let k = 0; k < 2; k++) {
      const sgn = k === 0 ? 1 : -1;
      const swing = s * sgn * stride;
      // Joelho dobra mais na fase de recuperação da perna (quando ela vai à frente).
      const lift = Math.max(0, -Math.cos(this.phase + (k === 0 ? 0 : Math.PI))) * stride * 1.3;
      let thighX = bend + swing;
      let shinX = -2 * bend - lift;
      // Pulo: pernas recolhidas (uma mais que a outra).
      thighX = lerp(thighX, k === 0 ? 0.75 : 0.25, air);
      shinX = lerp(shinX, k === 0 ? -1.3 : -0.55, air);
      this.thighs[k]!.rotation.set(thighX, 0, sgn * -0.03);
      this.shins[k]!.rotation.x = shinX;
      // Pé paralelo ao chão no apoio; levemente apontado para baixo no ar.
      this.feet[k]!.rotation.x = -(thighX + shinX) * (1 - air * 0.6);
    }
    this.hips.position.y = HIPS_Y - hipDrop + (move < 0.1 ? Math.sin(t * 0.55) * 0.006 : 0);
    this.hips.rotation.y = s * 0.08 * move;
    this.hips.rotation.z = move < 0.1 ? Math.sin(t * 0.55) * 0.015 : 0;

    // ── Tronco ──
    this.spine.rotation.x = -(run * 0.28 + cr * 0.22 + air * 0.08); // inclina para a frente (−x = frente em −Z)
    this.spine.rotation.y = -s * 0.08 * move;
    this.chest.position.y = 0.22 + breathe * 0.005 * (1 - move);
    this.chest.rotation.x = -this.recoil * 0.06 + breathe * 0.01;
    this.head.rotation.x = lerp(0, -this.look.y * 0.18, 1) + run * 0.2 + cr * 0.15;
    this.head.rotation.y = this.look.x * 0.45;

    // ── Braços e arma: mira → corrida (arma baixa) → recarga ──
    const aimPitch = this.pitch * (1 - run);
    this.aim.rotation.x = aimPitch + run * 0.1 + cr * 0.2 + air * 0.05;
    const reload = this.reloadW;
    const rp = (this.reloadT * 1.6) % 1; // ciclo: tira o carregador, busca outro, encaixa
    const handDown = reload * Math.sin(Math.min(1, rp / 0.7) * Math.PI);
    // Braço direito (gatilho).
    this.uppers[1]!.rotation.set(lerp(1.05, 0.55, run) - this.recoil * 0.1, 0, lerp(-0.15, 0.05, run));
    this.fores[1]!.rotation.set(lerp(0.75, 1.2, run), 0, 0);
    // Braço esquerdo (guarda-mão), vai ao cinto durante a recarga.
    this.uppers[0]!.rotation.set(lerp(lerp(1.35, 0.8, run), 0.35, handDown), 0, lerp(lerp(0.55, 0.35, run), 0.15, handDown));
    this.fores[0]!.rotation.set(lerp(lerp(0.35, 1.0, run), 1.4, handDown), 0, 0);
    // Arma: na corrida aponta para baixo/lado; na recarga inclina para expor o carregador.
    this.gun.rotation.set(lerp(0, -0.6, run) + reload * -0.25, lerp(0, 0.6, run), reload * 0.55);
    this.gun.position.set(0.07, -0.1 + reload * 0.04, -0.36 + this.recoil * 0.05 + run * 0.12);
    this.mag.position.y = -0.11 - handDown * 0.14;
    this.mag.visible = !(reload > 0.5 && rp > 0.3 && rp < 0.55);

    // ── Peças secundárias ──
    for (const p of this.cloth) p.o.rotation.x = p.base + (move * 0.25 + run * 0.35 + air * 0.4) * p.amt + Math.sin(t * 2.3 + p.base * 10) * 0.04 * p.amt;
    if (this.drone) {
      this.drone.position.y = 0.42 + Math.sin(t * 2.1) * 0.04;
      this.drone.rotation.y = Math.sin(t * 0.8) * 0.4;
    }

    // ── Morte: joelhos cedem e o corpo tomba para trás/lado ──
    if (this.deathT > 0) {
      const d = this.deathT;
      const buckle = Math.min(1, d * 2.2);
      const fall = Math.max(0, (d - 0.25) / 0.75);
      const ease = fall * fall * (3 - 2 * fall);
      for (let k = 0; k < 2; k++) {
        this.thighs[k]!.rotation.x = lerp(bend, 1.1 - k * 0.5, buckle);
        this.shins[k]!.rotation.x = lerp(-2 * bend, -1.6 + k * 0.6, buckle);
        this.feet[k]!.rotation.x = -(this.thighs[k]!.rotation.x + this.shins[k]!.rotation.x);
      }
      this.hips.position.y = lerp(HIPS_Y, 0.16, Math.max(buckle * 0.45, ease));
      this.root.rotation.x = ease * 1.35; // tomba para trás (+x leva a cabeça para +Z)
      this.root.rotation.z = ease * 0.35 * this.deathDir;
      this.spine.rotation.x = -0.2 * buckle + ease * 0.25;
      this.aim.rotation.x = -0.8 * ease;
      this.uppers[0]!.rotation.set(lerp(1.3, -0.4, ease), 0, 0.9 * ease);
      this.uppers[1]!.rotation.set(lerp(1.0, -0.6, ease), 0, -0.9 * ease);
      this.gun.rotation.set(-0.8 * ease, 0.8 * ease, 1.2 * ease);
      this.head.rotation.x = -0.4 * ease;
    }
    void dt;
  }

  // ── Construção ────────────────────────────────────────────────────────────
  private mat<T extends THREE.Material>(m: T) {
    this.mats.push(m);
    return m;
  }

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material) {
    this.geos.push(geo);
    return new THREE.Mesh(geo, mat);
  }

  private part(parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, r = 0.02) {
    const geo = this.rounded ? new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)) : new THREE.BoxGeometry(w, h, d);
    const m = this.mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  private makeNameTag(name: string, color: string) {
    const cv = document.createElement("canvas");
    cv.width = 256;
    cv.height = 48;
    const g = cv.getContext("2d")!;
    g.font = "600 26px Barlow, sans-serif";
    g.textAlign = "center";
    g.fillStyle = color;
    g.fillText(name, 128, 32);
    const sm = this.mat(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
    const tag = new THREE.Sprite(sm);
    tag.scale.set(1.2, 0.22, 1);
    tag.position.y = 2.15;
    tag.renderOrder = 10;
    this.root.add(tag);
    return tag;
  }

  dispose() {
    this.geos.forEach((g) => g.dispose());
    this.mats.forEach((m) => {
      (m as THREE.SpriteMaterial).map?.dispose();
      m.dispose();
    });
    this.root.removeFromParent();
  }
}
