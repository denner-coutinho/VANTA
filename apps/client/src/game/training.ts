import * as THREE from "three";
import { humanoidHitboxes, raycastWorld, type CollisionWorld, type Hitbox, type MapDefinition, type Vec3 } from "@vanta/shared";

/** Alvo humanoide de treinamento (claramente um boneco, não um jogador). */
export class TrainingTarget {
  readonly mesh = new THREE.Group();
  hp = 100;
  alive = true;
  private deadT = 0;
  private fall = 0;
  private base: Vec3;
  private t = Math.random() * 10;
  private flashT = 0;
  private mats: THREE.MeshStandardMaterial[];
  pos: Vec3;

  constructor(private def: MapDefinition["training"]["targets"][number], geo: TargetGeometry) {
    this.base = { ...def.pos };
    this.pos = { ...def.pos };
    const body = new THREE.MeshStandardMaterial({ color: 0xc8cfdc, roughness: 0.6, metalness: 0.2, emissive: 0xff3b4e, emissiveIntensity: 0 });
    const head = new THREE.MeshStandardMaterial({ color: 0xff9a2e, roughness: 0.5, emissive: 0xff9a2e, emissiveIntensity: 0.25 });
    const ring = new THREE.MeshBasicMaterial({ color: 0xff3b4e, toneMapped: false });
    this.mats = [body, head];
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      this.pivot.add(mesh);
      return mesh;
    };
    this.mesh.add(this.pivot);
    add(geo.body, body, 0, 1.12, 0);
    add(geo.legs, body, 0, 0.4, 0);
    add(geo.head, head, 0, 1.67, 0);
    add(geo.ring, ring, 0, 1.15, 0.175);
    const stand = new THREE.Mesh(geo.stand, new THREE.MeshStandardMaterial({ color: 0x222938, metalness: 0.7, roughness: 0.4 }));
    stand.position.y = 0.02;
    this.mesh.add(stand);
    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
  }
  private pivot = new THREE.Group();

  hitboxes(): Hitbox[] {
    return this.alive ? humanoidHitboxes(this.pos) : [];
  }

  damage(amount: number): boolean {
    if (!this.alive) return false;
    this.hp -= amount;
    this.flashT = 0.12;
    if (this.hp <= 0) {
      this.alive = false;
      this.deadT = 0;
      return true;
    }
    return false;
  }

  update(dt: number, facing: Vec3) {
    this.t += dt;
    if (this.def.rail && this.alive) {
      const off = Math.sin(this.t * this.def.rail.speed) * this.def.rail.amplitude;
      this.pos = { ...this.base, [this.def.rail.axis]: this.base[this.def.rail.axis] + off };
    }
    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
    // Alvos sempre de frente para o jogador (rotação só visual; hitbox é AABB).
    this.mesh.rotation.y = Math.atan2(facing.x - this.pos.x, facing.z - this.pos.z);
    this.flashT -= dt;
    this.mats[0]!.emissiveIntensity = this.flashT > 0 ? 1.2 : 0;
    if (!this.alive) {
      // Animação de queda e reaparição após 3 s.
      this.deadT += dt;
      this.fall = Math.min(1, this.fall + dt * 3.5);
      if (this.deadT > 3) {
        this.alive = true;
        this.hp = 100;
      }
    } else this.fall = Math.max(0, this.fall - dt * 4);
    this.pivot.rotation.x = -this.fall * (Math.PI / 2) * 0.95;
  }

  dispose() {
    this.mats.forEach((m) => m.dispose());
  }
}

export interface TargetGeometry { body: THREE.BufferGeometry; legs: THREE.BufferGeometry; head: THREE.BufferGeometry; ring: THREE.BufferGeometry; stand: THREE.BufferGeometry }

export function targetGeometry(): TargetGeometry {
  return {
    body: new THREE.BoxGeometry(0.5, 0.62, 0.32),
    legs: new THREE.BoxGeometry(0.42, 0.8, 0.28),
    head: new THREE.BoxGeometry(0.26, 0.26, 0.26),
    ring: new THREE.RingGeometry(0.06, 0.1, 24),
    stand: new THREE.CylinderGeometry(0.35, 0.4, 0.04, 20),
  };
}

/**
 * Drone sentinela: robô de treino que patrulha a praça e revida quando tem linha de visão.
 * Precisão baixa e dano moderado: serve para treinar uso de cobertura, vida e respawn.
 */
export class SentinelDrone {
  readonly mesh = new THREE.Group();
  hp = 150;
  alive = true;
  pos: Vec3;
  private home: Vec3;
  private t = 0;
  private cooldown = 1.5;
  private deadT = 0;
  private eye: THREE.MeshBasicMaterial;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  enabled = true;
  /** Retardo de reação ao avistar o jogador (s). */
  private sight = 0;

  constructor(spawn: Vec3) {
    this.home = { ...spawn };
    this.pos = { ...spawn };
    const shell = new THREE.MeshStandardMaterial({ color: 0x2c3448, metalness: 0.8, roughness: 0.3 });
    this.eye = new THREE.MeshBasicMaterial({ color: 0xff3b4e, toneMapped: false });
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff3b4e, toneMapped: false, transparent: true, opacity: 0.8 });
    const core = new THREE.SphereGeometry(0.32, 20, 14);
    const eyeG = new THREE.SphereGeometry(0.09, 12, 8);
    const ring = new THREE.TorusGeometry(0.46, 0.025, 8, 40);
    const rotor = new THREE.BoxGeometry(0.9, 0.02, 0.08);
    this.geos.push(core, eyeG, ring, rotor);
    this.mats.push(shell, this.eye, ringMat);
    this.mesh.add(new THREE.Mesh(core, shell));
    const e = new THREE.Mesh(eyeG, this.eye);
    e.position.z = 0.28;
    this.mesh.add(e);
    const r = new THREE.Mesh(ring, ringMat);
    r.rotation.x = Math.PI / 2;
    this.mesh.add(r);
    this.rotors = new THREE.Mesh(rotor, shell);
    this.rotors.position.y = 0.36;
    this.mesh.add(this.rotors);
    this.light = new THREE.PointLight(0xff3b4e, 3, 6);
    this.mesh.add(this.light);
  }
  private rotors: THREE.Mesh;
  private light: THREE.PointLight;

  hitboxes(): Hitbox[] {
    if (!this.alive) return [];
    const r = 0.36;
    // Núcleo inteiro conta como “cabeça” (ponto fraco) só no olho; resto é corpo.
    return [
      { zone: "head", box: { min: { x: this.pos.x - 0.1, y: this.pos.y - 0.1, z: this.pos.z - 0.1 }, max: { x: this.pos.x + 0.1, y: this.pos.y + 0.1, z: this.pos.z + 0.1 } } },
      { zone: "body", box: { min: { x: this.pos.x - r, y: this.pos.y - r, z: this.pos.z - r }, max: { x: this.pos.x + r, y: this.pos.y + r, z: this.pos.z + r } } },
    ];
  }

  damage(amount: number): boolean {
    if (!this.alive) return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.alive = false;
      this.deadT = 0;
      return true;
    }
    return false;
  }

  /** Retorna um disparo contra o jogador neste frame (ou null). */
  update(dt: number, playerEye: Vec3, playerAlive: boolean, world: CollisionWorld): { from: Vec3; dir: Vec3; hit: boolean } | null {
    this.t += dt;
    this.rotors.rotation.y += dt * 40;
    if (!this.alive) {
      this.deadT += dt;
      this.mesh.position.y = Math.max(0.35, this.mesh.position.y - dt * 6);
      this.mesh.rotation.z += dt * 4;
      this.light.intensity = 0;
      if (this.deadT > 5) {
        this.alive = true;
        this.hp = 150;
        this.pos = { ...this.home };
        this.mesh.rotation.set(0, 0, 0);
        this.cooldown = 2;
      }
      return null;
    }
    // Patrulha em “8” sobre a praça.
    this.pos = { x: this.home.x + Math.sin(this.t * 0.35) * 7, y: this.home.y + Math.sin(this.t * 1.3) * 0.3, z: this.home.z + Math.sin(this.t * 0.7) * 4 };
    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.light.intensity = 3;
    const to = { x: playerEye.x - this.pos.x, y: playerEye.y - this.pos.y, z: playerEye.z - this.pos.z };
    const dist = Math.hypot(to.x, to.y, to.z);
    const dir = { x: to.x / dist, y: to.y / dist, z: to.z / dist };
    this.mesh.rotation.y = Math.atan2(dir.x, dir.z);
    if (!this.enabled || !playerAlive || dist > 40) {
      this.sight = 0;
      return null;
    }
    const wall = raycastWorld(world, this.pos, dir, dist);
    const visible = !wall || wall.t >= dist - 0.3;
    this.sight = visible ? this.sight + dt : 0;
    this.eye.color.set(visible ? 0xff3b4e : 0xffb547);
    this.cooldown -= dt;
    if (!visible || this.sight < 0.6 || this.cooldown > 0) return null;
    this.cooldown = 0.55;
    // Precisão cai com a distância: ~70% a 10 m, ~35% a 30 m.
    const hitChance = Math.max(0.2, 0.85 - dist * 0.017);
    const hit = Math.random() < hitChance;
    const miss = hit ? { x: 0, y: 0, z: 0 } : { x: (Math.random() - 0.5) * 0.12, y: (Math.random() - 0.3) * 0.1, z: (Math.random() - 0.5) * 0.12 };
    const shotDir = { x: dir.x + miss.x, y: dir.y + miss.y, z: dir.z + miss.z };
    return { from: { ...this.pos }, dir: shotDir, hit };
  }

  dispose() {
    this.geos.forEach((g) => g.dispose());
    this.mats.forEach((m) => m.dispose());
  }
}
