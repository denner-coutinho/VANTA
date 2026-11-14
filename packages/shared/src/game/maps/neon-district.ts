import { aabbFromCenter, type AABB } from "../collision.js";
import type { MapDefinition, MapLight, NeonProp, Solid, SolidKind } from "./types.js";

/**
 * MAPA 01 — NEON DISTRICT
 * Cidade futurista abandonada, 64 × 64 m. O layout é simétrico por rotação de 180° em torno do centro:
 * o que o time A tem ao sul, o time B tem igual ao norte (nenhum lado com vantagem de geometria).
 *
 * Rotas: beco oeste estreito (curta distância), galeria interna coberta (portas laterais),
 * passarela elevada leste (linha de visão longa sobre a praça) e praça central com monumento.
 */
const half: Solid[] = [];
const neonHalf: NeonProp[] = [];
const lightsHalf: MapLight[] = [];

/** Caixa por limites: x0..x1, y0..y1, z0..z1. */
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): AABB => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });
const add = (kind: SolidKind, b: AABB, color?: string) => half.push({ kind, box: b, color });

// ── Prédios do lado sul ──
add("building", box(-32, -18, 0, 11, -26, -12), "#151a28");   // bloco oeste (forma o beco)
add("building", box(-32, -24, 0, 7, -12, -6), "#1a2030");     // anexo baixo no beco
add("building", box(12, 32, 0, 13, -26, -14), "#141927");     // torre leste
add("building", box(26, 32, 0, 6, -14, -4), "#1b2132");       // loja leste
add("building", box(-6, 6, 0, 9, -32, -27), "#161b2a");       // fundo da base A

// ── Galeria interna (x −10..2, z −22..−12), paredes de 0,4 m com portas ──
const gx0 = -10, gx1 = 2, gz0 = -22, gz1 = -12, gh = 4, t = 0.4;
add("wall", box(gx0, gx1, 0, gh, gz0, gz0 + t));                       // parede sul
add("wall", box(gx0, -6, 0, gh, gz1 - t, gz1));                        // parede norte, com porta central de 2,5 m
add("wall", box(-3.5, gx1, 0, gh, gz1 - t, gz1));
add("wall", box(gx0, gx0 + t, 0, gh, gz0, -18.5));                     // parede oeste, porta de 2 m
add("wall", box(gx0, gx0 + t, 0, gh, -16.5, gz1));
add("wall", box(gx1 - t, gx1, 0, gh, gz0, -15.5));                     // parede leste, porta de 2 m
add("wall", box(gx1 - t, gx1, 0, gh, -13.5, gz1));
add("roof", box(gx0, gx1, gh, gh + 0.3, gz0, gz1), "#10141f");
add("cover", box(-7, -5, 0, 1.1, -19, -18), "#2a3348");               // balcão interno
add("cover", box(-1.5, 0.5, 0, 1.1, -17, -16), "#2a3348");

// ── Passarela elevada leste (y = 3) com escada ──
add("walkway", box(6, 20, 2.7, 3, -10, -7.5), "#1d2436");
add("walkway", box(18, 20, 2.7, 3, -14, -10), "#1d2436");               // liga à torre
add("cover", box(6, 20, 3, 4.0, -7.6, -7.5), "#283149");                // guarda-corpo (meia altura de cobertura)
for (let i = 0; i < 8; i++) {
  // Escada descendo para oeste: 8 degraus de 0,375 m (abaixo do stepHeight de 0,42 m).
  const h = 3 - (i + 1) * 0.375;
  if (h <= 0) break;
  add("stair", box(6 - (i + 1) * 0.8, 6 - i * 0.8, 0, h, -10, -7.5), "#222a3d");
}
add("building", box(6, 20, 0, 2.7, -10, -9.6), "#1a2030");             // fechamento sob a passarela (sem atravessar por baixo no meio)

// ── Coberturas na rua sul e no beco ──
add("crate", box(-16, -14.5, 0, 1.5, -20, -18.5));
add("crate", box(-16, -14.5, 0, 1.5, -18.5, -17));
add("crate", box(-16, -14.5, 1.5, 3.0, -20, -18.5));
add("crate", box(-21, -19, 0, 1.2, -4, -2));
add("crate", box(6, 8, 0, 1.4, -20, -18));
add("crate", box(9, 10.5, 0, 1.0, -4, -2.5));
add("cover", box(-3, 3, 0, 1.0, -26, -25.4), "#2a3348");               // barreira da base A
add("cover", box(-16, -12, 0, 1.0, -8, -7.4), "#2a3348");

// ── Neon (visual) ──
neonHalf.push({ pos: { x: -18.05, y: 6.5, z: -19 }, size: [5, 1.4], rotY: Math.PI / 2, color: "#287BFF", text: "NEXUS" });
neonHalf.push({ pos: { x: 11.95, y: 8, z: -20 }, size: [1.2, 6], rotY: -Math.PI / 2, color: "#823BFF", text: "HOTEL" });
neonHalf.push({ pos: { x: -4, y: 3.2, z: -11.95 }, size: [4, 0.5], rotY: 0, color: "#2ED3E6", text: "GALERIA" });
neonHalf.push({ pos: { x: 25.95, y: 4.5, z: -9 }, size: [3, 1], rotY: -Math.PI / 2, color: "#FF2E63", text: "24H" });
neonHalf.push({ pos: { x: 0, y: 7, z: -26.95 }, size: [6, 0.35], rotY: 0, color: "#287BFF" });
lightsHalf.push({ pos: { x: -16, y: 5, z: -16 }, color: "#287BFF", intensity: 14, distance: 16 });
lightsHalf.push({ pos: { x: -4, y: 3.4, z: -17 }, color: "#2ED3E6", intensity: 6, distance: 10 });
lightsHalf.push({ pos: { x: 14, y: 6, z: -12 }, color: "#823BFF", intensity: 14, distance: 16 });
lightsHalf.push({ pos: { x: 0, y: 6, z: -24 }, color: "#5C9BFF", intensity: 10, distance: 14 });

// Espelha (rotação de 180° em torno do eixo Y): garante equilíbrio entre os times.
const mirrorBox = (b: AABB): AABB => ({ min: { x: -b.max.x, y: b.min.y, z: -b.max.z }, max: { x: -b.min.x, y: b.max.y, z: -b.min.z } });
const solids: Solid[] = [...half, ...half.map((s) => ({ ...s, box: mirrorBox(s.box) }))];
const neon: NeonProp[] = [...neonHalf, ...neonHalf.map((n) => ({ ...n, pos: { x: -n.pos.x, y: n.pos.y, z: -n.pos.z }, rotY: n.rotY + Math.PI }))];
const lights: MapLight[] = [...lightsHalf, ...lightsHalf.map((l) => ({ ...l, pos: { x: -l.pos.x, y: l.pos.y, z: -l.pos.z } }))];

// ── Elementos centrais (já simétricos) ──
solids.push({ kind: "cover", box: aabbFromCenter(0, 0.7, 0, 2.4, 1.4, 2.4), color: "#2a3348" });          // monumento
solids.push({ kind: "cover", box: aabbFromCenter(0, 2.2, 0, 0.6, 1.6, 0.6), color: "#323b50" });          // obelisco
solids.push({ kind: "crate", box: aabbFromCenter(-6, 0.6, 3, 1.4, 1.2, 1.4) });
solids.push({ kind: "crate", box: aabbFromCenter(6, 0.6, -3, 1.4, 1.2, 1.4) });
neon.push({ pos: { x: 0, y: 3.1, z: 0 }, size: [0.5, 0.5], rotY: 0, color: "#823BFF" });
lights.push({ pos: { x: 0, y: 4.5, z: 0 }, color: "#823BFF", intensity: 18, distance: 18 });

// ── Chão e limites ──
solids.push({ kind: "ground", box: box(-32, 32, -1, 0, -32, 32), color: "#0c0f18" });
solids.push({ kind: "wall", box: box(-33, -32, 0, 14, -33, 33), color: "#0f131e" });
solids.push({ kind: "wall", box: box(32, 33, 0, 14, -33, 33), color: "#0f131e" });
solids.push({ kind: "wall", box: box(-33, 33, 0, 14, -33, -32), color: "#0f131e" });
solids.push({ kind: "wall", box: box(-33, 33, 0, 14, 32, 33), color: "#0f131e" });
// Teto invisível alto: impede escalar para fora do mapa.
solids.push({ kind: "roof", box: box(-33, 33, 18, 19, -33, 33) });

export const NEON_DISTRICT: MapDefinition = {
  code: "NEON_DISTRICT",
  name: "Neon District",
  bounds: box(-32, 32, 0, 18, -32, 32),
  solids,
  neon,
  lights,
  spawns: {
    A: [{ x: 5, y: 0, z: -24 }, { x: 8, y: 0, z: -24 }, { x: 6.5, y: 0, z: -22.5 }],
    B: [{ x: -5, y: 0, z: 24 }, { x: -8, y: 0, z: 24 }, { x: -6.5, y: 0, z: 22.5 }],
  },
  spawnYaw: { A: Math.PI, B: 0 },
  training: {
    targets: [
      { pos: { x: 5, y: 0, z: -13 } },                                            // 11 m, rua leste
      { pos: { x: -14, y: 0, z: -14 } },                                          // beco oeste
      { pos: { x: 4, y: 0, z: -6 } },                                             // ~18 m
      { pos: { x: -8, y: 0, z: 6 }, rail: { axis: "x", amplitude: 3, speed: 1.4 } }, // móvel na praça
      { pos: { x: 0, y: 0, z: 10 } },                                             // 34 m
      { pos: { x: -12, y: 3, z: 8.9 } },                                          // na passarela B (elevado, atrás do guarda-corpo)
      { pos: { x: -15, y: 0, z: 2 }, rail: { axis: "z", amplitude: 4, speed: 2.2 } },
      { pos: { x: -5, y: 0, z: 24 } },                                            // ~48 m, base B
      { pos: { x: 28, y: 7, z: 9 } },                                             // telhado do anexo B (longa distância)
    ],
    droneSpawns: [{ x: 0, y: 4.5, z: 4 }],
  },
  atmosphere: { sky: "#06070d", fog: "#0a0c16", fogDensity: 0.018, ambient: "#5a6a9a", groundColor: "#0c0f18" },
};
