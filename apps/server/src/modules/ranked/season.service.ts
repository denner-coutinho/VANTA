import type { PrismaClient } from "@vanta/db";
import { SEASON_REWARD_VC, rankForPoints, seasonEmblemCode, seasonSoftReset } from "@vanta/shared";
import { postLedger } from "../economy/wallet.js";
import { grantItem } from "../economy/store.service.js";
import { Errors } from "../../lib/errors.js";

const MODES_DB = ["DUEL_1V1", "TEAM_2V2", "TEAM_3V3"] as const;
export const LEADERBOARD_SNAPSHOT_SIZE = 100;

export type SeasonSnapshotEntry = { position: number; userId: string; username: string; points: number; rankOrder: number; wins: number; losses: number };

/**
 * Fecha a temporada: publica o ranking final (até 100 por modo) e encerra a pontuação.
 * Recompensas (na mesma transação, uma vez por jogador): quem terminou a classificação em
 * pelo menos um modo recebe VANTA COINS pelo melhor tier alcançado e o emblema da temporada.
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
    // Melhor patente final de cada jogador classificado, considerando os três modos.
    const placed = await tx.rankedRating.findMany({ where: { seasonId, placementLeft: 0 }, select: { userId: true, points: true } });
    const best = new Map<string, number>();
    for (const r of placed) best.set(r.userId, Math.max(best.get(r.userId) ?? 0, r.points));
    const emblem = await tx.storeItem.findUnique({ where: { code: seasonEmblemCode(season.number) } });
    let rewarded = 0;
    for (const [userId, points] of best) {
      const rank = rankForPoints(points);
      await postLedger(tx, {
        userId,
        amount: SEASON_REWARD_VC[rank.tier],
        type: "REWARD_CREDIT",
        idempotencyKey: `season:${seasonId}:${userId}`,
        description: `Recompensa da ${season.name} (${rank.name})`,
        meta: { seasonId, rankOrder: rank.order },
      });
      if (emblem) await grantItem(tx, userId, emblem.id, "SEASON_REWARD");
      rewarded++;
    }

    const closed = await tx.rankedSeason.update({ where: { id: seasonId }, data: { isActive: false, closedAt: now, endsAt: season.endsAt > now ? now : season.endsAt, leaderboardSnapshot: snapshot } });
    return Object.assign(closed, { rewardedPlayers: rewarded });
  }, { timeout: 120_000 });
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
    const emblem = { type: "EMBLEM" as const, name: `Emblema · ${season.name}`, description: `Entregue a quem terminou a classificação na ${season.name}.`, rarity: "SEASONAL" as const, priceVc: null, imageKey: `emblem_season_${season.number}`, seasonId: season.id };
    await tx.storeItem.upsert({ where: { code: seasonEmblemCode(season.number) }, update: {}, create: { ...emblem, code: seasonEmblemCode(season.number) } });

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
