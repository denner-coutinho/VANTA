import { equippedCosmetics } from "../economy/store.service.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { levelFromTotalXp, type MeResponse } from "@vanta/shared";
import { Errors } from "../../lib/errors.js";
import { toPublicUser } from "../auth/auth.service.js";

export async function meRoutes(app: FastifyInstance) {
  app.get("/me", { preHandler: app.authenticate }, async (req) => {
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: req.auth.userId },
      include: { profile: true, wallet: true },
    });
    const now = new Date();
    const activeSeason = await app.prisma.rankedSeason.findFirst({ where: { isActive: true, closedAt: null, startsAt: { lte: now }, endsAt: { gt: now } } });
    // Destaque do perfil: o melhor modo já classificado; se nenhum, o que está mais perto de terminar a classificação.
    const rating = activeSeason
      ? await app.prisma.rankedRating.findFirst({ where: { userId: user.id, seasonId: activeSeason.id }, orderBy: [{ placementLeft: "asc" }, { points: "desc" }] })
      : null;
    const ranks = activeSeason ? await app.prisma.rank.findMany({ orderBy: { order: "asc" } }) : [];
    const points = rating?.points ?? 0;
    const rankOrder = ranks.filter((r) => r.minPoints <= points).at(-1)?.order ?? 1;
    const lvl = levelFromTotalXp(user.profile?.totalXp ?? 0);

    const cosmetics = await equippedCosmetics(app.prisma, user.id);
    const body: MeResponse = {
      user: toPublicUser(user),
      profile: {
        displayName: user.profile?.displayName ?? user.username,
        level: lvl.level,
        xpIntoLevel: lvl.xpIntoLevel,
        xpForNext: lvl.xpForNext,
        totalXp: user.profile?.totalXp ?? 0,
        title: user.profile?.title ?? null,
        avatarKey: user.profile?.avatarKey ?? "default",
        mainCharacterId: user.profile?.mainCharacterId ?? null,
      },
      wallet: { balance: user.wallet?.balance ?? 0, currency: "VC" },
      ranked: activeSeason
        ? { seasonName: activeSeason.name, points, rankOrder, placementMatchesLeft: rating?.placementLeft ?? activeSeason.placementMatches }
        : null,
      cosmetics,
    };
    return body;
  });

  /** Seleciona o operador em destaque. Só personagens ativos (na Fase 6, também exigirá posse). */
  app.post("/me/character", { preHandler: app.authenticate }, async (req) => {
    const { characterId } = z.object({ characterId: z.string().min(1).max(40) }).parse(req.body);
    const character = await app.prisma.character.findFirst({ where: { id: characterId, isActive: true }, select: { id: true } });
    if (!character) throw Errors.notFound("Personagem não encontrado.");
    await app.prisma.userProfile.update({ where: { userId: req.auth.userId }, data: { mainCharacterId: character.id } });
    return { mainCharacterId: character.id };
  });
}
