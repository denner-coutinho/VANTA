import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_PROTOCOL_VERSION, WEAPON_CATALOG } from "@vanta/shared";
import { GameServer } from "../src/game/server.js";
import { TestClient } from "./game-helpers.js";
import { closeTestContext, createTestContext, newPlayer, resetState, type TestContext } from "./helpers.js";

let ctx: TestContext;
let gs: GameServer;
let url: string;
const SECRET = "segredo-de-teste-com-mais-de-32-caracteres-ok";
const RIFLE = WEAPON_CATALOG.find((w) => w.category === "ASSAULT_RIFLE")!.code;
const open: TestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  gs = new GameServer({ prisma: ctx.prisma, jwtSecret: SECRET, allowedOrigins: [], autoTick: false, recheckMs: 60_000, bus: ctx.bus, partyGraceMs: 300, log: { info() {}, warn() {}, error: console.error } });
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
  await ctx.prisma.$executeRawUnsafe(`TRUNCATE "Match" CASCADE`);
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

const lastPresence = (c: TestClient, id: string) =>
  c.msgs
    .filter((m) => m.t === "presence")
    .flatMap((m) => (m as { list: Array<[string, string]> }).list)
    .filter(([uid]) => uid === id)
    .at(-1)?.[1];

async function until(pred: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condição não atingida");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("presença", () => {
  it("amigos veem online, fila e offline; estranhos não veem nada", async () => {
    const [a, b, x] = [await player(), await player(), await player()];
    await befriend(a, b);
    const ca = await connect(a);
    expect(lastPresence(ca, b.id)).toBe("offline");
    const cx = await connect(x);
    const cb = await connect(b);
    await until(() => lastPresence(ca, b.id) === "online");
    expect(lastPresence(cb, a.id)).toBe("online");

    cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    await until(() => lastPresence(ca, b.id) === "queue");
    cb.send({ t: "cancel_queue" });
    await until(() => lastPresence(ca, b.id) === "online");
    cb.close();
    await until(() => lastPresence(ca, b.id) === "offline");
    expect(cx.msgs.some((m) => m.t === "presence" && m.list.some(([id]) => id === b.id))).toBe(false);
    // A última vez online fica registrada.
    await until(() => true);
    await new Promise((r) => setTimeout(r, 100));
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: b.id } })).lastSeenAt).not.toBeNull();
  });

  it("amizade aceita pela API chega na hora pelo servidor de jogo, com a presença do novo amigo", async () => {
    const [a, b] = [await player(), await player()];
    const ca = await connect(a);
    const cb = await connect(b);
    const id = (await api(a, "POST", "/social/requests", { username: b.username })).json().requestId;
    await cb.waitFor("social", (m) => m.ev.k === "friend_request");
    await api(b, "POST", `/social/requests/${id}/accept`);
    await ca.waitFor("social", (m) => m.ev.k === "friend_accepted");
    await until(() => lastPresence(ca, b.id) === "online");
    // Depois de virar amigo, a mudança de presença também chega.
    cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    await until(() => lastPresence(ca, b.id) === "queue");
  });
});

describe("grupo", () => {
  it("convite só para amigos online; aceitar junta os dois e só o líder entra na fila", async () => {
    const [a, b, c, d] = [await player(), await player(), await player(), await player()];
    const ca = await connect(a);
    const cb = await connect(b);
    ca.send({ t: "party_invite", userId: b.id });
    expect((await ca.waitFor("error")).code).toBe("NOT_FRIEND");

    await befriend(a, b);
    await ca.waitFor("social", (m) => m.ev.k === "friend_accepted");
    ca.send({ t: "party_invite", userId: b.id });
    const inv = await cb.waitFor("party_invite");
    expect(inv.from.username).toBe(a.username);
    cb.send({ t: "party_respond", partyId: inv.partyId, accept: true });
    const party = await ca.waitFor("party", (m) => (m.party?.members.length ?? 0) === 2);
    expect(party.party!.leaderId).toBe(a.id);
    // Convite usado não vale de novo.
    cb.send({ t: "party_respond", partyId: inv.partyId, accept: true });
    expect((await cb.waitFor("error", (m) => m.code === "INVITE_EXPIRED")).code).toBe("INVITE_EXPIRED");

    cb.send({ t: "loadout", loadout: [RIFLE] });
    cb.send({ t: "queue", mode: "2v2", loadout: [RIFLE] });
    expect((await cb.waitFor("error", (m) => m.code === "PARTY_NOT_LEADER")).code).toBeTruthy();
    ca.send({ t: "queue", mode: "2v2", loadout: [RIFLE], ranked: true });
    expect((await ca.waitFor("error", (m) => m.code === "PARTY_RANKED")).code).toBeTruthy();
    ca.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    expect((await ca.waitFor("error", (m) => m.code === "PARTY_TOO_BIG")).code).toBeTruthy();

    ca.send({ t: "queue", mode: "2v2", loadout: [RIFLE] });
    await cb.waitFor("queue", (m) => m.state === "searching" && m.inQueue === 2);
    // Dois jogadores sozinhos completam a partida; o grupo fica no mesmo time.
    const cc = await connect(c);
    const cd = await connect(d);
    cc.send({ t: "queue", mode: "2v2", loadout: [RIFLE] });
    cd.send({ t: "queue", mode: "2v2", loadout: [RIFLE] });
    const [ma, mb, mc] = [await ca.waitFor("match"), await cb.waitFor("match"), await cc.waitFor("match")];
    expect(ma.info.yourTeam).toBe(mb.info.yourTeam);
    expect(mc.info.yourTeam).not.toBe(ma.info.yourTeam);
    expect(ma.info.players.find((p) => p.id === b.id)?.loadout).toEqual([RIFLE]);
  });

  it("se um membro cancela, o grupo inteiro sai da fila", async () => {
    const [a, b] = [await player(), await player()];
    await befriend(a, b);
    const ca = await connect(a);
    const cb = await connect(b);
    ca.send({ t: "party_invite", userId: b.id });
    cb.send({ t: "party_respond", partyId: (await cb.waitFor("party_invite")).partyId, accept: true });
    await ca.waitFor("party", (m) => (m.party?.members.length ?? 0) === 2);
    ca.send({ t: "queue", mode: "3v3", loadout: [RIFLE] });
    await cb.waitFor("queue", (m) => m.state === "searching");
    cb.send({ t: "cancel_queue" });
    await ca.waitFor("queue", (m) => m.state === "idle");
  });

  it("quem cai tem um prazo para voltar; depois sai e o grupo de um só é desfeito", async () => {
    const [a, b] = [await player(), await player()];
    await befriend(a, b);
    const ca = await connect(a);
    let cb = await connect(b);
    ca.send({ t: "party_invite", userId: b.id });
    cb.send({ t: "party_respond", partyId: (await cb.waitFor("party_invite")).partyId, accept: true });
    await ca.waitFor("party", (m) => (m.party?.members.length ?? 0) === 2);

    // Recarregou a página dentro do prazo: continua no grupo.
    cb.close();
    await ca.waitFor("party", (m) => m.party?.members.find((x) => x.id === b.id)?.online === false);
    cb = await connect(b);
    expect((await cb.waitFor("party")).party?.members).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 400));
    expect(ca.msgs.filter((m) => m.t === "party").at(-1)).toMatchObject({ party: { members: [{ id: a.id }, { id: b.id }] } });

    cb.close();
    await ca.waitFor("party", (m) => m.party === null, 2000);
  });

  it("líder remove membro; bloquear alguém do grupo separa os dois", async () => {
    const [a, b, c] = [await player(), await player(), await player()];
    await befriend(a, b);
    await befriend(a, c);
    const ca = await connect(a);
    const cb = await connect(b);
    const cc = await connect(c);
    ca.send({ t: "party_invite", userId: b.id });
    cb.send({ t: "party_respond", partyId: (await cb.waitFor("party_invite")).partyId, accept: true });
    ca.send({ t: "party_invite", userId: c.id });
    cc.send({ t: "party_respond", partyId: (await cc.waitFor("party_invite")).partyId, accept: true });
    await ca.waitFor("party", (m) => (m.party?.members.length ?? 0) === 3);
    cb.send({ t: "party_kick", userId: c.id });
    expect((await cb.waitFor("error", (m) => m.code === "PARTY_NOT_LEADER")).code).toBeTruthy();
    ca.send({ t: "party_kick", userId: c.id });
    await cc.waitFor("party", (m) => m.party === null);
    await ca.waitFor("party", (m) => m.party?.members.length === 2);

    await api(b, "POST", "/social/blocks", { userId: a.id });
    await cb.waitFor("party", (m) => m.party === null);
    await ca.waitFor("party", (m) => m.party === null);
  });
});

describe("chat", () => {
  async function partyOf(a: P, b: P) {
    await befriend(a, b);
    const ca = await connect(a);
    const cb = await connect(b);
    ca.send({ t: "party_invite", userId: b.id });
    cb.send({ t: "party_respond", partyId: (await cb.waitFor("party_invite")).partyId, accept: true });
    await ca.waitFor("party", (m) => (m.party?.members.length ?? 0) === 2);
    return [ca, cb] as const;
  }

  it("chat do grupo: texto limpo e anti-flood", async () => {
    const [a, b] = [await player(), await player()];
    const [ca, cb] = await partyOf(a, b);
    ca.send({ t: "chat", channel: "party", text: "  bora\u0000   jogar  " });
    const m = await cb.waitFor("chat");
    expect(m).toMatchObject({ channel: "party", text: "bora jogar", from: { id: a.id, username: a.username } });
    for (let i = 0; i < 6; i++) ca.send({ t: "chat", channel: "party", text: `msg ${i}` });
    expect((await ca.waitFor("error", (e) => e.code === "CHAT_RATE")).code).toBeTruthy();
    await until(() => cb.msgs.filter((x) => x.t === "chat").length >= 5);
    await new Promise((r) => setTimeout(r, 100));
    expect(cb.msgs.filter((x) => x.t === "chat")).toHaveLength(5);
  });

  it("silenciar e banimento de chat valem no servidor", async () => {
    const [a, b] = [await player(), await player()];
    const [ca, cb] = await partyOf(a, b);
    await api(b, "POST", "/social/mutes", { userId: a.id });
    await cb.waitFor("social", (m) => m.ev.k === "relations_changed");
    await new Promise((r) => setTimeout(r, 100));
    ca.send({ t: "chat", channel: "party", text: "você não vai ver isto" });
    await ca.waitFor("chat"); // quem enviou vê a própria mensagem
    await new Promise((r) => setTimeout(r, 150));
    expect(cb.msgs.some((m) => m.t === "chat")).toBe(false);
    cb.send({ t: "chat", channel: "party", text: "eu ainda falo" });
    await ca.waitFor("chat", (m) => m.from.id === b.id);

    await ctx.prisma.ban.create({ data: { userId: b.id, type: "CHAT_MUTE", reason: "teste", endsAt: new Date(Date.now() + 3600_000) } });
    await ctx.bus.publish([b.id], { k: "relations_changed" });
    await new Promise((r) => setTimeout(r, 150));
    cb.send({ t: "chat", channel: "party", text: "suspenso" });
    expect((await cb.waitFor("error", (m) => m.code === "CHAT_BANNED")).code).toBeTruthy();
  });

  it("chat de partida: equipe só para o time, todos para todos, e fica registrado", async () => {
    const ps = [await player(), await player(), await player(), await player()];
    const cs = await Promise.all(ps.map((p) => connect(p)));
    for (const c of cs) c.send({ t: "queue", mode: "2v2", loadout: [RIFLE] });
    const infos = await Promise.all(cs.map((c) => c.waitFor("match")));
    const team0 = infos[0]!.info.yourTeam;
    const mate = infos.findIndex((m, i) => i > 0 && m.info.yourTeam === team0);
    const enemy = infos.findIndex((m) => m.info.yourTeam !== team0);
    cs[0]!.send({ t: "chat", channel: "team", text: "flanco esquerdo" });
    await cs[mate]!.waitFor("chat", (m) => m.channel === "team");
    cs[0]!.send({ t: "chat", channel: "all", text: "gg" });
    await cs[enemy]!.waitFor("chat", (m) => m.channel === "all");
    expect(cs[enemy]!.msgs.some((m) => m.t === "chat" && m.text === "flanco esquerdo")).toBe(false);

    const match = gs.matches.get(infos[0]!.info.matchId)!;
    for (const p of match.players.filter((x) => x.team !== team0)) match.forfeit(p.userId);
    await until(() => gs.pendingSaves.size === 0 && match.isEnded);
    await Promise.allSettled([...gs.pendingSaves]);
    const chats = await ctx.prisma.matchEvent.findMany({ where: { matchId: match.id, type: "chat" }, orderBy: { tick: "asc" } });
    expect(chats.map((c) => (c.data as { text: string }).text)).toEqual(["flanco esquerdo", "gg"]);

    // Fora da partida não há chat de partida.
    const solo = await player();
    const cso = await connect(solo);
    cso.send({ t: "chat", channel: "all", text: "oi" });
    expect((await cso.waitFor("error", (m) => m.code === "NOT_IN_MATCH")).code).toBeTruthy();
  });
});
