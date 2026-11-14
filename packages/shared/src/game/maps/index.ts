import { NEON_DISTRICT } from "./neon-district.js";
import { DESERT_PROTOCOL } from "./desert-protocol.js";
import { FROST_BASE } from "./frost-base.js";
import { BLACKOUT_LAB } from "./blackout-lab.js";
import { ORBITAL_ZERO } from "./orbital-zero.js";
import type { MapDefinition } from "./types.js";

export * from "./types.js";
export * from "./builder.js";
export { NEON_DISTRICT, DESERT_PROTOCOL, FROST_BASE, BLACKOUT_LAB, ORBITAL_ZERO };

/** Registro de mapas jogáveis (os 5 do jogo). A ordem é a da rotação da fila. */
export const MAP_REGISTRY: Record<string, MapDefinition> = { NEON_DISTRICT, DESERT_PROTOCOL, FROST_BASE, BLACKOUT_LAB, ORBITAL_ZERO };
export const MAP_ROTATION = Object.keys(MAP_REGISTRY);
export * from "./analysis.js";
