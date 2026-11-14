import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_PROTOCOL_VERSION, RANKED_RULES, RANKS, WEAPON_CATALOG, pointsForMmr, rankForPoints, type PlayerMatchStats } from "@vanta/shared";
import { GameServer } from "../src/game/server.js";
import type { MatchResult } from "../src/game/match.js";
import { closeSeason, startSeason } from "../src/modules/ranked/season.service.js";
import { TestClient } from "./game-helpers.js";
import { closeTestContext, createTestContext, newPlayer, resetState, type TestContext } from "./helpers.js";

let ctx: TestContext;
let gs: GameServer;
let url: string;
const SECRET = "segredo-de-teste-com-mais-de-32-caracteres-ok";
const RIFLE = WEAPON_CATALOG.find((w) => w.category === "ASSAULT_RIFLE")!.code;

beforeAll(async () => {
  ctx = await createTestContext();
  gs = new GameServer({ prisma: ctx.prisma, jwtSecret: SECRET, allowedOrigins: [], autoTick: false, recheckMs: 60_000, log: { info() {}, warn() {}, error: console.error } });
  url = `ws://127.0.0.1:${await gs.start(0, "127.0.0.1")}/game`;
});
afterAll(async () => {
  await gs.stop();
  await closeTestContext(ctx);
});
beforeEach(async () => {
  for (const m of gs.matches.values()) for (const p of m.players) m.forfeit(p.userId);
  await Promise.allSettled([...gs.pendingSaves]);
  gs.matches.clear();
  await ctx.prisma.$executeRawUnsafe(`TRUNCATE "Match","RankHistory","RankedSeason" CASCADE`);
  await resetState(ctx);
  const now = Date.now();
  await ctx.prisma.rankedSeason.create({ data: { number: 1, name: "Temporada de teste", startsAt: new Date(now - 1000), endsAt: new Date(now + 30 * 86400_000), isActive: true } });
});

async function register(role?: "ADMIN") {
  const res = await ctx.app.inject({ method: "POST", url: "/auth/register", payload: newPlayer() });
  const j = res.json();
  if (role) await ctx.prisma.user.update({ where: { id: j.user.id }, data: { role } });
  return { token: j.accessToken as string, userId: j.user.id as string, username: j.user.username as string, auth: { authorization: `Bearer ${j.accessToken}` } };
}
type Player = Awaited<ReturnType<typeof register>>;

async function connect(p: Player) {
  const c = new TestClient(url);
  await c.open();
  c.send({ t: "hello", token: p.token, v: GAME_PROTOCOL_VERSION });
  await c.waitFor("welcome");
  return c;
}

const season = () => ctx.prisma.rankedSeason.findFirstOrThrow({ where: { isActive: true } });

async function setRating(userId: string, mode: "DUEL_1V1" | "TEAM_2V2" | "TEAM_3V3", data: { mmr?: number; points?: number; placementLeft?: number; winStreak?: number; rd?: number }) {
  const s = await season();
  const row = { mmr: data.mmr ?? 1500, mmrDeviation: data.rd ?? 80, points: data.points ?? 0, peakPoints: data.points ?? 0, placementLeft: data.placementLeft ?? 0, winStreak: data.winStreak ?? 0 };
  await ctx.prisma.rankedRating.upsert({ where: { userId_seasonId_mode: { userId, seasonId: s.id, mode } }, update: row, create: { userId, seasonId: s.id, mode, ...row } });
}
const rating = async (userId: string, mode: "DUEL_1V1" | "TEAM_2V2" | "TEAM_3V3" = "DUEL_1V1") => ctx.prisma.rankedRating.findFirst({ where: { userId, mode, seasonId: (await season()).id } });

/** Resultado de partida fabricado (como o que `Match` entrega ao terminar), para testar a gravação. */
function fakeResult(over: Omit<Partial<MatchResult>, "players"> & { players: Array<{ id: string; team: 0 | 1; abandoned?: boolean; mvp?: boolean }> }): MatchResult {
  const stats = (p: (typeof over.players)[number]): PlayerMatchStats & { characterId: string | null } => ({ id: p.id, username: p.id, team: p.team, kills: 5, deaths: 3, assists: 1, headshots: 2, damage: 500, shots: 40, hits: 20, abandoned: !!p.abandoned, mvp: !!p.mvp, characterId: null });
  return { matchId: crypto.randomUUID(), mode: "1v1", mapCode: "NEON_DISTRICT", ranked: true, winner: 0, score: [5, 2], reason: "score", startedAt: new Date(Date.now() - 300_000), endedAt: new Date(), roundsToWin: 5, events: [], ...over, players: over.players.map(stats) };
}

describe("fila ranqueada", () => {
  it("sem temporada em andamento a fila ranqueada é recusada (a casual continua)", async () => {
    await ctx.prisma.rankedSeason.updateMany({ data: { isActive: false } });
    const a = await register();
    const c = await connect(a);
    c.send({ t: "queue", mode: "1v1", loadout: [RIFLE], ranked: true });
    expect((await c.waitFor("error")).code).toBe("NO_SEASON");
    c.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    expect(await c.waitFor("queue", (m) => m.state === "searching")).toMatchObject({ ranked: false, inQueue: 1 });
    c.close();
  });

  it("filas casual e ranqueada são separadas", async () => {
    const [a, b] = [await register(), await register()];
    const [ca, cb] = [await connect(a), await connect(b)];
    ca.send({ t: "queue", mode: "1v1", loadout: [RIFLE], ranked: true });
    await ca.waitFor("queue", (m) => m.state === "searching" && m.ranked === true);
    cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    expect(await cb.waitFor("queue", (m) => m.state === "searching")).toMatchObject({ ranked: false, inQueue: 1 });
    expect(gs.matches.size).toBe(0);
    ca.close();
    cb.close();
  });

  it("partida ranqueada: vitória soma pontos, abandono é punido, MMR e auditoria gravados, fila bloqueada", async () => {
    const [a, b] = [await register(), await register()];
    const [ca, cb] = [await connect(a), await connect(b)];
    ca.send({ t: "queue", mode: "1v1", loadout: [RIFLE], ranked: true });
    await ca.waitFor("queue", (m) => m.state === "searching");
    cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE], ranked: true });
    const info = (await ca.waitFor("match")).info;
    expect(info.ranked).toBe(true);
    await cb.waitFor("match");

    cb.send({ t: "leave_match" }); // B abandona: A vence por W.O.
    await cb.waitFor("left_match");
    const ra = await ca.waitFor("ranked_result");
    await Promise.all([...gs.pendingSaves]);

    // A: primeira vitória na classificação (ganho dobrado), ainda sem patente visível.
    expect(ra).toMatchObject({ outcome: "WIN", pointsBefore: 0, rankBefore: null, rankAfter: null, placementLeft: RANKED_RULES.placementMatches - 1, placed: false, winStreak: 1 });
    expect(ra.delta).toBeGreaterThanOrEqual(RANKED_RULES.baseWin * RANKED_RULES.placementWinMult);
    expect(ra).not.toHaveProperty("mmr");
    const rowA = await rating(a.userId);
    const rowB = await rating(b.userId);
    expect(rowA).toMatchObject({ points: ra.pointsAfter, wins: 1, losses: 0, winStreak: 1 });
    expect(rowA!.mmr).toBeGreaterThan(1500);
    expect(rowA!.mmrDeviation).toBeLessThan(350);
    expect(rowB).toMatchObject({ points: 0, wins: 0, losses: 1, abandons: 1, placementLeft: RANKED_RULES.placementMatches - 1 });
    expect(rowB!.mmr).toBeLessThan(1500);

    const match = await ctx.prisma.match.findUniqueOrThrow({ where: { id: info.matchId }, include: { players: true } });
    expect(match).toMatchObject({ type: "RANKED", seasonId: (await season()).id, winnerTeam: info.yourTeam });
    const pa = match.players.find((p) => p.userId === a.userId)!;
    const pb = match.players.find((p) => p.userId === b.userId)!;
    expect(pa).toMatchObject({ result: "WIN", pointsDelta: ra.delta, mmrBefore: 1500 });
    expect(pa.mmrAfter).toBeCloseTo(rowA!.mmr, 6);
    expect(pb).toMatchObject({ result: "ABANDONED", pointsDelta: 0, abandoned: true });

    // Quem abandonou fica bloqueado na ranqueada (5 min), mas pode jogar casual.
    cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE], ranked: true });
    expect((await cb.waitFor("error", (m) => m.code === "RANKED_COOLDOWN")).message).toContain("5 min");
    cb.msgs.length = 0;
    cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    expect((await cb.waitFor("queue", (m) => m.state === "searching")).ranked).toBe(false);
    const over = (await ctx.app.inject({ url: "/ranked/overview", headers: b.auth })).json();
    expect(over.cooldownSeconds).toBeGreaterThan(200);
    ca.close();
    cb.close();
  });

  it("partida casual não mexe em rating nem em pontos", async () => {
    const [a, b] = [await register(), await register()];
    const [ca, cb] = [await connect(a), await connect(b)];
    ca.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    const info = (await ca.waitFor("match")).info;
    expect(info.ranked).toBe(false);
    await cb.waitFor("match");
    cb.send({ t: "leave_match" });
    await cb.waitFor("left_match");
    await new Promise((r) => setTimeout(r, 100));
    await Promise.all([...gs.pendingSaves]);
    expect(await ctx.prisma.rankedRating.count()).toBe(0);
    const m = await ctx.prisma.match.findUniqueOrThrow({ where: { id: info.matchId }, include: { players: true } });
    expect(m.type).toBe("CASUAL");
    expect(m.players.every((p) => p.pointsDelta === null && p.mmrAfter === null)).toBe(true);
    expect(ca.msgs.some((x) => x.t === "ranked_result")).toBe(false);
    ca.close();
    cb.close();
  });

  it("matchmaking por MMR: diferença grande espera a janela abrir", async () => {
    const [a, b] = [await register(), await register()];
    await setRating(a.userId, "DUEL_1V1", { mmr: 1500 });
    await setRating(b.userId, "DUEL_1V1", { mmr: 2000 });
    const [ca, cb] = [await connect(a), await connect(b)];
    ca.send({ t: "queue", mode: "1v1", loadout: [RIFLE], ranked: true });
    cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE], ranked: true });
    await cb.waitFor("queue", (m) => m.inQueue === 2);
    gs.matchmakingTick();
    expect(gs.matches.size).toBe(0);
    gs.matchmakingTick(Date.now() + 10_000); // janela de 350: ainda não
    expect(gs.matches.size).toBe(0);
    gs.matchmakingTick(Date.now() + 20_000); // janela de 600: forma a partida
    expect((await ca.waitFor("match")).info.ranked).toBe(true);
    ca.close();
    cb.close();
  });

  it("2v2 ranqueado balanceia as equipes pela soma de MMR", async () => {
    const mmrs = [1560, 1540, 1500, 1480];
    const players: Array<Player & { mmr: number }> = [];
    for (const mmr of mmrs) {
      const p = await register();
      await setRating(p.userId, "TEAM_2V2", { mmr });
      players.push({ ...p, mmr });
    }
    const conns: TestClient[] = [];
    for (const p of players) {
      const c = await connect(p);
      c.send({ t: "queue", mode: "2v2", loadout: [RIFLE], ranked: true });
      if (conns.length < 3) await c.waitFor("queue", (m) => m.state === "searching"); // o 4º já forma a partida
      conns.push(c);
    }
    const info = (await conns[0]!.waitFor("match")).info;
    const sum = (team: 0 | 1) => info.players.filter((p) => p.team === team).reduce((s, p) => s + players.find((x) => x.userId === p.id)!.mmr, 0);
    expect(Math.abs(sum(0) - sum(1))).toBe(0); // 1560+1480 = 1540+1500
    conns.forEach((c) => c.close());
  });
});

describe("resultado ranqueado (gravação)", () => {
  it("fora da classificação: vencedor sobe, perdedor desce, promoção entra no histórico", async () => {
    const [a, b] = [await register(), await register()];
    const edge = RANKS[5]!.minPoints - 5; // a 5 pontos de subir de patente
    await setRating(a.userId, "DUEL_1V1", { mmr: 1500, points: edge, winStreak: 2 });
    await setRating(b.userId, "DUEL_1V1", { mmr: 1500, points: 600 });
    await gs.persist(fakeResult({ players: [{ id: a.userId, team: 0, mvp: true }, { id: b.userId, team: 1 }] }));
    const ra = (await rating(a.userId))!;
    const rb = (await rating(b.userId))!;
    expect(ra.points).toBeGreaterThan(edge + RANKED_RULES.baseWin - RANKED_RULES.maxConvergence);
    expect(ra.winStreak).toBe(3);
    expect(ra.peakPoints).toBe(ra.points);
    expect(rb.points).toBeLessThan(600);
    expect(rb.points).toBeGreaterThanOrEqual(600 - RANKED_RULES.baseLoss - RANKED_RULES.maxConvergence);
    expect(ra.mmr - 1500).toBeCloseTo(1500 - rb.mmr, 6);
    const hist = await ctx.prisma.rankHistory.findMany({ where: { userId: a.userId } });
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ fromOrder: 5, toOrder: 6 });
    expect(await ctx.prisma.rankHistory.count({ where: { userId: b.userId } })).toBe(0);
  });

  it("última partida da classificação define a patente inicial pelo MMR", async () => {
    const [a, b] = [await register(), await register()];
    await setRating(a.userId, "DUEL_1V1", { mmr: 1650, points: 120, placementLeft: 1 });
    await setRating(b.userId, "DUEL_1V1", { mmr: 1500, points: 700 });
    await gs.persist(fakeResult({ players: [{ id: a.userId, team: 0 }, { id: b.userId, team: 1 }] }));
    const ra = (await rating(a.userId))!;
    expect(ra.placementLeft).toBe(0);
    expect(ra.points).toBe(pointsForMmr(ra.mmr));
    const hist = await ctx.prisma.rankHistory.findFirstOrThrow({ where: { userId: a.userId } });
    expect(hist).toMatchObject({ fromOrder: 0, toOrder: rankForPoints(ra.points).order });
  });

  it("2v2: aliado de quem abandonou perde só metade; quem abandonou leva a penalidade", async () => {
    const ps = [await register(), await register(), await register(), await register()];
    for (const p of ps) await setRating(p.userId, "TEAM_2V2", { mmr: 1500, points: 787 });
    await gs.persist(fakeResult({ mode: "2v2", winner: 0, reason: "score", players: [{ id: ps[0]!.userId, team: 0 }, { id: ps[1]!.userId, team: 0 }, { id: ps[2]!.userId, team: 1 }, { id: ps[3]!.userId, team: 1, abandoned: true }] }));
    const pts = await Promise.all(ps.map(async (p) => (await rating(p.userId, "TEAM_2V2"))!.points - 787));
    expect(pts[0]).toBeGreaterThan(0);
    expect(pts[3]).toBe(-RANKED_RULES.abandonPenalty);
    expect(pts[2]).toBeLessThan(0);
    expect(Math.abs(pts[2]!)).toBeLessThanOrEqual(Math.ceil((RANKED_RULES.baseLoss + RANKED_RULES.maxConvergence) / 2));
  });

  it("partida que termina depois do fim da temporada não pontua", async () => {
    const [a, b] = [await register(), await register()];
    await ctx.prisma.rankedSeason.updateMany({ data: { endsAt: new Date(Date.now() - 1000) } });
    const r = fakeResult({ players: [{ id: a.userId, team: 0 }, { id: b.userId, team: 1 }] });
    await gs.persist(r);
    expect(await ctx.prisma.rankedRating.count()).toBe(0);
    expect((await ctx.prisma.match.findUniqueOrThrow({ where: { id: r.matchId } })).seasonId).toBeNull();
  });
});

describe("API do competitivo", () => {
  it("visão geral: temporada, situação por modo e histórico, sem expor o MMR", async () => {
    const [a, b] = [await register(), await register()];
    await setRating(a.userId, "DUEL_1V1", { mmr: 1700, points: 900 });
    await setRating(b.userId, "DUEL_1V1", { mmr: 1500, points: 700 });
    await gs.persist(fakeResult({ players: [{ id: a.userId, team: 0 }, { id: b.userId, team: 1 }] }));
    const res = await ctx.app.inject({ url: "/ranked/overview", headers: a.auth });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/mmr/i);
    const body = res.json();
    expect(body.season.name).toBe("Temporada de teste");
    const duel = body.modes.find((m: { mode: string }) => m.mode === "1v1");
    expect(duel).toMatchObject({ wins: 1, losses: 0, placementLeft: 0, rankOrder: rankForPoints(duel.points).order });
    expect(body.modes.find((m: { mode: string }) => m.mode === "3v3")).toMatchObject({ rankOrder: null, placementLeft: 5, points: 0 });
    expect(body.recent).toHaveLength(1);
    expect(body.recent[0]).toMatchObject({ mode: "1v1", result: "WIN", score: [5, 2], map: "Neon District" });
    expect(body.recent[0].pointsDelta).toBeGreaterThan(0);
    expect((await ctx.app.inject({ url: "/ranked/overview" })).statusCode).toBe(401);
  });

  it("ranking: ordenado por pontos, só quem terminou a classificação, com a posição de quem consulta", async () => {
    const ps = [];
    for (let i = 0; i < 5; i++) ps.push(await register());
    await setRating(ps[0]!.userId, "DUEL_1V1", { points: 300 });
    await setRating(ps[1]!.userId, "DUEL_1V1", { points: 1200 });
    await setRating(ps[2]!.userId, "DUEL_1V1", { points: 800 });
    await setRating(ps[3]!.userId, "DUEL_1V1", { points: 5000, placementLeft: 2 }); // em classificação: fora
    await setRating(ps[4]!.userId, "TEAM_2V2", { points: 9000 }); // outro modo
    const res = await ctx.app.inject({ url: "/ranked/leaderboard?mode=1v1", headers: ps[0]!.auth });
    expect(res.body).not.toMatch(/mmr/i);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.entries.map((e: { username: string }) => e.username)).toEqual([ps[1]!.username, ps[2]!.username, ps[0]!.username]);
    expect(body.entries[0]).toMatchObject({ position: 1, points: 1200, rankOrder: rankForPoints(1200).order });
    expect(body.me).toMatchObject({ position: 3, points: 300 });
    const page = (await ctx.app.inject({ url: "/ranked/leaderboard?mode=1v1&limit=1&offset=1", headers: ps[3]!.auth })).json();
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ position: 2, username: ps[2]!.username });
    expect(page.me).toBeNull();
    expect((await ctx.app.inject({ url: "/ranked/leaderboard?mode=5v5", headers: ps[0]!.auth })).statusCode).toBe(400);
  });

  it("temporadas: encerrar publica o ranking final; a próxima começa com reinício parcial", async () => {
    const [a, b, c] = [await register(), await register(), await register()];
    await setRating(a.userId, "DUEL_1V1", { mmr: 1900, points: 1001, rd: 60 });
    await setRating(b.userId, "DUEL_1V1", { mmr: 1400, points: 400 });
    await setRating(c.userId, "DUEL_1V1", { mmr: 1500, points: 50, placementLeft: 3 });
    const s1 = await season();
    const closed = await closeSeason(ctx.prisma, s1.id);
    expect(closed.isActive).toBe(false);
    const snap = closed.leaderboardSnapshot as Record<string, Array<{ username: string; position: number; points: number }>>;
    expect(snap.DUEL_1V1!.map((e) => e.username)).toEqual([a.username, b.username]);
    await expect(closeSeason(ctx.prisma, s1.id)).rejects.toMatchObject({ code: "SEASON_CLOSED" });

    const { season: s2, carried } = await startSeason(ctx.prisma, { name: "Temporada 2 — Faísca", durationDays: 60 });
    expect(s2).toMatchObject({ number: 2, isActive: true });
    expect(carried).toBe(2);
    const na = (await rating(a.userId))!;
    expect(na).toMatchObject({ seasonId: s2.id, points: 500, placementLeft: 5, wins: 0 });
    expect(na.mmr).toBe(1800);
    expect(na.mmrDeviation).toBe(200);
    expect(await rating(c.userId)).toBeNull(); // não terminou a classificação: começa do zero
    await expect(startSeason(ctx.prisma, { durationDays: 60 })).rejects.toMatchObject({ code: "SEASON_ACTIVE" });

    const list = (await ctx.app.inject({ url: "/ranked/seasons" })).json();
    expect(list.map((s: { number: number }) => s.number)).toEqual([2, 1]);
    expect(list[1].top["1v1"][0]).toMatchObject({ username: a.username, position: 1 });
  });

  it("administração de temporadas exige papel ADMIN e fica auditada", async () => {
    const player = await register();
    const admin = await register("ADMIN");
    expect((await ctx.app.inject({ method: "POST", url: "/admin/ranked/seasons/close", headers: player.auth })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: "/admin/ranked/seasons/close" })).statusCode).toBe(401);
    const close = await ctx.app.inject({ method: "POST", url: "/admin/ranked/seasons/close", headers: admin.auth });
    expect(close.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/admin/ranked/seasons/close", headers: admin.auth })).statusCode).toBe(409);
    const start = await ctx.app.inject({ method: "POST", url: "/admin/ranked/seasons/start", headers: admin.auth, payload: { name: "Temporada 2", durationDays: 30 } });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ number: 2, name: "Temporada 2" });
    const logs = await ctx.prisma.adminAuditLog.findMany({ where: { actorId: admin.userId }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["ranked.season.close", "ranked.season.start"]);
  });
});
