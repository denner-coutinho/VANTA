/**
 * Curva de níveis do jogador (XP de conta, separada da patente competitiva).
 * XP necessário para ir do nível n para n+1: 500 + 150·(n−1). Nível máximo: 200.
 */
export const MAX_PLAYER_LEVEL = 200;

export function xpToNextLevel(level: number): number {
  return 500 + 150 * (Math.max(1, level) - 1);
}

export function levelFromTotalXp(totalXp: number): { level: number; xpIntoLevel: number; xpForNext: number } {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  while (level < MAX_PLAYER_LEVEL && remaining >= xpToNextLevel(level)) {
    remaining -= xpToNextLevel(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpForNext: level >= MAX_PLAYER_LEVEL ? 0 : xpToNextLevel(level) };
}
