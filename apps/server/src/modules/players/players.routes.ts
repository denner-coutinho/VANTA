import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@vanta/db";
import { z } from "zod";
import { cardStyle, levelFromTotalXp, rankForPoints, updateCardSchema, type LevelLeaderboardResponse, type PlayerCardView, type PublicProfileResponse } from "@vanta/shared";
import { Errors } from "../../lib/errors.js";
import { getActiveSeason } from "../../game/ranked.js";

const MODE_OF = { DUEL_1V1: "1v1", TEAM_2V2: "2v2", TEAM_3V3: "3v3" } as const;
type DbMode = keyof typeof MODE_OF;

/** Cartão público de vários jogadores (perfil, clã e melhor patente da temporada ativa). */
export async function playerCards(db: PrismaClient, userIds: string[]): Promise<Map<string, PlayerCardView>> {
  const season = await getActiveSeason(db);
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      username: true,
      profile: { select: { displayName: true, totalXp: true, title: true, avatarKey: true, playerCardKey: true } },
      clanMembership: { select: { clan: { select: { id: true, name: true, tag: true, logoKey: true } } } },
      rankedRatings: season ? { where: { seasonId: season.id, placementLeft: 0 }, select: { points: true }, orderBy: { points: "desc" }, take: 1 } : false,
    },
  });
  return new Map(
    users.map((u) => [
      u.id,
      {
        userId: u.id,
        username: u.username,
        displayName: u.profile?.displayName ?? u.username,
        level: levelFromTotalXp(u.profile?.totalXp ?? 0).level,
        title: u.profile?.title ?? null,
        avatarKey: u.profile?.avatarKey ?? "default",
        playerCardKey: cardStyle(u.profile?.playerCardKey).key,
        clan: u.clanMembership?.clan ?? null,
        rankOrder: u.rankedRatings?.[0] ? rankForPoints(u.rankedRatings[0].points).order : null,
      },
    ]),
  );
}

/** Perfil público, cartão do jogador e ranking de nível. */
export async function playerRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  app.get("/players/:username", auth, async (req): Promise<PublicProfileResponse> => {
    const { username } = z.object({ username: z.string().min(1).max(20) }).parse(req.params);
    const viewer = req.auth.userId;
    const u = await app.prisma.user.findUnique({ where: { usernameLower: username.toLowerCase() }, select: { id: true, status: true, createdAt: true, profile: true } });
    // Conta banida/apagada some; quem bloqueou o visitante também não aparece para ele.
    if (!u || !u.profile || u.status === "BANNED" || u.status === "DELETED") throw Errors.notFound("Jogador não encontrado.");
    if (u.id !== viewer && (await app.prisma.userBlock.findFirst({ where: { blockerId: u.id, blockedId: viewer }, select: { id: true } }))) throw Errors.notFound("Jogador não encontrado.");
    const season = await getActiveSeason(app.prisma);
    const [cards, ratings, medals, achievements, recent, friend] = await Promise.all([
      playerCards(app.prisma, [u.id]),
      season ? app.prisma.rankedRating.findMany({ where: { userId: u.id, seasonId: season.id }, orderBy: { mode: "asc" } }) : Promise.resolve([]),
      app.prisma.userMedal.findMany({ where: { userId: u.id }, orderBy: { count: "desc" } }),
      app.prisma.userAchievement.findMany({ where: { userId: u.id, unlockedAt: { not: null } }, include: { achievement: { select: { code: true, name: true } } }, orderBy: { unlockedAt: "desc" } }),
      app.prisma.matchPlayer.findMany({
        where: { userId: u.id, match: { status: "FINISHED", type: { in: ["CASUAL", "RANKED"] } } },
        orderBy: { joinedAt: "desc" },
        take: 10,
        include: { match: { select: { id: true, mode: true, type: true, endedAt: true, map: { select: { code: true } } } } },
      }),
      u.id === viewer ? Promise.resolve(null) : app.prisma.friend.findFirst({ where: { OR: [{ userAId: u.id, userBId: viewer }, { userAId: viewer, userBId: u.id }] }, select: { id: true } }),
    ]);
    const p = u.profile;
    return {
      card: cards.get(u.id)!,
      memberSince: u.createdAt.toISOString(),
      stats: { matchesPlayed: p.matchesPlayed, wins: p.wins, losses: p.losses, kills: p.kills, deaths: p.deaths, assists: p.assists, headshots: p.headshots, accuracy: p.shotsFired ? Math.round((p.shotsHit / p.shotsFired) * 1000) / 10 : 0, mvpCount: p.mvpCount },
      ranked: ratings.map((r) => ({ mode: MODE_OF[r.mode as DbMode] ?? "1v1", points: r.points, rankOrder: rankForPoints(r.points).order, wins: r.wins, losses: r.losses, placementLeft: r.placementLeft })),
      medals: medals.map((m) => ({ code: m.code, count: m.count })),
      achievements: achievements.map((a) => ({ code: a.achievement.code, name: a.achievement.name, unlockedAt: a.unlockedAt!.toISOString() })),
      recent: recent.map((m) => ({
        matchId: m.match.id,
        mode: MODE_OF[m.match.mode as DbMode] ?? "1v1",
        type: m.match.type === "RANKED" ? "RANKED" : "CASUAL",
        map: m.match.map.code,
        result: m.result === "ABANDONED" ? "ABANDON" : m.result,
        kills: m.kills,
        deaths: m.deaths,
        assists: m.assists,
        mvp: m.isMvp,
        medals: m.medals,
        endedAt: m.match.endedAt?.toISOString() ?? null,
      })),
      relation: u.id === viewer ? "self" : friend ? "friend" : "none",
    };
  });

  /** Cartão e cor de avatar: grátis, mas o cartão só abre no nível mínimo dele (conferido aqui). */
  app.put("/profile/card", auth, async (req) => {
    const body = updateCardSchema.parse(req.body);
    const p = await app.prisma.userProfile.findUniqueOrThrow({ where: { userId: req.auth.userId }, select: { totalXp: true } });
    const level = levelFromTotalXp(p.totalXp).level;
    const style = cardStyle(body.playerCardKey);
    if (level < style.minLevel) throw Errors.forbidden(`O cartão “${style.name}” abre no nível ${style.minLevel}.`);
    await app.prisma.userProfile.update({ where: { userId: req.auth.userId }, data: { playerCardKey: body.playerCardKey, avatarKey: body.avatarKey } });
    return (await playerCards(app.prisma, [req.auth.userId])).get(req.auth.userId)!;
  });

  app.get("/rankings/level", auth, async (req): Promise<LevelLeaderboardResponse> => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(100) }).parse(req.query);
    const where = { user: { status: "ACTIVE" as const } };
    const [total, rows, mine] = await Promise.all([
      app.prisma.userProfile.count({ where }),
      app.prisma.userProfile.findMany({ where, orderBy: [{ totalXp: "desc" }, { userId: "asc" }], take: q.limit, select: { userId: true, totalXp: true, title: true, user: { select: { username: true, clanMembership: { select: { clan: { select: { tag: true } } } } } } } }),
      app.prisma.userProfile.findUnique({ where: { userId: req.auth.userId }, select: { totalXp: true } }),
    ]);
    const me = mine ? { position: (await app.prisma.userProfile.count({ where: { ...where, OR: [{ totalXp: { gt: mine.totalXp } }, { totalXp: mine.totalXp, userId: { lt: req.auth.userId } }] } })) + 1, level: levelFromTotalXp(mine.totalXp).level, totalXp: mine.totalXp } : null;
    return {
      total,
      entries: rows.map((r, i) => ({ position: i + 1, userId: r.userId, username: r.user.username, level: levelFromTotalXp(r.totalXp).level, totalXp: r.totalXp, title: r.title, clanTag: r.user.clanMembership?.clan.tag ?? null })),
      me,
    };
  });
}
