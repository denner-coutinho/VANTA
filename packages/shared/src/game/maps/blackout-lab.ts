import { SymmetricMapBuilder, box } from "./builder.js";

/**
 * MAPA 04 — BLACKOUT LAB
 * Laboratório subterrâneo, 56 × 56 m, inteiramente coberto (teto a 5 m). Salas escuras ligadas por
 * corredores, iluminação de emergência que pisca, sala de contenção central com janelas baixas.
 * As portas são vãos abertos (portas automáticas animadas ficam fora desta versão).
 */
const S = 28;
const b = new SymmetricMapBuilder(S);
const WALL = "#3c4450", LAB = "#5a6470", DESK = "#2a3038", GLASS = "#3a5a66";
const H = 5;

// Sala de entrada A (spawn) com duas saídas.
b.add("wall", box(-9, -6, 0, H, -20, -19.6), WALL);
b.add("wall", box(-3, 3, 0, H, -20, -19.6), WALL);
b.add("wall", box(6, 9, 0, H, -20, -19.6), WALL);
b.add("wall", box(-9, -8.6, 0, H, -28, -20), WALL);
b.add("wall", box(8.6, 9, 0, H, -28, -20), WALL);

// Ala oeste: laboratório com bancadas.
b.add("wall", box(-28, -14, 0, H, -10.4, -10), WALL);
b.add("wall", box(-14.4, -14, 0, H, -20, -16), WALL);
b.add("wall", box(-14.4, -14, 0, H, -13, -10), WALL); // porta em z −16..−13
b.add("cover", box(-24, -18, 0, 1.0, -17, -16), DESK);
b.add("cover", box(-24, -18, 0, 1.0, -14, -13), DESK);
b.add("building", box(-28, -24, 0, 2.2, -24, -20), LAB); // armários

// Ala leste: sala de servidores (corredores estreitos entre racks).
b.add("building", box(14, 15, 0, 2.4, -22, -12), "#20262e");
b.add("building", box(18, 19, 0, 2.4, -22, -12), "#20262e");
b.add("building", box(22, 23, 0, 2.4, -22, -12), "#20262e");
b.add("wall", box(12, 28, 0, H, -8.4, -8), WALL);
b.add("wall", box(12, 12.4, 0, H, -24, -15), WALL); // porta em z −15..−11
b.add("wall", box(12, 12.4, 0, H, -11, -8), WALL);

// Corredor central e sala de contenção (centro), com mureta de vidro baixa.
b.add("wall", box(-6, 6, 0, H, -6.4, -6), WALL);
b.add("cover", box(-6, -2, 0, 1.2, 4, 4.2), GLASS); // espelhada → lado sul
b.add("wall", box(-6.4, -6, 0, H, -6, -2), WALL);
b.addCenter("building", box(-1.5, 1.5, 0, H, -1.5, 1.5), "#202830"); // pilar/núcleo do reator
b.add("crate", box(-10, -8.5, 0, 1.3, -4, -2.5));
b.add("crate", box(16, 17.5, 0, 1.3, -5, -3.5));
b.add("cover", box(-20, -16, 0, 1.0, -4, -3.4), DESK);

// Teto do laboratório inteiro.
b.addCenter("roof", box(-S, S, H, H + 0.5, -S, S), "#1a1e24");

b.light({ pos: { x: 0, y: 4.5, z: -24 }, color: "#FF3B4E", intensity: 7, distance: 12 });
b.light({ pos: { x: -21, y: 4.5, z: -15 }, color: "#2ED3E6", intensity: 7, distance: 12 });
b.light({ pos: { x: 18, y: 4.5, z: -16 }, color: "#3FE08F", intensity: 6, distance: 12 });
b.light({ pos: { x: -10, y: 4.5, z: -2 }, color: "#FF3B4E", intensity: 6, distance: 10 });
b.light({ pos: { x: 0, y: 4.5, z: 0 }, color: "#2ED3E6", intensity: 9, distance: 12 }, true);
b.neon({ pos: { x: 0, y: 4.2, z: -19.55 }, size: [4, 0.4], rotY: Math.PI, color: "#FF3B4E", text: "SAÍDA" });
b.neon({ pos: { x: -14.45, y: 3.2, z: -18 }, size: [2.6, 0.5], rotY: -Math.PI / 2, color: "#2ED3E6", text: "LAB 2" });
b.neon({ pos: { x: 0, y: 3.4, z: -1.55 }, size: [2.4, 0.5], rotY: Math.PI, color: "#2ED3E6", text: "NÚCLEO" });

export const BLACKOUT_LAB = b.build({
  code: "BLACKOUT_LAB",
  name: "Blackout Lab",
  description: "Laboratório secreto coberto: salas escuras, corredores estreitos e luz de emergência.",
  spawnsA: [{ x: 0, y: 0, z: -25 }, { x: -3, y: 0, z: -25 }, { x: 3, y: 0, z: -25 }],
  spawnYaw: { A: Math.PI, B: 0 },
  wallColor: WALL,
  groundColor: "#2c323a",
  wallHeight: H,
  ceiling: H,
  atmosphere: { sky: "#020304", fog: "#080b10", fogDensity: 0.02, ambient: "#6a7c92", groundColor: "#2c323a", theme: "lab" },
});
