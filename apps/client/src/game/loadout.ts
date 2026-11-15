import { DEFAULT_LOADOUT } from "@vanta/shared";

/** Arsenal escolhido (o mesmo no treino e nas partidas), guardado no navegador. */
export const LOADOUT_KEY = "vanta.trainingLoadout";

export function loadLoadout(): string[] {
  try {
    const l = JSON.parse(localStorage.getItem(LOADOUT_KEY) ?? "null");
    return Array.isArray(l) && l.length === 3 && l.every((x) => typeof x === "string") ? l : DEFAULT_LOADOUT;
  } catch {
    return DEFAULT_LOADOUT;
  }
}

export function saveLoadout(next: string[]) {
  try {
    localStorage.setItem(LOADOUT_KEY, JSON.stringify(next));
  } catch {
    /* sem armazenamento */
  }
}
