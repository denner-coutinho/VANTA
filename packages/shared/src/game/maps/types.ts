import type { AABB } from "../collision.js";
import type { Vec3 } from "../math.js";

export type SolidKind = "ground" | "wall" | "building" | "crate" | "stair" | "walkway" | "roof" | "cover";

export interface Solid { box: AABB; kind: SolidKind; color?: string }

/** Elemento só visual (sem colisão): letreiros neon, faixas de luz. */
export interface NeonProp { pos: Vec3; size: [number, number]; rotY: number; color: string; text?: string }

export interface MapLight { pos: Vec3; color: string; intensity: number; distance: number }

export interface MapDefinition {
  code: string;
  name: string;
  bounds: AABB;
  solids: Solid[];
  neon: NeonProp[];
  lights: MapLight[];
  spawns: { A: Vec3[]; B: Vec3[] };
  /** Yaw inicial de cada time (olhando para o centro). */
  spawnYaw: { A: number; B: number };
  training: { targets: Array<{ pos: Vec3; rail?: { axis: "x" | "z"; amplitude: number; speed: number } }>; droneSpawns: Vec3[] };
  atmosphere: { sky: string; fog: string; fogDensity: number; ambient: string; groundColor: string };
}
