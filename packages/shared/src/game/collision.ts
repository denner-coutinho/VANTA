import type { Vec3 } from "./math.js";

/** Caixa alinhada aos eixos (min/max). Toda a geometria sólida dos mapas é feita disso. */
export interface AABB { min: Vec3; max: Vec3 }

export function aabbFromCenter(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): AABB {
  return { min: { x: cx - sx / 2, y: cy - sy / 2, z: cz - sz / 2 }, max: { x: cx + sx / 2, y: cy + sy / 2, z: cz + sz / 2 } };
}

export function overlaps(a: AABB, b: AABB, eps = 0): boolean {
  return a.min.x < b.max.x - eps && a.max.x > b.min.x + eps && a.min.y < b.max.y - eps && a.max.y > b.min.y + eps && a.min.z < b.max.z - eps && a.max.z > b.min.z + eps;
}

/** Caixa do jogador: centro horizontal em (x,z), pés em y. */
export function playerBox(pos: Vec3, halfWidth: number, height: number): AABB {
  return { min: { x: pos.x - halfWidth, y: pos.y, z: pos.z - halfWidth }, max: { x: pos.x + halfWidth, y: pos.y + height, z: pos.z + halfWidth } };
}

/**
 * Mundo de colisão com grade espacial uniforme (broadphase), para consultas O(1) por célula
 * mesmo com centenas de caixas. Usado pelo movimento e pelos tiros.
 */
export class CollisionWorld {
  /** Célula → índices das caixas. Chave numérica (x, z empacotados): sem montar strings a cada consulta. */
  private cells = new Map<number, number[]>();
  /** Marca de "já visto" por caixa; trocar o número da consulta zera tudo sem alocar um Set. */
  private seen: Uint32Array;
  private stamp = 0;
  constructor(public readonly boxes: AABB[], private readonly cellSize = 4) {
    this.seen = new Uint32Array(boxes.length);
    boxes.forEach((b, i) => {
      this.forCells(b, (key) => {
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(i);
      });
    });
  }

  private static key(x: number, z: number) {
    return (x + 32768) * 65536 + (z + 32768);
  }

  private forCells(b: AABB, fn: (key: number) => void) {
    const c = this.cellSize;
    const x1 = Math.floor(b.max.x / c);
    const z0 = Math.floor(b.min.z / c);
    const z1 = Math.floor(b.max.z / c);
    for (let x = Math.floor(b.min.x / c); x <= x1; x++) for (let z = z0; z <= z1; z++) fn(CollisionWorld.key(x, z));
  }

  private nextStamp() {
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    return this.stamp;
  }

  /** Caixas que podem tocar a região informada (na mesma ordem de sempre: célula a célula, sem repetir). */
  query(region: AABB): AABB[] {
    const stamp = this.nextStamp();
    const out: AABB[] = [];
    const c = this.cellSize;
    const x1 = Math.floor(region.max.x / c);
    const z0 = Math.floor(region.min.z / c);
    const z1 = Math.floor(region.max.z / c);
    for (let x = Math.floor(region.min.x / c); x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const list = this.cells.get(CollisionWorld.key(x, z));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const i = list[k]!;
          if (this.seen[i] === stamp) continue;
          this.seen[i] = stamp;
          out.push(this.boxes[i]!);
        }
      }
    return out;
  }

  collides(box: AABB): boolean {
    const stamp = this.nextStamp();
    const c = this.cellSize;
    const x1 = Math.floor(box.max.x / c);
    const z0 = Math.floor(box.min.z / c);
    const z1 = Math.floor(box.max.z / c);
    for (let x = Math.floor(box.min.x / c); x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const list = this.cells.get(CollisionWorld.key(x, z));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const i = list[k]!;
          if (this.seen[i] === stamp) continue;
          this.seen[i] = stamp;
          if (overlaps(box, this.boxes[i]!, 1e-6)) return true;
        }
      }
    return false;
  }
}
