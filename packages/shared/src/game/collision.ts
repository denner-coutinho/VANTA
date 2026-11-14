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
  private cells = new Map<string, number[]>();
  constructor(public readonly boxes: AABB[], private readonly cellSize = 4) {
    boxes.forEach((b, i) => {
      for (const key of this.keysFor(b)) {
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(i);
      }
    });
  }

  private keysFor(b: AABB): string[] {
    const c = this.cellSize;
    const keys: string[] = [];
    for (let x = Math.floor(b.min.x / c); x <= Math.floor(b.max.x / c); x++)
      for (let z = Math.floor(b.min.z / c); z <= Math.floor(b.max.z / c); z++) keys.push(`${x},${z}`);
    return keys;
  }

  /** Caixas que podem tocar a região informada. */
  query(region: AABB): AABB[] {
    const seen = new Set<number>();
    const out: AABB[] = [];
    for (const key of this.keysFor(region)) {
      for (const i of this.cells.get(key) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        out.push(this.boxes[i]!);
      }
    }
    return out;
  }

  collides(box: AABB): boolean {
    return this.query(box).some((b) => overlaps(box, b, 1e-6));
  }
}
