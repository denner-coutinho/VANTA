import type { AABB } from "../collision.js";
import type { Vec3 } from "../math.js";
import type { MapDefinition, MapLight, MapZone, NeonProp, Solid, SolidKind } from "./types.js";

/** Caixa por limites: x0..x1, y0..y1, z0..z1. */
export const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): AABB => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });

const mirrorBox = (b: AABB): AABB => ({ min: { x: -b.max.x, y: b.min.y, z: -b.max.z }, max: { x: -b.min.x, y: b.max.y, z: -b.min.z } });
const mirrorPos = (p: Vec3): Vec3 => ({ x: -p.x, y: p.y, z: -p.z });

/**
 * Monta um mapa simétrico por rotação de 180° em torno do eixo Y: descreve-se só a metade
 * do time A (z < 0); a metade do time B é gerada espelhando. Nenhum lado tem vantagem de geometria.
 */
export class SymmetricMapBuilder {
  private half: Solid[] = [];
  private center: Solid[] = [];
  private neonHalf: NeonProp[] = [];
  private neonCenter: NeonProp[] = [];
  private lightsHalf: MapLight[] = [];
  private lightsCenter: MapLight[] = [];

  constructor(readonly size: number) {}

  /** Sólido na metade A (será espelhado). */
  add(kind: SolidKind, b: AABB, color?: string) {
    this.half.push({ kind, box: b, color });
    return this;
  }
  /** Sólido central (deve ser simétrico por si só). */
  addCenter(kind: SolidKind, b: AABB, color?: string) {
    this.center.push({ kind, box: b, color });
    return this;
  }
  /** Escada de degraus de 0,375 m (abaixo do stepHeight) subindo de y=0 até `height`, no sentido indicado. */
  stairs(x0: number, x1: number, z0: number, z1: number, height: number, dir: "+x" | "-x" | "+z" | "-z", color?: string) {
    const n = Math.ceil(height / 0.375);
    const along = dir === "+x" || dir === "-x" ? x1 - x0 : z1 - z0;
    const stepLen = along / n;
    for (let i = 0; i < n; i++) {
      const h = Math.min(height, (i + 1) * 0.375);
      let b: AABB;
      if (dir === "+x") b = box(x0 + i * stepLen, x1, 0, h, z0, z1);
      else if (dir === "-x") b = box(x0, x1 - i * stepLen, 0, h, z0, z1);
      else if (dir === "+z") b = box(x0, x1, 0, h, z0 + i * stepLen, z1);
      else b = box(x0, x1, 0, h, z0, z1 - i * stepLen);
      this.add("stair", b, color);
    }
    return this;
  }
  neon(n: NeonProp, center = false) {
    (center ? this.neonCenter : this.neonHalf).push(n);
    return this;
  }
  light(l: MapLight, center = false) {
    (center ? this.lightsCenter : this.lightsHalf).push(l);
    return this;
  }

  build(def: Omit<MapDefinition, "solids" | "neon" | "lights" | "bounds" | "spawns" | "training"> & {
    spawnsA: Vec3[];
    wallColor: string;
    groundColor: string;
    wallHeight?: number;
    ceiling?: number;
    zones?: MapZone[];
    training?: MapDefinition["training"];
  }): MapDefinition {
    const s = this.size;
    const solids: Solid[] = [...this.half, ...this.half.map((x) => ({ ...x, box: mirrorBox(x.box) })), ...this.center];
    const wh = def.wallHeight ?? 14;
    const ceil = def.ceiling ?? 18;
    solids.push({ kind: "ground", box: box(-s, s, -1, 0, -s, s), color: def.groundColor });
    solids.push({ kind: "wall", box: box(-s - 1, -s, 0, wh, -s - 1, s + 1), color: def.wallColor });
    solids.push({ kind: "wall", box: box(s, s + 1, 0, wh, -s - 1, s + 1), color: def.wallColor });
    solids.push({ kind: "wall", box: box(-s - 1, s + 1, 0, wh, -s - 1, -s), color: def.wallColor });
    solids.push({ kind: "wall", box: box(-s - 1, s + 1, 0, wh, s, s + 1), color: def.wallColor });
    solids.push({ kind: "roof", box: box(-s - 1, s + 1, ceil, ceil + 1, -s - 1, s + 1) });
    const neon = [...this.neonHalf, ...this.neonHalf.map((n) => ({ ...n, pos: mirrorPos(n.pos), rotY: n.rotY + Math.PI })), ...this.neonCenter];
    const lights = [...this.lightsHalf, ...this.lightsHalf.map((l) => ({ ...l, pos: mirrorPos(l.pos) })), ...this.lightsCenter];
    const { spawnsA, wallColor: _w, groundColor: _g, wallHeight: _h, ceiling: _c, training, ...rest } = def;
    return {
      ...rest,
      bounds: box(-s, s, 0, ceil, -s, s),
      solids,
      neon,
      lights,
      spawns: { A: spawnsA, B: spawnsA.map(mirrorPos) },
      training: training ?? { targets: [], droneSpawns: [{ x: 0, y: 4.5, z: 0 }] },
    };
  }
}
