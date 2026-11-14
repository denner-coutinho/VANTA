/**
 * As 15 patentes competitivas de VANTA: FRONTLINE.
 *
 * O "rating" exibido ao jogador (Pontos de Patente, PP) é separado do MMR oculto
 * usado pelo matchmaking (Fase 5). Aqui ficam apenas as faixas visuais/progressão.
 * Estes valores são a fonte da verdade para o seed do banco (tabela Rank).
 */
export type RankTier = "RECRUTA" | "COMBATENTE" | "ESPECIALISTA" | "ELITE" | "MESTRE" | "SUPREMO";

export interface RankDefinition {
  /** Ordem 1..15 */
  order: number;
  code: string;
  name: string;
  tier: RankTier;
  /** Divisão dentro do tier (I, II, III). Supremo não tem divisão. */
  division: number | null;
  /** Pontos de Patente mínimos para alcançar a patente. */
  minPoints: number;
  /** Cor principal (hex) usada no ícone e na interface. */
  color: string;
  /** Cor secundária (brilho / gradiente). */
  glow: string;
}

const TIER_COLORS: Record<RankTier, { color: string; glow: string }> = {
  RECRUTA: { color: "#8C96A8", glow: "#C9D1DE" },
  COMBATENTE: { color: "#3FBF7F", glow: "#9BF5C6" },
  ESPECIALISTA: { color: "#287BFF", glow: "#8CB8FF" },
  ELITE: { color: "#823BFF", glow: "#C3A0FF" },
  MESTRE: { color: "#FF9A2E", glow: "#FFD199" },
  SUPREMO: { color: "#FF2E63", glow: "#FFB3C6" },
};

const TIER_NAMES: Record<RankTier, string> = {
  RECRUTA: "Recruta",
  COMBATENTE: "Combatente",
  ESPECIALISTA: "Especialista",
  ELITE: "Elite",
  MESTRE: "Mestre",
  SUPREMO: "VANTA Supremo",
};

const ROMAN = ["I", "II", "III"] as const;

/** Cada patente custa um pouco mais que a anterior: curva suave e previsível. */
const LAYOUT: Array<[RankTier, number]> = [
  ["RECRUTA", 3],
  ["COMBATENTE", 3],
  ["ESPECIALISTA", 3],
  ["ELITE", 3],
  ["MESTRE", 2],
  ["SUPREMO", 1],
];

function buildRanks(): RankDefinition[] {
  const ranks: RankDefinition[] = [];
  let order = 1;
  let points = 0;
  for (const [tier, divisions] of LAYOUT) {
    for (let d = 0; d < divisions; d++) {
      const isSupreme = tier === "SUPREMO";
      ranks.push({
        order,
        code: isSupreme ? "VANTA_SUPREMO" : `${tier}_${d + 1}`,
        name: isSupreme ? TIER_NAMES[tier] : `${TIER_NAMES[tier]} ${ROMAN[d]}`,
        tier,
        division: isSupreme ? null : d + 1,
        minPoints: points,
        ...TIER_COLORS[tier],
      });
      // Degrau entre patentes: 100 PP nas primeiras, crescendo 25 PP por patente.
      points += 100 + (order - 1) * 25;
      order++;
    }
  }
  return ranks;
}

export const RANKS: readonly RankDefinition[] = Object.freeze(buildRanks());

export function rankForPoints(points: number): RankDefinition {
  let current = RANKS[0]!;
  for (const r of RANKS) {
    if (points >= r.minPoints) current = r;
    else break;
  }
  return current;
}

/** Progresso (0..1) dentro da patente atual. Supremo retorna 1. */
export function rankProgress(points: number): { rank: RankDefinition; next: RankDefinition | null; progress: number } {
  const rank = rankForPoints(points);
  const next = RANKS[rank.order] ?? null;
  if (!next) return { rank, next: null, progress: 1 };
  const span = next.minPoints - rank.minPoints;
  return { rank, next, progress: Math.min(1, Math.max(0, (points - rank.minPoints) / span)) };
}
