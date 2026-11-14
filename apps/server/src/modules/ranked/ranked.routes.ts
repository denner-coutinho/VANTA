import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MODES, rankForPoints, type QueueMode, type RankedLeaderboardResponse, type RankedOverviewResponse } from "@vanta/shared";
import { Errors } from "../../lib/errors.js";
import { getActiveSeason, rankedCooldownSeconds } from "../../game/ranked.js";
import { closeSeason, startSeason } from "./season.service.js";

const QUEUE_MODES = Object.keys(MODES) as QueueMode[];
const modeFromDb = (db: string) => QUEUE_MODES.find((m) => MODES[m].db === db)!;
const LEADERBOARD_ORDER = [{ points: "desc" as const }, { peakPoints: "desc" as const }, { updatedAt: "asc" as const }];

/**
 * Competitivo: situação do jogador, ranking e temporadas. O MMR oculto nunca sai da API;
 * só Pontos de Patente e patente (e a patente só depois da classificação).
 */
export async function rankedRoutes(app: FastifyInstance) {
  app.get("/ranked/overview", { preHandler: app.authenticate }, async (req): Promise<RankedOverviewResponse> => {
    const userId = req.auth.userId;
    const active = await getActiveSeason(app.prisma);
    const season = active ? await app.prisma.rankedSeason.findUniqueOrThrow({ where: { id: active.id }, select: { id: true, number: true, name: true, startsAt: true, endsAt: true, placementMatches: true } }) : null;
    const ratings = season ? await app.prisma.rankedRating.findMany({ where: { userId, seasonId: season.id } }) : [];
    const recent = await app.prisma.matchPlayer.findMany({
      where: { userId, match: { type: "RANKED", status: "FINISHED" } },
      orderBy: { match: { endedAt: "desc" } },
      take: 10,
      select: { team: true, result: true, pointsDelta: true, kills: true, deaths: true, assists: true, isMvp: true, match: { select: { id: true, mode: true, endedAt: true, scoreTeamA: true, scoreTeamB: true, map: { select: { name: true } } } } },
    });
    return {
      season: season ? { id: season.id, number: season.number, name: season.name, startsAt: season.startsAt.toISOString(), endsAt: season.endsAt.toISOString(), placementMatches: season.placementMatches } : null,
      cooldownSeconds: season ? await rankedCooldownSeconds(app.prisma, userId) : 0,
      modes: QUEUE_MODES.map((mode) => {
        const r = ratings.find((x) => x.mode === MODES[mode].db);
        const placementLeft = r?.placementLeft ?? season?.placementMatches ?? 0;
        const points = r?.points ?? 0;
        return {
          mode,
          points,
          rankOrder: r && placementLeft === 0 ? rankForPoints(points).order : null,
          placementLeft,
          wins: r?.wins ?? 0,
          losses: r?.losses ?? 0,
          winStreak: r?.winStreak ?? 0,
          peakPoints: r?.peakPoints ?? 0,
        };
      }),
      recent: recent.map((m) => ({
        matchId: m.match.id,
        mode: modeFromDb(m.match.mode),
        map: m.match.map.name,
        result: m.result ?? "DRAW",
        pointsDelta: m.pointsDelta,
        score: m.team === 0 ? [m.match.scoreTeamA, m.match.scoreTeamB] : [m.match.scoreTeamB, m.match.scoreTeamA],
        kills: m.kills,
        deaths: m.deaths,
        assists: m.assists,
        mvp: m.isMvp,
        endedAt: m.match.endedAt?.toISOString() ?? null,
      })),
    };
  });

  app.get("/ranked/leaderboard", { preHandler: app.authenticate }, async (req): Promise<RankedLeaderboardResponse> => {
    const q = z.object({ mode: z.enum(["1v1", "2v2", "3v3"]).default("1v1"), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10_000).default(0) }).parse(req.query);
    const season = await getActiveSeason(app.prisma);
    if (!season) return { season: null, mode: q.mode, total: 0, entries: [], me: null };
    const where = { seasonId: season.id, mode: MODES[q.mode].db, placementLeft: 0 };
    const [total, rows, mine] = await Promise.all([
      app.prisma.rankedRating.count({ where }),
      app.prisma.rankedRating.findMany({ where, orderBy: LEADERBOARD_ORDER, skip: q.offset, take: q.limit, select: { userId: true, points: true, wins: true, losses: true, winStreak: true, user: { select: { username: true, profile: { select: { level: true } } } } } }),
      app.prisma.rankedRating.findFirst({ where: { ...where, userId: req.auth.userId } }),
    ]);
    let me: RankedLeaderboardResponse["me"] = null;
    if (mine) {
      // Mesma ordem do ranking: pontos, depois pico, depois quem chegou primeiro.
      const ahead = await app.prisma.rankedRating.count({
        where: { ...where, OR: [{ points: { gt: mine.points } }, { points: mine.points, peakPoints: { gt: mine.peakPoints } }, { points: mine.points, peakPoints: mine.peakPoints, updatedAt: { lt: mine.updatedAt } }] },
      });
      me = { position: ahead + 1, points: mine.points, rankOrder: rankForPoints(mine.points).order };
    }
    return {
      season: season.name,
      mode: q.mode,
      total,
      entries: rows.map((r, i) => ({ position: q.offset + i + 1, userId: r.userId, username: r.user.username, level: r.user.profile?.level ?? 1, points: r.points, rankOrder: rankForPoints(r.points).order, wins: r.wins, losses: r.losses, winStreak: r.winStreak })),
      me,
    };
  });

  app.get("/ranked/seasons", async () => {
    const seasons = await app.prisma.rankedSeason.findMany({ orderBy: { number: "desc" }, select: { id: true, number: true, name: true, startsAt: true, endsAt: true, isActive: true, closedAt: true, leaderboardSnapshot: true } });
    return seasons.map((s) => {
      const snap = (s.leaderboardSnapshot ?? {}) as Record<string, unknown[]>;
      return { id: s.id, number: s.number, name: s.name, startsAt: s.startsAt, endsAt: s.endsAt, isActive: s.isActive, closedAt: s.closedAt, top: Object.fromEntries(QUEUE_MODES.map((m) => [m, (snap[MODES[m].db] ?? []).slice(0, 10)])) };
    });
  });

  // ───────── Administração de temporadas (ADMIN+), com auditoria ─────────
  const admin = app.requireRole("ADMIN");

  app.post("/admin/ranked/seasons/start", { preHandler: admin }, async (req) => {
    const body = z.object({ name: z.string().trim().min(3).max(60).optional(), durationDays: z.number().int().min(7).max(365).default(90) }).parse(req.body ?? {});
    const { season, carried } = await startSeason(app.prisma, body);
    await app.prisma.adminAuditLog.create({ data: { actorId: req.auth.userId, action: "ranked.season.start", targetType: "RankedSeason", targetId: season.id, after: { name: season.name, endsAt: season.endsAt, carried }, ip: req.ip } });
    return { id: season.id, number: season.number, name: season.name, startsAt: season.startsAt, endsAt: season.endsAt, carriedRatings: carried };
  });

  app.post("/admin/ranked/seasons/close", { preHandler: admin }, async (req) => {
    const active = await app.prisma.rankedSeason.findFirst({ where: { isActive: true } });
    if (!active) throw Errors.conflict("NO_SEASON", "Não há temporada em andamento.");
    const closed = await closeSeason(app.prisma, active.id);
    await app.prisma.adminAuditLog.create({ data: { actorId: req.auth.userId, action: "ranked.season.close", targetType: "RankedSeason", targetId: closed.id, after: { closedAt: closed.closedAt }, ip: req.ip } });
    return { id: closed.id, number: closed.number, closedAt: closed.closedAt };
  });
}
