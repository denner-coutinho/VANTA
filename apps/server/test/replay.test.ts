import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { PlayerMatchStats, ReplayFile, SpecFrame } from "@vanta/shared";
import { GameServer } from "../src/game/server.js";
import type { MatchResult } from "../src/game/match.js";
import { pruneReplays } from "../src/modules/matches/replay.js";
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

function result(a: P, b: P): MatchResult {
  const matchId = crypto.randomUUID();
  const frames: SpecFrame[] = Array.from({ length: 300 }, (_, i) => ({
    t: "spec",
    tick: 1000 + i * 4,
    phase: "live",
    phaseEndsIn: 60_000,
    round: 1,
    score: [0, 0],
    players: [[a.id, i * 0.01, 0, -20, 0, 0, 0, 1, 0, 100, 1, 0], [b.id, 5, 0, -15, 3.1, 0, 0, 1, 0, 100, 1, 1]],
    kd: [[a.id, 0, 0, 0], [b.id, 0, 0, 0]],
    ev: i === 299 ? [{ k: "kill", killer: a.id, victim: b.id, weapon: "VK-7", head: true }] : [],
  }));
  const players = [a, b].map((p, i) => ({ id: p.id, username: p.id, kills: 0, deaths: 0, assists: 0, headshots: 0, damage: 0, shots: 0, hits: 0, abandoned: false, mvp: i === 0, characterId: null, team: i as 0 | 1 })) as Array<PlayerMatchStats & { characterId: string | null }>;
  const replay: ReplayFile = { v: 1, matchId, mode: "1v1", map: "NEON_DISTRICT", roundsToWin: 5, rules: null, players: players.map((p) => ({ id: p.id, username: p.username, team: p.team, color: "#287BFF", character: "RAVEN", loadout: [], connected: true })), startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), frames };
  return { matchId, mode: "1v1", mapCode: "NEON_DISTRICT", ranked: false, winner: 0, score: [5, 0], reason: "score", startedAt: new Date(Date.now() - 60_000), endedAt: new Date(), roundsToWin: 5, roomId: null, events: [], players, replay };
}

describe("replays", () => {
  it("a partida grava o replay compactado com hash; só quem jogou baixa", async () => {
    const [a, b, c] = [await player(), await player(), await player()];
    const r = result(a, b);
    await gs.persist(r);
    const row = await ctx.prisma.matchReplay.findUniqueOrThrow({ where: { matchId: r.matchId } });
    expect(row).toMatchObject({ version: 1, frameCount: 300 });
    expect(row.sizeBytes).toBeLessThan(JSON.stringify(r.replay).length / 3);
    const match = await ctx.prisma.match.findUniqueOrThrow({ where: { id: r.matchId } });
    expect(match.replayHash).toBe(row.sha256);

    const res = await ctx.app.inject({ method: "GET", url: `/matches/${r.matchId}/replay`, headers: { authorization: `Bearer ${a.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(createHash("sha256").update(res.rawPayload).digest("hex")).toBe(res.headers["x-replay-sha256"]);
    const file = JSON.parse(gunzipSync(res.rawPayload).toString()) as ReplayFile;
    expect(file.matchId).toBe(r.matchId);
    expect(file.frames).toHaveLength(300);
    expect(file.frames[299]!.ev[0]).toMatchObject({ k: "kill", killer: a.id });

    expect((await ctx.app.inject({ method: "GET", url: `/matches/${r.matchId}/replay`, headers: { authorization: `Bearer ${c.token}` } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/matches/${r.matchId}/replay` })).statusCode).toBe(401);
  });

  it("replays com mais de 30 dias são apagados; a partida fica", async () => {
    const [a, b] = [await player(), await player()];
    const r = result(a, b);
    await gs.persist(r);
    expect(await pruneReplays(ctx.prisma)).toBe(0);
    expect(await pruneReplays(ctx.prisma, new Date(Date.now() + 31 * 86_400_000))).toBe(1);
    expect(await ctx.prisma.matchReplay.count()).toBe(0);
    expect(await ctx.prisma.match.findUniqueOrThrow({ where: { id: r.matchId } })).toMatchObject({ replayHash: null });
    const res = await ctx.app.inject({ method: "GET", url: `/matches/${r.matchId}/replay`, headers: { authorization: `Bearer ${a.token}` } });
    expect(res.statusCode).toBe(404);
  });
});
