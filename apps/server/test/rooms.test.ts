import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_PROTOCOL_VERSION, defaultRoomSettings, type RoomSettings, type RoomView, type ServerMessage } from "@vanta/shared";
import { GameServer } from "../src/game/server.js";
import { PasswordHasher } from "../src/lib/password.js";
import { TestClient } from "./game-helpers.js";
import { closeTestContext, createTestContext, newPlayer, resetState, type TestContext } from "./helpers.js";

let ctx: TestContext;
let gs: GameServer;
let url: string;
const SECRET = "segredo-de-teste-com-mais-de-32-caracteres-ok";
const open: TestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  gs = new GameServer({ prisma: ctx.prisma, jwtSecret: SECRET, allowedOrigins: [], autoTick: false, recheckMs: 60_000, bus: ctx.bus, roomGraceMs: 300, hasher: new PasswordHasher(1024), log: { info() {}, warn() {}, error: console.error } });
  url = `ws://127.0.0.1:${await gs.start(0, "127.0.0.1")}/game`;
});
afterAll(async () => {
  await gs.stop();
  await closeTestContext(ctx);
});
beforeEach(async () => {
  for (const c of open.splice(0)) c.close();
  await new Promise((r) => setTimeout(r, 50));
  for (const m of gs.matches.values()) for (const p of m.players) m.forfeit(p.userId);
  await Promise.allSettled([...gs.pendingSaves]);
  gs.matches.clear();
  for (const r of gs.rooms.all()) gs.rooms.close(r);
  await ctx.prisma.$executeRawUnsafe(`TRUNCATE "Match","Room" CASCADE`);
  await resetState(ctx);
});

interface P {
  id: string;
  username: string;
  token: string;
}
async function player(): Promise<P> {
  const j = (await ctx.app.inject({ method: "POST", url: "/auth/register", payload: newPlayer() })).json();
  return { id: j.user.id, username: j.user.username, token: j.accessToken };
}
const api = (p: P, method: "GET" | "POST" | "DELETE", u: string, payload?: object) => ctx.app.inject({ method, url: u, headers: { authorization: `Bearer ${p.token}` }, payload });
async function befriend(a: P, b: P) {
  const id = (await api(a, "POST", "/social/requests", { username: b.username })).json().requestId;
  expect((await api(b, "POST", `/social/requests/${id}/accept`)).statusCode).toBe(200);
}
async function connect(p: P) {
  const c = new TestClient(url);
  open.push(c);
  await c.open();
  c.send({ t: "hello", token: p.token, v: GAME_PROTOCOL_VERSION });
  await c.waitFor("welcome");
  await c.waitFor("presence", (m) => m.full);
  return c;
}
/** Última visão da sala recebida (espera uma que satisfaça a condição). */
async function room(c: TestClient, pred: (r: RoomView) => boolean = () => true): Promise<RoomView> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const last = c.msgs.filter((m): m is Extract<ServerMessage, { t: "room" }> => m.t === "room").at(-1);
    if (last?.room && pred(last.room)) return last.room;
    if (Date.now() > deadline) throw new Error(`sala não chegou: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const lastRoomMsg = (c: TestClient) => c.msgs.filter((m): m is Extract<ServerMessage, { t: "room" }> => m.t === "room").at(-1);
async function error(c: TestClient, code: string) {
  return c.waitFor("error", (m) => m.code === code);
}
async function until(pred: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("condição não atingida");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settings = (over: Partial<RoomSettings> = {}): RoomSettings => ({ ...defaultRoomSettings("Teste"), mode: "1v1", map: "FROST_BASE", roundsToWin: 1, ...over });

async function createRoom(c: TestClient, over: Partial<RoomSettings> = {}, password?: string) {
  c.send({ t: "room_create", settings: settings(over), ...(password ? { password } : {}) });
  return room(c);
}

describe("salas personalizadas", () => {
  it("criar, listar só as públicas, entrar por código e gravar no banco", async () => {
    const [a, b, x] = [await player(), await player(), await player()];
    const [ca, cb, cx] = [await connect(a), await connect(b), await connect(x)];
    const pub = await createRoom(ca, { name: "Treino aberto" });
    expect(pub.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(pub.ownerId).toBe(a.id);
    expect(pub.members).toEqual([expect.objectContaining({ id: a.id, team: 0, online: true })]);
    await createRoom(cx, { name: "Secreta", isPrivate: true });

    cb.send({ t: "room_list" });
    const list = await cb.waitFor("room_list");
    expect(list.rooms.map((r) => r.name)).toEqual(["Treino aberto"]);
    expect(list.rooms[0]).toMatchObject({ code: pub.code, mode: "1v1", map: "FROST_BASE", players: 1, maxPlayers: 2, status: "lobby", ownerName: a.username, hasPassword: false });

    cb.send({ t: "room_join", code: pub.code.toLowerCase() });
    const joined = await room(cb);
    expect(joined.members.map((m) => [m.id, m.team])).toEqual([[a.id, 0], [b.id, 1]]);
    await room(ca, (r) => r.members.length === 2);

    await Promise.allSettled([...gs.pendingSaves]);
    const row = await ctx.prisma.room.findUniqueOrThrow({ where: { code: pub.code }, include: { players: true } });
    expect(row).toMatchObject({ name: "Treino aberto", ownerId: a.id, isPrivate: false, maxPlayers: 2, roundsToWin: 1, status: "OPEN", passwordHash: null });
    expect(row.players.map((p) => p.userId).sort()).toEqual([a.id, b.id].sort());

    cb.send({ t: "room_join", code: "ZZZZZZ" });
    await error(cb, "ROOM_NOT_FOUND");
  });

  it("senha (com hash), convite de amigo dispensa a senha, anti força bruta", async () => {
    const [a, b, f] = [await player(), await player(), await player()];
    await befriend(a, f);
    const [ca, cb, cf] = [await connect(a), await connect(b), await connect(f)];
    const r = await createRoom(ca, { mode: "2v2" }, "segredo1");
    expect(r.hasPassword).toBe(true);
    await Promise.allSettled([...gs.pendingSaves]);
    const row = await ctx.prisma.room.findUniqueOrThrow({ where: { code: r.code } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);

    cb.send({ t: "room_join", code: r.code });
    await error(cb, "ROOM_PASSWORD");
    for (let i = 0; i < 5; i++) cb.send({ t: "room_join", code: r.code, password: "errada" + i });
    await until(() => cb.msgs.filter((m) => m.t === "error" && m.code === "ROOM_BAD_PASSWORD").length === 5);
    cb.send({ t: "room_join", code: r.code, password: "segredo1" });
    await error(cb, "ROOM_RATE");

    ca.send({ t: "room_invite", userId: b.id });
    await error(ca, "NOT_FRIEND");
    ca.send({ t: "room_invite", userId: f.id });
    const inv = await cf.waitFor("room_invite");
    expect(inv).toMatchObject({ code: r.code, from: { id: a.id, username: a.username } });
    cf.send({ t: "room_join", code: inv.code });
    expect((await room(cf)).members.some((m) => m.id === f.id)).toBe(true);
  });

  it("dono: trocar times, regras, trancar, remover (não volta) e passar a dona ao sair", async () => {
    const [a, b, c3] = [await player(), await player(), await player()];
    const [ca, cb, cc] = [await connect(a), await connect(b), await connect(c3)];
    const r = await createRoom(ca, { mode: "2v2" });
    cb.send({ t: "room_join", code: r.code });
    await room(ca, (v) => v.members.length === 2);
    // Só o dono move os outros.
    cb.send({ t: "room_team", userId: a.id, team: 1 });
    await error(cb, "ROOM_NOT_OWNER");
    ca.send({ t: "room_team", userId: b.id, team: 0 });
    await room(cb, (v) => v.members.find((m) => m.id === b.id)!.team === 0);
    // Mudar para 1v1 com dois no time A não cabe.
    ca.send({ t: "room_update", settings: settings({ mode: "1v1" }) });
    await error(ca, "ROOM_TOO_MANY");
    cb.send({ t: "room_team", team: 1 });
    await room(ca, (v) => v.members.find((m) => m.id === b.id)!.team === 1);
    ca.send({ t: "room_update", settings: settings({ mode: "1v1", roundsToWin: 4, friendlyFire: true, name: "Nova regra" }), password: "abcd1234" });
    const up = await room(cb, (v) => v.settings.name === "Nova regra");
    expect(up).toMatchObject({ hasPassword: true, maxPlayers: 2, settings: { roundsToWin: 4, friendlyFire: true } });

    ca.send({ t: "room_lock", locked: true });
    await room(cb, (v) => v.locked);
    cc.send({ t: "room_join", code: r.code, password: "abcd1234" });
    await error(cc, "ROOM_LOCKED");
    ca.send({ t: "room_lock", locked: false });
    await room(cb, (v) => !v.locked);
    // Sala cheia (1v1 com 2): o terceiro vira espectador.
    cc.send({ t: "room_join", code: r.code, password: "abcd1234" });
    expect((await room(cc)).members.find((m) => m.id === c3.id)!.team).toBeNull();

    ca.send({ t: "room_kick", userId: c3.id });
    await cc.waitFor("room", (m) => m.room === null && m.reason === "kicked");
    cc.send({ t: "room_join", code: r.code, password: "abcd1234" });
    await error(cc, "ROOM_BANNED");

    ca.send({ t: "room_leave" });
    await ca.waitFor("room", (m) => m.room === null && m.reason === "left");
    expect((await room(cb, (v) => v.members.length === 1)).ownerId).toBe(b.id);
    await Promise.allSettled([...gs.pendingSaves]);
    expect((await ctx.prisma.room.findUniqueOrThrow({ where: { code: r.code } })).ownerId).toBe(b.id);
    const kicked = await ctx.prisma.roomPlayer.findFirst({ where: { userId: c3.id } });
    expect(kicked?.kickedAt).not.toBeNull();

    cb.send({ t: "room_close" });
    await cb.waitFor("room", (m) => m.room === null && m.reason === "closed");
    await Promise.allSettled([...gs.pendingSaves]);
    expect((await ctx.prisma.room.findUniqueOrThrow({ where: { code: r.code } })).status).toBe("CLOSED");
    expect(gs.rooms.all()).toHaveLength(0);
  });

  it("partida da sala: regras aplicadas, espectador com atraso, chat separado, volta ao lobby e grava CUSTOM sem mexer no perfil", async () => {
    const [a, b, s] = [await player(), await player(), await player()];
    const [ca, cb, cs] = [await connect(a), await connect(b), await connect(s)];
    const r = await createRoom(ca, { mode: "1v1", roundsToWin: 2, roundTimeSec: 45, headshotsOnly: true, weapons: ["PISTOL"] });
    cb.send({ t: "room_join", code: r.code });
    cs.send({ t: "room_join", code: r.code, spectate: true });
    await room(ca, (v) => v.members.length === 3);
    // Só o dono começa, e cada time precisa de alguém.
    cb.send({ t: "room_start" });
    await error(cb, "ROOM_NOT_OWNER");
    // Fila bloqueada enquanto está na sala.
    cb.send({ t: "queue", mode: "1v1", loadout: ["P9_FAISCA"] });
    await error(cb, "IN_ROOM");

    ca.send({ t: "room_start" });
    const info = (await ca.waitFor("match")).info;
    expect(info).toMatchObject({ roundsToWin: 2, rules: { roundTimeSec: 45, headshotsOnly: true, friendlyFire: false }, map: "FROST_BASE", ranked: false });
    // Só armas liberadas (pistolas), mesmo que o jogador tenha escolhido outras.
    for (const p of info.players) expect(p.loadout.length).toBeGreaterThan(0);
    const match = gs.matches.get(info.matchId)!;
    for (const p of match.players) expect(p.loadout.every((w) => w.category === "PISTOL")).toBe(true);
    const start = await cs.waitFor("spec_start");
    expect(start.info).toMatchObject({ matchId: info.matchId, delayMs: expect.any(Number) });
    expect(start.info.delayMs).toBeGreaterThanOrEqual(2000);
    await room(ca, (v) => v.status === "in_match" && v.matchId === info.matchId);
    // Durante a partida, ninguém entra como jogador; o dono não remove quem joga.
    ca.send({ t: "room_kick", userId: b.id });
    await error(ca, "ROOM_IN_MATCH");

    // Chat: espectador fala só com espectadores; jogador usa o chat da partida.
    cs.send({ t: "chat", channel: "room", text: "estou assistindo" });
    await cs.waitFor("chat", (m) => m.channel === "room");
    ca.send({ t: "chat", channel: "room", text: "oi" });
    await error(ca, "ROOM_CHAT_MATCH");
    await new Promise((res) => setTimeout(res, 100));
    expect(ca.msgs.some((m) => m.t === "chat" && m.text === "estou assistindo")).toBe(false);
    expect(cb.msgs.some((m) => m.t === "chat" && m.text === "estou assistindo")).toBe(false);

    // Espectador: quadros atrasados com todos os jogadores.
    ca.send({ t: "ready" });
    cb.send({ t: "ready" });
    await new Promise((res) => setTimeout(res, 50));
    for (let i = 0; i < 260; i++) gs.stepAll();
    const frame = await cs.waitFor("spec");
    expect(frame.players.map((p) => p[0]).sort()).toEqual([a.id, b.id].sort());
    expect(frame.tick).toBeLessThanOrEqual(match.tick - Math.round(start.info.delayMs / (1000 / 60)));
    const snap = await ca.waitFor("snap", (m) => m.spec === 1);
    expect(snap.spec).toBe(1);

    // B abandona: A vence; a sala volta ao lobby com todos.
    cb.send({ t: "leave_match" });
    await cb.waitFor("left_match");
    await room(ca, (v) => v.status === "lobby" && v.matchId === null && v.members.length === 3);
    for (let i = 0; i < 300; i++) gs.stepAll();
    await cs.waitFor("spec", (m) => m.ev.some((e) => e.k === "match_end"));
    await until(async () => (await ctx.prisma.match.count({ where: { id: info.matchId } })) === 1);
    const saved = await ctx.prisma.match.findUniqueOrThrow({ where: { id: info.matchId } });
    expect(saved).toMatchObject({ type: "CUSTOM", roomId: r.id, roundsToWin: 2, winnerTeam: 0 });
    const prof = await ctx.prisma.userProfile.findUniqueOrThrow({ where: { userId: a.id } });
    expect(prof.matchesPlayed).toBe(0);
    expect(prof.wins).toBe(0);
  });

  it("presença em sala e prazo para voltar depois de cair", async () => {
    const [a, b] = [await player(), await player()];
    await befriend(a, b);
    const [ca, cb] = [await connect(a), await connect(b)];
    const r = await createRoom(ca);
    await until(() => cb.msgs.some((m) => m.t === "presence" && m.list.some(([id, st]) => id === a.id && st === "room")));
    cb.send({ t: "room_join", code: r.code });
    await room(ca, (v) => v.members.length === 2);
    cb.close();
    await room(ca, (v) => v.members.find((m) => m.id === b.id)?.online === false);
    // Voltou dentro do prazo: continua na sala.
    const cb2 = await connect(b);
    expect((await room(cb2)).code).toBe(r.code);
    cb2.close();
    await room(ca, (v) => v.members.length === 1);
    expect(lastRoomMsg(ca)!.room!.members.map((m) => m.id)).toEqual([a.id]);
  });
});
