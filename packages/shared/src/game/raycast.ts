import type { AABB } from "./collision.js";
import type { CollisionWorld } from "./collision.js";
import type { Vec3 } from "./math.js";

/** Interseção raio × AABB pelo método das “placas”. Retorna a distância ou null. */
export function rayAabb(origin: Vec3, dir: Vec3, box: AABB, maxDist: number): { t: number; normal: Vec3 } | null {
  let tmin = 0;
  let tmax = maxDist;
  let normal: Vec3 = { x: 0, y: 0, z: 0 };
  for (const axis of ["x", "y", "z"] as const) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < box.min[axis] || o > box.max[axis]) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (box.min[axis] - o) * inv;
    let t2 = (box.max[axis] - o) * inv;
    let sign = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      normal = { x: 0, y: 0, z: 0 };
      normal[axis] = sign;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return { t: tmin, normal };
}

export function raycastWorld(world: CollisionWorld, origin: Vec3, dir: Vec3, maxDist: number): { t: number; point: Vec3; normal: Vec3 } | null {
  const end = { x: origin.x + dir.x * maxDist, y: origin.y + dir.y * maxDist, z: origin.z + dir.z * maxDist };
  const region: AABB = {
    min: { x: Math.min(origin.x, end.x), y: Math.min(origin.y, end.y), z: Math.min(origin.z, end.z) },
    max: { x: Math.max(origin.x, end.x), y: Math.max(origin.y, end.y), z: Math.max(origin.z, end.z) },
  };
  let best: { t: number; normal: Vec3 } | null = null;
  for (const box of world.query(region)) {
    const hit = rayAabb(origin, dir, box, best ? best.t : maxDist);
    if (hit && (!best || hit.t < best.t)) best = hit;
  }
  if (!best) return null;
  return { t: best.t, normal: best.normal, point: { x: origin.x + dir.x * best.t, y: origin.y + dir.y * best.t, z: origin.z + dir.z * best.t } };
}

export type HitZone = "head" | "body" | "legs";

/** Hitboxes de um combatente (jogador, alvo ou drone) para validação de tiro. */
export interface Hitbox { zone: HitZone; box: AABB }

/**
 * Hitboxes humanoides a partir da posição dos pés. Cabeça pequena e separada do corpo:
 * headshot exige precisão real. Agachado reduz a altura.
 */
export function humanoidHitboxes(feet: Vec3, crouched = false): Hitbox[] {
  const h = crouched ? 1.2 : 1.8;
  const headSize = 0.26;
  const bodyTop = h - headSize - 0.04;
  const legsTop = h * 0.45;
  return [
    { zone: "head", box: { min: { x: feet.x - 0.14, y: feet.y + h - headSize, z: feet.z - 0.14 }, max: { x: feet.x + 0.14, y: feet.y + h, z: feet.z + 0.14 } } },
    { zone: "body", box: { min: { x: feet.x - 0.25, y: feet.y + legsTop, z: feet.z - 0.17 }, max: { x: feet.x + 0.25, y: feet.y + bodyTop, z: feet.z + 0.17 } } },
    { zone: "legs", box: { min: { x: feet.x - 0.22, y: feet.y, z: feet.z - 0.15 }, max: { x: feet.x + 0.22, y: feet.y + legsTop, z: feet.z + 0.15 } } },
  ];
}

export interface EntityHit<T> { entity: T; zone: HitZone; t: number; point: Vec3 }

/** Primeiro combatente atingido pelo raio, considerando a parede mais próxima (sem atravessar cobertura). */
export function raycastEntities<T>(entities: Array<{ entity: T; hitboxes: Hitbox[] }>, origin: Vec3, dir: Vec3, maxDist: number): EntityHit<T> | null {
  let best: EntityHit<T> | null = null;
  for (const e of entities) {
    for (const hb of e.hitboxes) {
      const hit = rayAabb(origin, dir, hb.box, best ? best.t : maxDist);
      if (hit && (!best || hit.t < best.t)) {
        best = { entity: e.entity, zone: hb.zone, t: hit.t, point: { x: origin.x + dir.x * hit.t, y: origin.y + dir.y * hit.t, z: origin.z + dir.z * hit.t } };
      }
    }
  }
  return best;
}
