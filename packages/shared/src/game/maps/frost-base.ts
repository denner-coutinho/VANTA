import { SymmetricMapBuilder, box } from "./builder.js";

/**
 * MAPA 03 — FROST BASE
 * Base industrial congelada, 64 × 64 m. Galpão interno com corredores no centro-oeste,
 * pátio nevado com contêineres a leste e uma ponte rolante elevada sobre o pátio.
 */
const S = 32;
const b = new SymmetricMapBuilder(S);
const STEEL = "#6d7c8e", ICE = "#b8cfe0", CONT_A = "#3d6a8a", CONT_B = "#8a3d3d", SNOW = "#dfe8f0";

// Base A: abrigo com teto e duas saídas.
b.add("building", box(-8, 8, 0, 5, -32, -30), STEEL);
b.add("wall", box(-8, -7.4, 0, 4, -30, -25), STEEL);
b.add("wall", box(7.4, 8, 0, 4, -30, -25), STEEL);
b.add("roof", box(-8, 8, 4, 4.4, -30, -25), STEEL);
b.add("cover", box(-4, 4, 0, 2.6, -23, -22.4), ICE); // anteparo: sem linha de visão entre as bases

// Galpão interno (x −26..−8, z −20..−6): corredor em L com portas.
b.add("wall", box(-26, -8, 0, 4.5, -20.4, -20), STEEL);
b.add("wall", box(-26, -25.6, 0, 4.5, -20, -6), STEEL);
b.add("wall", box(-26, -19, 0, 4.5, -6.4, -6), STEEL);
b.add("wall", box(-16, -8, 0, 4.5, -6.4, -6), STEEL); // porta norte em x −19..−16
b.add("wall", box(-8.4, -8, 0, 4.5, -20, -15), STEEL);
b.add("wall", box(-8.4, -8, 0, 4.5, -12, -6), STEEL); // porta leste em z −15..−12
b.add("wall", box(-20, -14, 0, 4.5, -14, -13.6), STEEL); // divisória interna
b.add("roof", box(-26, -8, 4.5, 4.9, -20.4, -6), "#4a5666");
b.add("crate", box(-24, -22.5, 0, 1.3, -18.5, -17));
b.add("crate", box(-12, -10.5, 0, 1.3, -9, -7.5));

// Pátio leste com contêineres (2,6 m de altura).
b.add("building", box(12, 18, 0, 2.6, -20, -17.6), CONT_A);
b.add("building", box(22, 28, 0, 2.6, -14, -11.6), CONT_B);
b.add("building", box(10, 12.4, 0, 2.6, -10, -4), CONT_A);
b.add("building", box(12, 18, 2.6, 5.2, -20, -17.6), CONT_B); // contêiner empilhado
b.add("cover", box(20, 24, 0, 1.0, -24, -23.4), ICE);

// Ponte rolante (passarela a 3 m) sobre o pátio, com escada.
b.add("walkway", box(18, 30, 2.7, 3, -6, -4), STEEL);
b.add("cover", box(18, 30, 3, 3.9, -4.3, -4), STEEL);
b.stairs(26, 30, -10, -6, 3, "-z", STEEL);

// Centro: tanque de combustível (cilindro aproximado por caixas) e barreiras.
b.addCenter("building", box(-2.5, 2.5, 0, 4, -2.5, 2.5), "#7d8a9a");
b.add("cover", box(-8, -4, 0, 1.1, -4.6, -4), ICE);
b.add("crate", box(4, 5.5, 0, 1.3, -9, -7.5));

b.light({ pos: { x: 0, y: 4, z: -27 }, color: "#BFE3FF", intensity: 9, distance: 14 });
b.light({ pos: { x: -17, y: 4, z: -13 }, color: "#8FD0FF", intensity: 10, distance: 14 });
b.light({ pos: { x: 22, y: 6, z: -12 }, color: "#E8F4FF", intensity: 10, distance: 18 });
b.light({ pos: { x: 0, y: 6, z: 0 }, color: "#9AD8FF", intensity: 10, distance: 16 }, true);
b.neon({ pos: { x: 0, y: 3.4, z: -30.05 }, size: [4, 0.5], rotY: 0, color: "#7FD4FF", text: "ABRIGO A" });
b.neon({ pos: { x: -17, y: 3.9, z: -5.95 }, size: [4, 0.5], rotY: Math.PI, color: "#BFE3FF", text: "GALPÃO" });
b.neon({ pos: { x: 15, y: 1.6, z: -17.55 }, size: [3, 0.4], rotY: 0, color: "#FF5A5A", text: "PERIGO" });

export const FROST_BASE = b.build({
  code: "FROST_BASE",
  name: "Frost Base",
  description: "Base industrial congelada: galpão com corredores, pátio de contêineres e ponte rolante.",
  spawnsA: [{ x: 0, y: 0, z: -27.5 }, { x: -3, y: 0, z: -27.5 }, { x: 3, y: 0, z: -27.5 }],
  spawnYaw: { A: Math.PI, B: 0 },
  wallColor: "#5a6878",
  groundColor: SNOW,
  atmosphere: { sky: "#7f93a8", fog: "#a9bccd", fogDensity: 0.026, ambient: "#c8dcf0", groundColor: SNOW, theme: "frost", sun: { color: "#e8f2ff", intensity: 1.4, dir: { x: 0.3, y: 0.7, z: -0.4 } } },
});
