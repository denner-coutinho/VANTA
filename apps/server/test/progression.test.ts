import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { levelFromTotalXp, periodKey, type PlayerMatchStats, type ProgressionResponse } from "@vanta/shared";
import { GameServer } from "../src/game/server.js";
import type { MatchResult } from "../src/game/match.js";
import { closeTestContext, createTestContext, newPlayer, resetState, type TestContext } from "./helpers.js";

let ctx: TestContext;
let gs: GameServer;
const SECRET = "segredo-de-teste-com-mais-de-32-caracteres-ok";

beforeAll(async () => {
  ctx = await createTestContext();
  gs = new GameServer({ prisma: ctx.prisma, jwtSecret: SECRET, allowedOrigins: [], autoTick: false, recheckMs: 60_000, log: { info() {}, warn() {}, error: console.error } });
});
afterAll(async () => {
  await closeTestContext(ctx);
});
beforeEach(async () => {
  await ctx.prisma.$executeRawUnsafe(`TRUNCATE "Match" CASCADE`);
  await resetState(ctx);
});

interface P {
  id: string;
  token: string;
}
async function player(): Promise<P> {
  const j = (await ctx.app.inject({ method: "POST", url: "/auth/register", payload: newPlayer() })).json();
  return { id: j.user.id, token: j.accessToken };
}
const api = (p: P, method: "GET" | "POST" | "PUT", url: string, payload?: object) => ctx.app.inject({ method, url, headers: { authorization: `Bearer ${p.token}` }, payload });
const overview = async (p: P) => (await api(p, "GET", "/progression")).json() as ProgressionResponse;

type Pl = Partial<PlayerMatchStats> & { id: string; team: 0 | 1 };
function result(players: Pl[], over: Partial<MatchResult> = {}): MatchResult {
  return {
    matchId: crypto.randomUUID(),
    mode: "1v1",
    mapCode: "NEON_DISTRICT",
    ranked: false,
    winner: 0,
    score: [5, 2],
    reason: "score",
    startedAt: new Date(Date.now() - 300_000),
    endedAt: new Date(),
    roundsToWin: 5,
    roomId: null,
    events: [],
    ...over,
    players: players.map((p) => ({ username: p.id, kills: 0, deaths: 0, assists: 0, headshots: 0, damage: 0, shots: 0, hits: 0, abandoned: false, mvp: false, characterId: null, ...p })),
  };
}

describe("progressão", () => {
  it("partida dá XP, medalhas, avança missões e desbloqueia conquistas; abandono não ganha nada", async () => {
    const [a, b] = [await player(), await player()];
    const kills = [1, 2, 3].flatMap((round) => [{ tick: round * 100, round, type: "kill", actorId: a.id, targetId: b.id, data: {} }, { tick: round * 100 + 1, round, type: "round_end", data: { winner: 0 } }]);
    const r = result([{ id: a.id, team: 0, kills: 3, headshots: 2, mvp: true, shots: 10, hits: 6 }, { id: b.id, team: 1, deaths: 3, abandoned: true }], { events: kills });
    await gs.persist(r);

    const mp = await ctx.prisma.matchPlayer.findFirstOrThrow({ where: { matchId: r.matchId, userId: a.id } });
    const xp = 100 + 150 + 3 * 20 + 2 * 5 + 100;
    expect(mp.xpEarned).toBe(xp);
    expect(new Set(mp.medals)).toEqual(new Set(["MVP", "OPENER", "FLAWLESS"]));
    expect((await ctx.prisma.matchPlayer.findFirstOrThrow({ where: { matchId: r.matchId, userId: b.id } })).xpEarned).toBe(0);

    const ov = await overview(a);
    // Conquistas: primeira eliminação (+100) e primeira vitória (+200).
    expect(ov.achievements.filter((x) => x.unlockedAt).map((x) => x.code).sort()).toEqual(["FIRST_BLOOD", "FIRST_WIN"]);
    expect(ov.totalXp).toBe(xp + 300);
    expect(ov.level).toBe(levelFromTotalXp(xp + 300).level);
    expect(ov.medals.find((m) => m.code === "OPENER")!.count).toBe(1);
    const daily = ov.missions.find((m) => m.code === "DAILY_WIN_1")!;
    expect(daily).toMatchObject({ progress: 1, completed: true, claimed: false, target: 1 });
    expect(ov.missions.find((m) => m.code === "DAILY_KILLS_15")!.progress).toBe(3);
    expect(ov.history.map((h) => h.label)).toEqual(expect.arrayContaining(["Partida", "Conquista: Primeira vitória"]));
    // B abandonou: nada de XP, missão ou conquista.
    const ob = await overview(b);
    expect(ob.totalXp).toBe(0);
    expect(ob.missions.every((m) => m.progress === 0)).toBe(true);
  });

  it("resgatar missão: XP e moedas uma vez só, mesmo com cliques simultâneos", async () => {
    const [a, b] = [await player(), await player()];
    await gs.persist(result([{ id: a.id, team: 0, kills: 1 }, { id: b.id, team: 1 }]));
    const ov = await overview(a);
    const weekly = ov.missions.find((m) => m.code === "DAILY_WIN_1")!;
    const notDone = ov.missions.find((m) => m.code === "DAILY_KILLS_15")!;
    expect((await api(a, "POST", `/progression/missions/${notDone.id}/claim`)).statusCode).toBe(409);
    const res = await Promise.all([1, 2, 3].map(() => api(a, "POST", `/progression/missions/${weekly.id}/claim`)));
    expect(res.map((x) => x.statusCode).sort()).toEqual([200, 409, 409]);
    const after = await overview(a);
    expect(after.totalXp).toBe(ov.totalXp + weekly.rewardXp);
    expect(after.missions.find((m) => m.id === weekly.id)!.claimed).toBe(true);
    expect(after.history.some((h) => h.label === "Missão: Primeira do dia")).toBe(true);

    // Missão com moedas: WEEKLY_MEDALS_10 (completa à mão para testar o crédito).
    const m = await ctx.prisma.mission.findUniqueOrThrow({ where: { code: "WEEKLY_MEDALS_10" } });
    const key = periodKey("WEEKLY", new Date());
    await ctx.prisma.userMission.upsert({ where: { userId_missionId_periodKey: { userId: a.id, missionId: m.id, periodKey: key } }, create: { userId: a.id, missionId: m.id, periodKey: key, progress: 10, completedAt: new Date() }, update: { progress: 10, completedAt: new Date() } });
    expect((await api(a, "POST", `/progression/missions/${m.id}/claim`)).json()).toMatchObject({ coins: m.rewardCoins });
    const tx = await ctx.prisma.walletTransaction.findMany({ where: { walletUserId: a.id, type: "REWARD_CREDIT" } });
    expect(tx.map((t) => t.amount)).toEqual([m.rewardCoins]);
  });

  it("partida de sala não dá progressão; títulos só depois de desbloquear", async () => {
    const [a, b] = [await player(), await player()];
    const room = await ctx.prisma.room.create({ data: { code: "TSTA23", name: "x", ownerId: a.id, mode: "DUEL_1V1", mapId: (await ctx.prisma.gameMap.findFirstOrThrow()).id, maxPlayers: 2, roundsToWin: 1 } });
    await gs.persist(result([{ id: a.id, team: 0, kills: 9, mvp: true }, { id: b.id, team: 1 }], { roomId: room.id }));
    const ov = await overview(a);
    expect(ov.totalXp).toBe(0);
    expect(ov.medals.every((m) => m.count === 0)).toBe(true);

    expect((await api(a, "PUT", "/profile/title", { title: "Ace" })).statusCode).toBe(400);
    const ach = await ctx.prisma.achievement.findUniqueOrThrow({ where: { code: "ACE_1" } });
    await ctx.prisma.userAchievement.create({ data: { userId: a.id, achievementId: ach.id, progress: 1, unlockedAt: new Date() } });
    expect((await overview(a)).titles).toEqual(["Ace"]);
    expect((await api(a, "PUT", "/profile/title", { title: "Ace" })).statusCode).toBe(200);
    expect((await overview(a)).title).toBe("Ace");
    expect((await api(a, "PUT", "/profile/title", { title: null })).statusCode).toBe(200);
  });
});
