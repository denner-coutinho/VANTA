import { SymmetricMapBuilder, box } from "./builder.js";

/**
 * MAPA 05 — ORBITAL ZERO
 * Estação espacial, 64 × 64 m. Corredores com janelas para o vazio e, no centro, o setor de
 * gravidade reduzida (40% da gravidade): plataformas altas que só se alcançam com o pulo longo.
 */
const S = 32;
const b = new SymmetricMapBuilder(S);
const HULL = "#4a5266", PANEL = "#6a7488", DARK = "#262c3a";

// Módulo de acoplamento A (spawn).
b.add("building", box(-8, 8, 0, 6, -32, -30), HULL);
b.add("wall", box(-8, -7.4, 0, 5, -30, -24), HULL);
b.add("wall", box(7.4, 8, 0, 5, -30, -24), HULL);
b.add("roof", box(-8, 8, 5, 5.4, -30, -24), DARK);
b.add("cover", box(-4, 4, 0, 2.6, -22, -21.4), PANEL); // anteparo da doca

// Anel de corredores: paredes externas dos braços oeste e leste.
b.add("wall", box(-24, -12, 0, 5, -20.4, -20), HULL);
b.add("wall", box(-24, -23.6, 0, 5, -20, -10), HULL);
b.add("wall", box(-16, -15.6, 0, 5, -16, -6), HULL);
b.add("roof", box(-24, -15.6, 5, 5.3, -20.4, -10), DARK);
b.add("wall", box(12, 24, 0, 5, -20.4, -20), HULL);
b.add("wall", box(23.6, 24, 0, 5, -20, -12), HULL);
b.add("building", box(15.6, 19, 0, 3, -14, -8), PANEL); // módulo de carga
b.add("crate", box(20, 21.5, 0, 1.4, -6, -4.5));
b.add("crate", box(-21, -19.5, 0, 1.4, -6, -4.5));

// Setor central de gravidade reduzida: plataformas a 2,3 m e 4,6 m (alcançáveis só com 40% da gravidade).
b.add("walkway", box(-7, -3, 2.0, 2.3, -7, -4), PANEL);
b.addCenter("walkway", box(-2, 2, 4.3, 4.6, -2, 2), PANEL);
b.add("cover", box(3, 6, 0, 1.2, -3, -2.4), DARK);
b.add("cover", box(-10, -9.4, 0, 1.2, -10, -6), DARK);

b.light({ pos: { x: 0, y: 4.5, z: -27 }, color: "#5C9BFF", intensity: 9, distance: 14 });
b.light({ pos: { x: -20, y: 4.5, z: -15 }, color: "#823BFF", intensity: 8, distance: 14 });
b.light({ pos: { x: 20, y: 4.5, z: -15 }, color: "#2ED3E6", intensity: 8, distance: 14 });
b.light({ pos: { x: 0, y: 8, z: 0 }, color: "#9A7BFF", intensity: 16, distance: 20 }, true);
b.neon({ pos: { x: 0, y: 4.4, z: -30.05 }, size: [5, 0.5], rotY: 0, color: "#5C9BFF", text: "DOCA A" });
b.neon({ pos: { x: -23.55, y: 3, z: -15 }, size: [6, 2.2], rotY: Math.PI / 2, color: "#0a1430" }); // janela para o espaço
b.neon({ pos: { x: 23.55, y: 3, z: -16 }, size: [6, 2.2], rotY: -Math.PI / 2, color: "#0a1430" });
b.neon({ pos: { x: 0, y: 7.5, z: 0 }, size: [6, 0.4], rotY: 0, color: "#9A7BFF", text: "GRAVIDADE 40%" }, true);

export const ORBITAL_ZERO = b.build({
  code: "ORBITAL_ZERO",
  name: "Orbital Zero",
  description: "Estação espacial: corredores com janelas para o vazio e setor central de gravidade reduzida.",
  spawnsA: [{ x: 0, y: 0, z: -27 }, { x: -3, y: 0, z: -27 }, { x: 3, y: 0, z: -27 }],
  spawnYaw: { A: Math.PI, B: 0 },
  wallColor: HULL,
  groundColor: "#3a4152",
  wallHeight: 10,
  ceiling: 12,
  zones: [{ box: box(-10, 10, 0, 12, -10, 10), gravityScale: 0.4, label: "Setor de gravidade reduzida" }],
  atmosphere: { sky: "#010208", fog: "#05060f", fogDensity: 0.012, ambient: "#8496c8", groundColor: "#3a4152", theme: "orbital" },
});
