import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ClanLeaderboardResponse, ClanView, LevelLeaderboardResponse, MyClanResponse, PlayerMatchStats, PublicProfileResponse } from "@vanta/shared";
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
  await ctx.prisma.$executeRawUnsafe(`TRUNCATE "Match", "Clan", "Room" CASCADE`);
  await resetState(ctx);
});

interface P {
  id: string;
  name: string;
  token: string;
}
async function player(): Promise<P> {
  const body = newPlayer();
  const j = (await ctx.app.inject({ method: "POST", url: "/auth/register", payload: body })).json();
  return { id: j.user.id, name: body.username, token: j.accessToken };
}
const api = (p: P, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) => ctx.app.inject({ method, url, headers: { authorization: `Bearer ${p.token}` }, payload });

describe("clãs", () => {
  it("cria clã com tag única, convida, aceita, e o convite fechado é o único caminho de entrada", async () => {
    const [a, b, c] = [await player(), await player(), await player()];
    const r = await api(a, "POST", "/clans", { name: "Esquadrão Neon", tag: "neo", isOpen: false, logoKey: "hex:red" });
    expect(r.statusCode).toBe(200);
    const clan = r.json() as ClanView;
    expect(clan).toMatchObject({ tag: "NEO", myRole: "LEADER", points: 1500, position: 1, isOpen: false });

    expect((await api(b, "POST", "/clans", { name: "esquadrão neon", tag: "OUT" })).json().error.code).toBe("CLAN_TAKEN");
    expect((await api(b, "POST", "/clans", { name: "Outro", tag: "NEO" })).json().error.code).toBe("CLAN_TAKEN");
    expect((await api(b, "POST", `/clans/${clan.id}/join`)).statusCode).toBe(403);

    expect((await api(a, "POST", "/clans/me/invites", { username: b.name })).statusCode).toBe(200);
    expect((await api(c, "POST", "/clans/me/invites", { username: b.name })).json().error.code).toBe("NOT_IN_CLAN");
    const mine = (await api(b, "GET", "/clans/me")).json() as MyClanResponse;
    expect(mine.clan).toBeNull();
    expect(mine.invites).toHaveLength(1);
    expect((await api(c, "POST", `/clans/invites/${mine.invites[0]!.id}/accept`)).statusCode).toBe(404);
    const joined = (await api(b, "POST", `/clans/invites/${mine.invites[0]!.id}/accept`)).json() as ClanView;
    expect(joined.members.map((m) => [m.username, m.role])).toEqual([[a.name, "LEADER"], [b.name, "MEMBER"]]);
    expect(joined.myRole).toBe("MEMBER");
    expect((await api(b, "POST", "/clans", { name: "Segundo", tag: "SEG" })).json().error.code).toBe("ALREADY_IN_CLAN");
    expect((await api(a, "POST", "/clans/me/invites", { username: b.name })).json().error.code).toBe("ALREADY_IN_CLAN");
  });

  it("cargos: membro não remove ninguém, oficial remove membro mas não oficial, só o líder promove e transfere", async () => {
    const [a, b, c, d] = [await player(), await player(), await player(), await player()];
    const clan = (await api(a, "POST", "/clans", { name: "Ordem Alfa", tag: "ALFA" })).json() as ClanView;
    for (const p of [b, c, d]) expect((await api(p, "POST", `/clans/${clan.id}/join`)).statusCode).toBe(200);

    expect((await api(b, "POST", "/clans/me/kick", { userId: c.id })).statusCode).toBe(403);
    expect((await api(b, "POST", "/clans/me/role", { userId: c.id, role: "OFFICER" })).statusCode).toBe(403);
    expect((await api(a, "POST", "/clans/me/role", { userId: b.id, role: "OFFICER" })).statusCode).toBe(200);
    expect((await api(a, "POST", "/clans/me/role", { userId: c.id, role: "OFFICER" })).statusCode).toBe(200);
    expect((await api(b, "POST", "/clans/me/kick", { userId: c.id })).statusCode).toBe(403);
    expect((await api(b, "POST", "/clans/me/kick", { userId: a.id })).statusCode).toBe(403);
    const afterKick = (await api(b, "POST", "/clans/me/kick", { userId: d.id })).json() as ClanView;
    expect(afterKick.members.map((m) => m.username)).not.toContain(d.name);
    expect((await api(b, "PATCH", "/clans/me", { isOpen: false })).statusCode).toBe(403);
    expect((await api(b, "PATCH", "/clans/me", { description: "Treino toda quinta" })).json().description).toBe("Treino toda quinta");

    const t = (await api(a, "POST", "/clans/me/transfer", { userId: c.id })).json() as ClanView;
    expect(t.members.find((m) => m.userId === c.id)!.role).toBe("LEADER");
    expect(t.myRole).toBe("OFFICER");
    expect((await ctx.prisma.clan.findUniqueOrThrow({ where: { id: clan.id } })).ownerId).toBe(c.id);
  });

  it("líder que sai passa a liderança para o oficial mais antigo; o último a sair apaga o clã", async () => {
    const [a, b, c] = [await player(), await player(), await player()];
    const clan = (await api(a, "POST", "/clans", { name: "Lobos", tag: "LOB" })).json() as ClanView;
    await api(b, "POST", `/clans/${clan.id}/join`);
    await api(c, "POST", `/clans/${clan.id}/join`);
    await api(a, "POST", "/clans/me/role", { userId: c.id, role: "OFFICER" });
    expect((await api(a, "POST", "/clans/me/leave")).json()).toMatchObject({ disbanded: false, newLeader: c.id });
    await api(b, "POST", "/clans/me/leave");
    expect((await api(c, "POST", "/clans/me/leave")).json()).toMatchObject({ disbanded: true });
    expect(await ctx.prisma.clan.count()).toBe(0);
  });

  it("partida da fila com 2 membros no mesmo time entra no histórico e mexe nos pontos; sala não conta", async () => {
    const [a, b, c, d] = [await player(), await player(), await player(), await player()];
    const clan = (await api(a, "POST", "/clans", { name: "Duo Forte", tag: "DUO" })).json() as ClanView;
    await api(b, "POST", `/clans/${clan.id}/join`);
    const solo = (await api(c, "POST", "/clans", { name: "Sozinho", tag: "SOLO" })).json() as ClanView;

    type Pl = Partial<PlayerMatchStats> & { id: string; team: 0 | 1 };
    const result = (players: Pl[], over: Partial<MatchResult> = {}): MatchResult => ({
      matchId: crypto.randomUUID(), mode: "2v2", mapCode: "NEON_DISTRICT", ranked: false, winner: 0, score: [6, 3], reason: "score",
      startedAt: new Date(Date.now() - 300_000), endedAt: new Date(), roundsToWin: 6, roomId: null, events: [], ...over,
      players: players.map((p) => ({ username: p.id, kills: 0, deaths: 0, assists: 0, headshots: 0, damage: 0, shots: 0, hits: 0, abandoned: false, mvp: false, characterId: null, ...p })),
    });
    const lineup: Pl[] = [{ id: a.id, team: 0 }, { id: b.id, team: 0 }, { id: c.id, team: 1 }, { id: d.id, team: 1 }];
    await gs.persist(result(lineup));
    await gs.persist(result(lineup, { winner: 1, score: [2, 6] }));
    const room = await ctx.prisma.room.create({ data: { code: "ABCDEF", name: "Treino", ownerId: a.id, mode: "TEAM_2V2", mapId: (await ctx.prisma.gameMap.findFirstOrThrow()).id, options: {}, maxPlayers: 4, roundsToWin: 6 } });
    await gs.persist(result(lineup, { roomId: room.id }));

    const v = (await api(a, "GET", "/clans/me")).json() as MyClanResponse;
    expect(v.clan).toMatchObject({ points: 1505, wins: 1, losses: 1 });
    expect(v.clan!.history.map((h) => [h.result, h.pointsDelta])).toEqual([["LOSS", -15], ["WIN", 20]]);
    expect(v.clan!.history[0]!.members.sort()).toEqual([a.name, b.name].sort());
    // Um membro só no time não registra partida de clã.
    expect((await api(c, "GET", "/clans/tag/solo")).json()).toMatchObject({ id: solo.id, wins: 0, losses: 0, history: [] });

    const board = (await api(d, "GET", "/rankings/clans")).json() as ClanLeaderboardResponse;
    expect(board.entries.map((e) => e.tag)).toEqual(["DUO", "SOLO"]);
    expect(board.mine).toBeNull();
  });
});

describe("perfil público, cartão e ranking de nível", () => {
  it("mostra cartão com clã e estatísticas; bloqueio esconde o perfil; banido some", async () => {
    const [a, b] = [await player(), await player()];
    await api(a, "POST", "/clans", { name: "Vanguarda", tag: "VNG" });
    const prof = (await api(b, "GET", `/players/${a.name.toLowerCase()}`)).json() as PublicProfileResponse;
    expect(prof.card).toMatchObject({ username: a.name, level: 1, clan: { tag: "VNG" }, playerCardKey: "default", rankOrder: null });
    expect(prof.relation).toBe("none");
    expect((await api(a, "GET", `/players/${a.name}`)).json().relation).toBe("self");

    await ctx.prisma.userBlock.create({ data: { blockerId: a.id, blockedId: b.id } });
    expect((await api(b, "GET", `/players/${a.name}`)).statusCode).toBe(404);
    await ctx.prisma.user.update({ where: { id: b.id }, data: { status: "BANNED" } });
    expect((await api(a, "GET", `/players/${b.name}`)).statusCode).toBe(404);
  });

  it("cartão só abre no nível dele; ranking de nível ordena por XP", async () => {
    const [a, b] = [await player(), await player()];
    expect((await api(a, "PUT", "/profile/card", { playerCardKey: "circuit", avatarKey: "red" })).statusCode).toBe(403);
    expect((await api(a, "PUT", "/profile/card", { playerCardKey: "inventado", avatarKey: "red" })).statusCode).toBe(400);
    await ctx.prisma.userProfile.update({ where: { userId: a.id }, data: { totalXp: 5000 } });
    const card = (await api(a, "PUT", "/profile/card", { playerCardKey: "circuit", avatarKey: "red" })).json();
    expect(card).toMatchObject({ playerCardKey: "circuit", avatarKey: "red" });

    const board = (await api(b, "GET", "/rankings/level")).json() as LevelLeaderboardResponse;
    expect(board.entries[0]).toMatchObject({ username: a.name, totalXp: 5000 });
    expect(board.me).toMatchObject({ position: 2, totalXp: 0 });
  });

  it("ranking ranqueado aceita temporada: temporada inexistente não devolve ninguém", async () => {
    const a = await player();
    const r = (await api(a, "GET", "/ranked/leaderboard?mode=2v2&seasonId=nao-existe")).json();
    expect(r).toMatchObject({ season: null, entries: [] });
    const seasons = (await api(a, "GET", "/ranked/seasons")).json() as Array<{ id: string; name: string }>;
    if (seasons[0]) expect((await api(a, "GET", `/ranked/leaderboard?mode=1v1&seasonId=${seasons[0].id}`)).json().season).toBe(seasons[0].name);
  });
});
