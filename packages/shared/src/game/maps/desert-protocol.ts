import { SymmetricMapBuilder, box } from "./builder.js";

/**
 * MAPA 02 — DESERT PROTOCOL
 * Instalação militar no deserto ao entardecer, 72 × 72 m. Linhas de visão longas no corredor leste,
 * túnel coberto atravessando a duna central, torre de observação acessível por escada e bunkers.
 */
const S = 36;
const b = new SymmetricMapBuilder(S);
const SAND = "#8a6a48", CONCRETE = "#7a7266", RUST = "#7a4a2e", BAG = "#9c8460";

// Base A (sul): bunker em U com saídas laterais.
b.add("building", box(-10, 10, 0, 4, -36, -33), CONCRETE);
b.add("wall", box(-10, -9.4, 0, 3, -33, -27), CONCRETE);
b.add("wall", box(9.4, 10, 0, 3, -33, -27), CONCRETE);
b.add("cover", box(-4.5, 4.5, 0, 2.6, -25.5, -24.8), BAG); // muro de sacos de areia: bloqueia a visão base-a-base

// Duna central com túnel (x −3..3) coberto.
b.add("building", box(-16, -3, 0, 3.2, -2, 0), SAND);
b.addCenter("roof", box(-3, 3, 3.2, 3.6, -2, 2), CONCRETE);
b.addCenter("cover", box(-0.6, 0.6, 0, 1.0, -0.6, 0.6), RUST); // caixa no meio do túnel

// Torre de observação sudeste (plataforma a 3,75 m) com escada.
b.add("walkway", box(20, 26, 3.45, 3.75, -20, -14), CONCRETE);
b.add("cover", box(20, 26, 3.75, 4.75, -14.3, -14), CONCRETE); // parapeito voltado ao centro
b.add("wall", box(20, 20.5, 0, 3.45, -20, -16), CONCRETE);
b.add("wall", box(25.5, 26, 0, 3.45, -20, -14), CONCRETE);
b.stairs(15, 20, -20, -18, 3.75, "+x", CONCRETE);

// Corredor oeste: hangar com duas portas.
b.add("building", box(-30, -18, 0, 7, -24, -22), RUST);
b.add("building", box(-30, -18, 0, 7, -12, -10), RUST);
b.add("wall", box(-30, -29.4, 0, 7, -22, -12), RUST);
b.add("roof", box(-30, -18, 7, 7.4, -24, -10), RUST);
b.add("cover", box(-25, -23, 0, 1.4, -18, -16), "#5a4430");

// Coberturas espalhadas.
b.add("crate", box(4, 6, 0, 1.5, -18, -16));
b.add("crate", box(-8, -6, 0, 1.2, -12, -10));
b.add("crate", box(-8, -6, 1.2, 2.4, -12, -10));
b.add("cover", box(10, 14, 0, 1.0, -8, -7.4), BAG);
b.add("cover", box(28, 30, 0, 1.2, -6, -4), BAG);
b.add("crate", box(30, 32, 0, 1.5, -26, -24));
b.add("cover", box(-16, -12, 0, 1.0, -28, -27.4), BAG);

b.light({ pos: { x: 0, y: 4.5, z: -30 }, color: "#FFB547", intensity: 10, distance: 14 });
b.light({ pos: { x: 23, y: 6, z: -17 }, color: "#FF9A2E", intensity: 10, distance: 14 });
b.light({ pos: { x: -24, y: 5, z: -17 }, color: "#FFD08A", intensity: 8, distance: 14 });
b.light({ pos: { x: 0, y: 2.6, z: 0 }, color: "#FF9A2E", intensity: 6, distance: 8 }, true);
b.neon({ pos: { x: 0, y: 3.4, z: -33.05 }, size: [5, 0.6], rotY: 0, color: "#FF9A2E", text: "SETOR A" });
b.neon({ pos: { x: -18.05, y: 4.8, z: -17 }, size: [4, 0.8], rotY: Math.PI / 2, color: "#FFB547", text: "HANGAR 3" });
b.neon({ pos: { x: 0, y: 3.0, z: -2.05 }, size: [3.6, 0.4], rotY: 0, color: "#FF5A2E", text: "TÚNEL" });

export const DESERT_PROTOCOL = b.build({
  code: "DESERT_PROTOCOL",
  name: "Desert Protocol",
  description: "Instalação militar no deserto: túnel sob a duna, torre de observação e corredores longos.",
  spawnsA: [{ x: 0, y: 0, z: -30 }, { x: -3, y: 0, z: -30 }, { x: 3, y: 0, z: -30 }],
  spawnYaw: { A: Math.PI, B: 0 },
  wallColor: "#6a5038",
  groundColor: SAND,
  atmosphere: { sky: "#c27a4a", fog: "#b07a52", fogDensity: 0.011, ambient: "#d8a878", groundColor: SAND, theme: "desert", sun: { color: "#ffc58a", intensity: 2.4, dir: { x: -0.6, y: 0.45, z: -0.3 } } },
});
