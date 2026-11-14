import type { PrismaClient } from "@vanta/db";
import { rankForPoints, seasonSoftReset } from "@vanta/shared";
import { Errors } from "../../lib/errors.js";

const MODES_DB = ["DUEL_1V1", "TEAM_2V2", "TEAM_3V3"] as const;
export const LEADERBOARD_SNAPSHOT_SIZE = 100;

export type SeasonSnapshotEntry = { position: number; userId: string; username: string; points: number; rankOrder: number; wins: number; losses: number };

/**
 * Fecha a temporada: publica o ranking final (até 100 por modo) e encerra a pontuação.
 * As recompensas de fim de temporada (VANTA COINS / itens) são entregues pela economia (Fase 6)
 * a partir deste snapshot; aqui nada é creditado.
 */
export async function closeSeason(prisma: PrismaClient, seasonId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const season = await tx.rankedSeason.findUnique({ where: { id: seasonId } });
    if (!season) throw Errors.notFound("Temporada não encontrada.");
    if (season.closedAt) throw Errors.conflict("SEASON_CLOSED", "Esta temporada já foi encerrada.");
    const snapshot: Record<string, SeasonSnapshotEntry[]> = {};
    for (const mode of MODES_DB) {
      const top = await tx.rankedRating.findMany({
        where: { seasonId, mode, placementLeft: 0 },
        orderBy: [{ points: "desc" }, { peakPoints: "desc" }, { updatedAt: "asc" }],
        take: LEADERBOARD_SNAPSHOT_SIZE,
        select: { userId: true, points: true, wins: true, losses: true, user: { select: { username: true } } },
      });
      snapshot[mode] = top.map((r, i) => ({ position: i + 1, userId: r.userId, username: r.user.username, points: r.points, rankOrder: rankForPoints(r.points).order, wins: r.wins, losses: r.losses }));
    }
    return tx.rankedSeason.update({ where: { id: seasonId }, data: { isActive: false, closedAt: now, endsAt: season.endsAt > now ? now : season.endsAt, leaderboardSnapshot: snapshot } });
  });
}

/**
 * Inicia uma temporada. Se existe uma temporada criada e nunca iniciada (ex.: a Temporada 1 do seed),
 * ela é ativada; senão cria a próxima, com reinício parcial a partir da última encerrada:
 * quem terminou a classificação mantém parte dos pontos e refaz a classificação.
 */
export async function startSeason(prisma: PrismaClient, input: { name?: string; durationDays: number }, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    if (await tx.rankedSeason.findFirst({ where: { isActive: true } })) throw Errors.conflict("SEASON_ACTIVE", "Já existe uma temporada em andamento. Encerre-a primeiro.");
    const endsAt = new Date(now.getTime() + input.durationDays * 24 * 3600 * 1000);
    const pending = await tx.rankedSeason.findFirst({ where: { closedAt: null, isActive: false }, orderBy: { number: "asc" } });
    const previous = await tx.rankedSeason.findFirst({ where: { closedAt: { not: null } }, orderBy: { number: "desc" } });
    const season = pending
      ? await tx.rankedSeason.update({ where: { id: pending.id }, data: { isActive: true, startsAt: now, endsAt, ...(input.name ? { name: input.name } : {}) } })
      : await tx.rankedSeason.create({
          data: {
            number: (previous?.number ?? 0) + 1,
            name: input.name ?? `Temporada ${(previous?.number ?? 0) + 1}`,
            startsAt: now,
            endsAt,
            isActive: true,
            carryOverFactor: previous?.carryOverFactor ?? 0.5,
            placementMatches: previous?.placementMatches ?? 5,
          },
        });
    let carried = 0;
    if (previous) {
      const old = await tx.rankedRating.findMany({ where: { seasonId: previous.id, placementLeft: 0 } });
      for (const r of old) {
        const next = seasonSoftReset({ points: r.points, mmr: r.mmr, rd: r.mmrDeviation, vol: r.mmrVolatility }, previous.carryOverFactor);
        await tx.rankedRating.upsert({
          where: { userId_seasonId_mode: { userId: r.userId, seasonId: season.id, mode: r.mode } },
          update: {},
          create: { userId: r.userId, seasonId: season.id, mode: r.mode, mmr: next.mmr, mmrDeviation: next.rd, mmrVolatility: next.vol, points: next.points, peakPoints: next.points, placementLeft: Math.min(next.placementLeft, season.placementMatches) },
        });
        carried++;
      }
    }
    return { season, carried };
  });
}
