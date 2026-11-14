import { NEON_DISTRICT } from "./neon-district.js";
import type { MapDefinition } from "./types.js";

export * from "./types.js";
export { NEON_DISTRICT };

/** Registro de mapas jogáveis. Os outros 4 entram na Fase 4 com o mesmo formato. */
export const MAP_REGISTRY: Record<string, MapDefinition> = { NEON_DISTRICT };
