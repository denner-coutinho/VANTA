import type { Prisma, PrismaClient } from "@vanta/db";
import {
  MODES,
  abandonCooldownMinutes,
  applyRankedResult,
  glicko2Update,
  rankForPoints,
  teamRating,
  type QueueMode,
  type RankedOutcome,
  type RankedResultWire,
  type Rating,
} from "@vanta/shared";
import type { MatchResult } from "./match.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface ActiveSeason {
  id: string;
  name: string;
  placementMatches: number;
}

/** Temporada ranqueada em andamento (ativa e dentro do período). */
export async function getActiveSeason(db: Db, now = new Date()): Promise<ActiveSeason | null> {
  return db.rankedSeason.findFirst({
    where: { isActive: true, closedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
    select: { id: true, name: true, placementMatches: true },
  });
}

/** Rating do jogador na temporada/modo; cria com os valores iniciais se ainda não existe. */
export async function getOrCreateRating(db: Db, season: ActiveSeason, mode: QueueMode, userId: string) {
  const key = { userId_seasonId_mode: { userId, seasonId: season.id, mode: MODES[mode].db } };
  return db.rankedRating.upsert({ where: key, update: {}, create: { userId, seasonId: season.id, mode: MODES[mode].db, placementLeft: season.placementMatches } });
}

/**
 * Bloqueio da fila ranqueada por abandono: conta os abandonos em partidas ranqueadas nas últimas
 * 24 h e aplica a espera a partir do mais recente. Devolve os segundos restantes (0 = liberado).
 */
export async function rankedCooldownSeconds(db: Db, userId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const abandons = await db.matchPlayer.findMany({
    where: { userId, abandoned: true, match: { type: "RANKED", endedAt: { gte: since } } },
    select: { match: { select: { endedAt: true } } },
    orderBy: { match: { endedAt: "desc" } },
    take: 10,
  });
  if (!abandons.length) return 0;
  const last = abandons[0]!.match.endedAt!;
  const until = last.getTime() + abandonCooldownMinutes(abandons.length) * 60_000;
  return Math.max(0, Math.ceil((until - now.getTime()) / 1000));
}

export interface RankedPlayerUpdate {
  userId: string;
  pointsDelta: number;
  mmrBefore: number;
  mmrAfter: number;
  wire: RankedResultWire;
}

/**
 * Aplica o resultado de uma partida ranqueada (dentro da transação que grava a partida):
 * Glicko-2 contra o adversário composto da outra equipe, Pontos de Patente, classificação,
 * sequência, contadores e histórico de patente. O cliente não participa de nenhum cálculo.
 */
export async function applyRankedMatch(tx: Prisma.TransactionClient, season: ActiveSeason, r: MatchResult): Promise<RankedPlayerUpdate[]> {
  const rows = new Map<string, Awaited<ReturnType<typeof getOrCreateRating>>>();
  for (const p of r.players) rows.set(p.id, await getOrCreateRating(tx, season, r.mode, p.id));
  const ratingOf = (id: string): Rating => {
    const row = rows.get(id)!;
    return { mmr: row.mmr, rd: row.mmrDeviation, vol: row.mmrVolatility };
  };
  const teams = ([0, 1] as const).map((t) => r.players.filter((p) => p.team === t));
  const composite = teams.map((t) => teamRating(t.map((p) => ratingOf(p.id))));
  const teamHasAbandon = teams.map((t) => t.some((p) => p.abandoned));

  const updates: RankedPlayerUpdate[] = [];
  for (const p of r.players) {
    const row = rows.get(p.id)!;
    const outcome: RankedOutcome = p.abandoned ? "ABANDONED" : r.winner === null ? "DRAW" : r.winner === p.team ? "WIN" : "LOSS";
    const score = outcome === "WIN" ? 1 : outcome === "DRAW" ? 0.5 : 0;
    const before = ratingOf(p.id);
    const after = glicko2Update(before, [{ opponent: composite[1 - p.team]!, score }]);
    const pts = applyRankedResult({
      outcome,
      points: row.points,
      mmrAfter: after.mmr,
      placementLeft: row.placementLeft,
      winStreak: row.winStreak,
      mvp: p.mvp,
      teammateAbandoned: !p.abandoned && teamHasAbandon[p.team]!,
    });
    await tx.rankedRating.update({
      where: { id: row.id },
      data: {
        mmr: after.mmr,
        mmrDeviation: after.rd,
        mmrVolatility: after.vol,
        points: pts.points,
        peakPoints: Math.max(row.peakPoints, pts.points),
        wins: { increment: outcome === "WIN" ? 1 : 0 },
        losses: { increment: outcome === "LOSS" || outcome === "ABANDONED" ? 1 : 0 },
        abandons: { increment: outcome === "ABANDONED" ? 1 : 0 },
        placementLeft: pts.placementLeft,
        winStreak: pts.winStreak,
        lastMatchAt: r.endedAt,
      },
    });
    // A patente só é visível depois da classificação.
    const orderBefore = row.placementLeft > 0 ? null : rankForPoints(row.points).order;
    const orderAfter = pts.placementLeft > 0 ? null : rankForPoints(pts.points).order;
    if (orderAfter !== null && orderAfter !== orderBefore) {
      await tx.rankHistory.create({ data: { userId: p.id, seasonId: season.id, mode: MODES[r.mode].db, fromOrder: orderBefore ?? 0, toOrder: orderAfter, points: pts.points } });
    }
    updates.push({
      userId: p.id,
      pointsDelta: pts.delta,
      mmrBefore: before.mmr,
      mmrAfter: after.mmr,
      wire: {
        t: "ranked_result",
        matchId: r.matchId,
        mode: r.mode,
        outcome,
        pointsBefore: row.points,
        pointsAfter: pts.points,
        delta: pts.delta,
        rankBefore: orderBefore,
        rankAfter: orderAfter,
        placementLeft: pts.placementLeft,
        placed: pts.placed,
        promoted: orderBefore !== null && orderAfter !== null && orderAfter > orderBefore,
        demoted: orderBefore !== null && orderAfter !== null && orderAfter < orderBefore,
        winStreak: pts.winStreak,
      },
    });
  }
  return updates;
}
