import { RANKS, rankForPoints } from "./ranks.js";

/**
 * Regras do competitivo, puras e determinísticas (usadas pelo servidor de jogo e pelos testes):
 *  - MMR oculto em Glicko-2 (rating, desvio e volatilidade);
 *  - Pontos de Patente (PP) visíveis, que convergem para o MMR;
 *  - partidas de classificação, sequência de vitórias, abandono;
 *  - janela de busca do matchmaking e balanceamento de equipes;
 *  - reinício parcial entre temporadas.
 * Nada aqui é decidido pelo cliente: o servidor calcula e grava.
 */

// ───────────────────────────── Glicko-2 ─────────────────────────────
export interface Rating {
  mmr: number;
  rd: number;
  vol: number;
}

export const GLICKO = { defaultMmr: 1500, defaultRd: 350, defaultVol: 0.06, tau: 0.5, scale: 173.7178, minRd: 45, maxRd: 350 } as const;
export const defaultRating = (): Rating => ({ mmr: GLICKO.defaultMmr, rd: GLICKO.defaultRd, vol: GLICKO.defaultVol });

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** Probabilidade de vitória de `a` contra `b` (considera a incerteza do adversário). */
export function winProbability(a: Rating, b: Rating): number {
  return E((a.mmr - 1500) / GLICKO.scale, (b.mmr - 1500) / GLICKO.scale, b.rd / GLICKO.scale);
}

/**
 * Atualização Glicko-2 (Glickman, 2012) para um período com os resultados informados.
 * `score`: 1 vitória, 0,5 empate, 0 derrota.
 */
export function glicko2Update(player: Rating, results: Array<{ opponent: Rating; score: number }>, tau: number = GLICKO.tau): Rating {
  const mu = (player.mmr - 1500) / GLICKO.scale;
  const phi = player.rd / GLICKO.scale;
  if (!results.length) {
    const phiStar = Math.sqrt(phi * phi + player.vol * player.vol);
    return { mmr: player.mmr, rd: Math.min(GLICKO.maxRd, phiStar * GLICKO.scale), vol: player.vol };
  }
  let vInv = 0;
  let deltaSum = 0;
  for (const r of results) {
    const muJ = (r.opponent.mmr - 1500) / GLICKO.scale;
    const phiJ = r.opponent.rd / GLICKO.scale;
    const gj = g(phiJ);
    const e = E(mu, muJ, phiJ);
    vInv += gj * gj * e * (1 - e);
    deltaSum += gj * (r.score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Nova volatilidade (método de Illinois).
  const a = Math.log(player.vol * player.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * (phi * phi + v + ex) ** 2;
    return num / den - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const vol = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;
  return {
    mmr: muNew * GLICKO.scale + 1500,
    rd: Math.min(GLICKO.maxRd, Math.max(GLICKO.minRd, phiNew * GLICKO.scale)),
    vol,
  };
}

/** Adversário composto de uma equipe: média do MMR e desvio quadrático médio. */
export function teamRating(team: Rating[]): Rating {
  const n = team.length || 1;
  return {
    mmr: team.reduce((s, r) => s + r.mmr, 0) / n,
    rd: Math.sqrt(team.reduce((s, r) => s + r.rd * r.rd, 0) / n),
    vol: GLICKO.defaultVol,
  };
}

// ───────────────────────────── Pontos de Patente ─────────────────────────────
export const RANKED_RULES = {
  placementMatches: 5,
  baseWin: 24,
  baseLoss: 20,
  /** Ajuste máximo (±) para aproximar os PP do MMR. */
  maxConvergence: 10,
  /** Bônus por vitória consecutiva a partir da 3ª, até o teto. */
  streakBonus: 2,
  maxStreakBonus: 6,
  mvpBonus: 2,
  /** Durante a classificação: ganhos dobrados e derrotas não tiram pontos. */
  placementWinMult: 2,
  /** Abandono: penalidade fixa, sem atenuantes (mesmo na classificação). */
  abandonPenalty: 30,
  /** Quem perde depois que um aliado abandonou perde só esta fração. */
  abandonedTeamLossFactor: 0.5,
  /** Bloqueio de fila ranqueada após abandonar (minutos), por reincidência nas últimas 24 h. */
  abandonCooldownMin: [5, 15, 60],
  /** MMR correspondente a 0 PP e ao topo (VANTA Supremo). */
  mmrFloor: 1200,
  mmrCeil: 2600,
  /** Patente inicial máxima ao terminar a classificação (ordem). */
  placementCapOrder: 9,
} as const;

const TOP_POINTS = RANKS[RANKS.length - 1]!.minPoints;

/** PP "esperados" para um MMR (mapa linear entre o piso e o teto). */
export function pointsForMmr(mmr: number): number {
  const t = (mmr - RANKED_RULES.mmrFloor) / (RANKED_RULES.mmrCeil - RANKED_RULES.mmrFloor);
  return Math.round(Math.min(1, Math.max(0, t)) * TOP_POINTS);
}

export type RankedOutcome = "WIN" | "LOSS" | "DRAW" | "ABANDONED";

export interface PointsInput {
  outcome: RankedOutcome;
  points: number;
  /** MMR já atualizado pela partida. */
  mmrAfter: number;
  placementLeft: number;
  /** Sequência de vitórias antes da partida. */
  winStreak: number;
  mvp: boolean;
  /** Um aliado abandonou a partida. */
  teammateAbandoned: boolean;
}

export interface PointsResult {
  points: number;
  delta: number;
  placementLeft: number;
  winStreak: number;
  /** Terminou a classificação nesta partida. */
  placed: boolean;
}

/** Calcula os novos Pontos de Patente. Nunca ficam negativos. */
export function applyRankedResult(i: PointsInput): PointsResult {
  const R = RANKED_RULES;
  const inPlacement = i.placementLeft > 0;
  // Convergência: quem tem MMR acima do que os PP indicam ganha mais e perde menos (e vice-versa).
  const gap = pointsForMmr(i.mmrAfter) - i.points;
  const conv = Math.max(-R.maxConvergence, Math.min(R.maxConvergence, Math.round(gap / 40)));
  let delta = 0;
  let streak = i.winStreak;
  switch (i.outcome) {
    case "WIN": {
      streak += 1;
      const streakBonus = Math.min(R.maxStreakBonus, Math.max(0, streak - 2) * R.streakBonus);
      delta = R.baseWin + conv + streakBonus + (i.mvp ? R.mvpBonus : 0);
      if (inPlacement) delta *= R.placementWinMult;
      delta = Math.max(1, delta);
      break;
    }
    case "LOSS": {
      streak = 0;
      delta = -(R.baseLoss - conv);
      if (i.teammateAbandoned) delta = Math.round(delta * R.abandonedTeamLossFactor);
      if (inPlacement) delta = 0;
      delta = Math.min(0, delta);
      break;
    }
    case "DRAW":
      delta = 0;
      break;
    case "ABANDONED":
      streak = 0;
      delta = -R.abandonPenalty;
      break;
  }
  let points = Math.max(0, i.points + delta);
  const placementLeft = inPlacement ? i.placementLeft - 1 : 0;
  const placed = inPlacement && placementLeft === 0;
  if (placed) {
    // Fim da classificação: a patente inicial vem do MMR, limitada para ninguém começar no topo.
    const cap = RANKS[R.placementCapOrder - 1]!.minPoints;
    points = Math.max(points, Math.min(cap, pointsForMmr(i.mmrAfter)));
  }
  return { points, delta: points - i.points, placementLeft, winStreak: streak, placed };
}

/** Minutos de bloqueio da fila ranqueada conforme os abandonos nas últimas 24 h (0 = sem bloqueio). */
export function abandonCooldownMinutes(abandonsLast24h: number): number {
  if (abandonsLast24h <= 0) return 0;
  const steps = RANKED_RULES.abandonCooldownMin;
  return steps[Math.min(steps.length, abandonsLast24h) - 1]!;
}

// ───────────────────────────── Matchmaking ─────────────────────────────
export const MATCHMAKING = { baseWindow: 100, growthPerSec: 25, maxWindow: 800 } as const;

/** Diferença de MMR aceita por um jogador depois de `waitedMs` na fila. */
export function mmrWindow(waitedMs: number): number {
  return Math.min(MATCHMAKING.maxWindow, MATCHMAKING.baseWindow + (Math.max(0, waitedMs) / 1000) * MATCHMAKING.growthPerSec);
}

export interface QueueCandidate {
  id: string;
  mmr: number;
  waitedMs: number;
}

/**
 * Escolhe `size` jogadores da fila com MMR próximos: a diferença entre o maior e o menor precisa
 * caber na janela de TODOS os escolhidos (quem acabou de entrar não é puxado para longe).
 * Entre os grupos possíveis, prefere o que contém quem espera há mais tempo. Devolve null se não há grupo.
 */
export function pickMatchGroup(queue: QueueCandidate[], size: number): QueueCandidate[] | null {
  if (queue.length < size) return null;
  const sorted = [...queue].sort((a, b) => a.mmr - b.mmr);
  let best: { group: QueueCandidate[]; waited: number; spread: number } | null = null;
  for (let i = 0; i + size <= sorted.length; i++) {
    const group = sorted.slice(i, i + size);
    const spread = group[size - 1]!.mmr - group[0]!.mmr;
    const tolerance = Math.min(...group.map((c) => mmrWindow(c.waitedMs)));
    if (spread > tolerance) continue;
    const waited = Math.max(...group.map((c) => c.waitedMs));
    if (!best || waited > best.waited || (waited === best.waited && spread < best.spread)) best = { group, waited, spread };
  }
  return best?.group ?? null;
}

/** Divide os jogadores em duas equipes com a menor diferença de MMR somado (busca exaustiva; no máximo C(6,3)=20). */
export function balanceTeams<T extends { mmr: number }>(players: T[]): [T[], T[]] {
  const n = players.length;
  const half = n / 2;
  if (!Number.isInteger(half) || half < 1) throw new Error("Número de jogadores inválido");
  const total = players.reduce((s, p) => s + p.mmr, 0);
  let bestMask = 0;
  let bestDiff = Infinity;
  // O jogador 0 fica sempre na equipe A: elimina as divisões espelhadas.
  for (let mask = 1; mask < 1 << n; mask += 2) {
    let bits = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        bits++;
        sum += players[i]!.mmr;
      }
    }
    if (bits !== half) continue;
    const diff = Math.abs(total - 2 * sum);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestMask = mask;
    }
  }
  const a: T[] = [];
  const b: T[] = [];
  players.forEach((p, i) => (bestMask & (1 << i) ? a : b).push(p));
  return [a, b];
}

// ───────────────────────────── Temporadas ─────────────────────────────
/** Reinício parcial: mantém parte dos PP, aproxima o MMR da média e reabre a incerteza. */
export function seasonSoftReset(prev: { points: number; mmr: number; rd: number; vol: number }, carryOverFactor: number): { points: number; mmr: number; rd: number; vol: number; placementLeft: number } {
  const f = Math.min(1, Math.max(0, carryOverFactor));
  return {
    points: Math.floor(prev.points * f),
    mmr: GLICKO.defaultMmr + (prev.mmr - GLICKO.defaultMmr) * 0.75,
    rd: Math.min(GLICKO.maxRd, Math.max(prev.rd, 200)),
    vol: prev.vol,
    placementLeft: RANKED_RULES.placementMatches,
  };
}

/** Resumo de patente para a interface. `null` enquanto o jogador está em classificação. */
export function visibleRank(points: number, placementLeft: number) {
  return placementLeft > 0 ? null : rankForPoints(points);
}
