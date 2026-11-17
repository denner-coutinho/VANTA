import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { GAME_PROTOCOL_VERSION, WEAPON_CATALOG, defaultRoomSettings, type RoomSettings, type ServerMessage } from "@vanta/shared";
import { GameServer } from "../src/game/server.js";
import { RedisCluster } from "../src/game/cluster.js";
import { TestClient } from "./game-helpers.js";
import { closeTestContext, createTestContext, newPlayer, resetState, type TestContext } from "./helpers.js";

/**
 * Dois nós de jogo de verdade (dois GameServer com RedisCluster no mesmo Redis), como em produção
 * com dois processos. Cada teste conecta jogadores em nós diferentes e confere que o servidor os
 * leva ao nó certo.
 */
const SECRET = "segredo-de-teste-com-mais-de-32-caracteres-ok";
const RIFLE = WEAPON_CATALOG.find((w) => w.category === "ASSAULT_RIFLE")!.code;
const PREFIX = "vanta-test-cluster:";
const REDIS = process.env.REDIS_URL ?? "redis://localhost:6379";
let ctx: TestContext;
let n1: GameServer;
let n2: GameServer;
const url: Record<string, string> = {};
const open: TestClient[] = [];
const quiet = { info() {}, warn() {}, error: console.error };

async function clearKeys() {
  const r = new Redis(REDIS);
  const keys = await r.keys(`${PREFIX}*`);
  if (keys.length) await r.del(...keys);
  r.disconnect();
}

async function node(id: string) {
  const gs = new GameServer({
    prisma: ctx.prisma,
    jwtSecret: SECRET,
    allowedOrigins: [],
    autoTick: false,
    recheckMs: 60_000,
    bus: ctx.bus,
    partyGraceMs: 3000,
    roomGraceMs: 3000,
    log: quiet,
    cluster: new RedisCluster(REDIS, id, PREFIX),
  });
  return gs;
}

beforeAll(async () => {
  ctx = await createTestContext();
  await clearKeys();
  n1 = await node("n1");
  n2 = await node("n2");
  // A URL pública é lida a cada batida do cluster: define depois de saber a porta.
  const p1 = await n1.start(0, "127.0.0.1");
  const p2 = await n2.start(0, "127.0.0.1");
  url.n1 = `ws://127.0.0.1:${p1}/game`;
  url.n2 = `ws://127.0.0.1:${p2}/game`;
  (n1 as unknown as { opts: { publicUrl: string } }).opts.publicUrl = url.n1;
  (n2 as unknown as { opts: { publicUrl: string } }).opts.publicUrl = url.n2;
  // Espera a batida seguinte publicar as URLs.
  await new Promise((r) => setTimeout(r, 2200));
});
afterAll(async () => {
  await n1.stop();
  await n2.stop();
  await clearKeys();
  await closeTestContext(ctx);
});
beforeEach(async () => {
  for (const c of open.splice(0)) c.close();
  await new Promise((r) => setTimeout(r, 100));
  for (const gs of [n1, n2]) {
    for (const m of gs.matches.values()) for (const p of m.players) m.forfeit(p.userId);
    await Promise.allSettled([...gs.pendingSaves]);
    gs.matches.clear();
  }
  await ctx.prisma.$executeRawUnsafe(`TRUNCATE "Match" CASCADE`);
  await resetState(ctx);
  const r = new Redis(REDIS);
  const keys = (await r.keys(`${PREFIX}*`)).filter((k) => !k.endsWith("cluster:nodes"));
  if (keys.length) await r.del(...keys);
  r.disconnect();
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
const api = (p: P, method: "GET" | "POST", u: string, payload?: object) => ctx.app.inject({ method, url: u, headers: { authorization: `Bearer ${p.token}` }, payload });
async function befriend(a: P, b: P) {
  const id = (await api(a, "POST", "/social/requests", { username: b.username })).json().requestId;
  expect((await api(b, "POST", `/social/requests/${id}/accept`)).statusCode).toBe(200);
}

/** Conecta e se identifica. Devolve o cliente e o que veio primeiro: welcome ou redirect. */
async function connect(p: P, at: string) {
  const c = new TestClient(at);
  open.push(c);
  await c.open();
  c.send({ t: "hello", token: p.token, v: GAME_PROTOCOL_VERSION });
  const deadline = Date.now() + 4000;
  while (!c.msgs.some((m) => m.t === "welcome" || m.t === "redirect")) {
    if (Date.now() > deadline) throw new Error("nem welcome nem redirect");
    await new Promise((r) => setTimeout(r, 20));
  }
  return c;
}
/** Segue o redirecionamento como o cliente real: reconecta na URL do nó indicado. */
async function follow(c: TestClient, p: P, ms = 4000) {
  const r = await c.waitFor("redirect", () => true, ms);
  expect(r.url).toBeTruthy();
  c.close();
  const next = await connect(p, r.url!);
  await next.waitFor("welcome");
  return { client: next, node: r.node };
}
async function until(pred: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("condição não atingida");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const settings = (over: Partial<RoomSettings> = {}): RoomSettings => ({ ...defaultRoomSettings("Sala"), mode: "1v1", map: "FROST_BASE", roundsToWin: 1, ...over });
const roomOf = (c: TestClient) => c.msgs.filter((m): m is Extract<ServerMessage, { t: "room" }> => m.t === "room").at(-1)?.room ?? null;
const partyOf = (c: TestClient) => c.msgs.filter((m): m is Extract<ServerMessage, { t: "party" }> => m.t === "party").at(-1)?.party ?? null;

describe("vários nós de jogo", () => {
  it("jogadores em nós diferentes caem na mesma partida; quem estava no outro nó é levado para lá", async () => {
    const [a, b] = [await player(), await player()];
    const ca = await connect(a, url.n1!);
    const cb = await connect(b, url.n2!);
    ca.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    await ca.waitFor("queue", (m) => m.state === "searching");
    cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    // Um dos dois recebe a partida direto; o outro, o pedido para trocar de nó.
    await until(() => [ca, cb].some((c) => c.msgs.some((m) => m.t === "redirect")));
    const moved = ca.msgs.some((m) => m.t === "redirect") ? { c: ca, p: a } : { c: cb, p: b };
    const stayed = moved.c === ca ? cb : ca;
    const host = moved.c === ca ? n2 : n1;
    await stayed.waitFor("match");
    const { client } = await follow(moved.c, moved.p);
    const info = await client.waitFor("match");
    expect(info.info.players.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(host.matches.size).toBe(1);
    expect((moved.c === ca ? n1 : n2).matches.size).toBe(0);

    // Recarregou a página e o balanceador mandou para o outro nó: volta para o nó da partida.
    client.close();
    const wrong = await connect(moved.p, host === n1 ? url.n2! : url.n1!);
    const again = await follow(wrong, moved.p);
    expect((await again.client.waitFor("welcome")).inMatch).toBe(true);
  });

  it("uma conexão por conta também entre nós", async () => {
    const a = await player();
    const first = await connect(a, url.n1!);
    await first.waitFor("welcome");
    const second = await connect(a, url.n2!);
    await second.waitFor("welcome");
    expect((await first.waitClosed(3000))?.code).toBe(4004);
  });

  it("presença de amigos atravessa os nós", async () => {
    const [a, b] = [await player(), await player()];
    await befriend(a, b);
    const ca = await connect(a, url.n1!);
    await ca.waitFor("presence", (m) => m.full);
    const cb = await connect(b, url.n2!);
    await until(() => ca.msgs.some((m) => m.t === "presence" && m.list.some(([id, s]) => id === b.id && s === "online")));
    // B já via A online ao chegar (presença guardada no cluster).
    const full = await cb.waitFor("presence", (m) => m.full);
    expect(full.list).toContainEqual([a.id, "online"]);
    cb.close();
    await until(() => ca.msgs.some((m) => m.t === "presence" && m.list.some(([id, s]) => id === b.id && s === "offline")));
  });

  it("convite de grupo entre nós: ao aceitar, a pessoa vai para o nó do grupo", async () => {
    const [a, b] = [await player(), await player()];
    await befriend(a, b);
    const ca = await connect(a, url.n1!);
    const cb = await connect(b, url.n2!);
    await cb.waitFor("welcome");
    ca.send({ t: "party_invite", userId: b.id });
    const inv = await cb.waitFor("party_invite");
    cb.send({ t: "party_respond", partyId: inv.partyId, accept: true });
    const { client } = await follow(cb, b);
    await until(() => (partyOf(client)?.members.length ?? 0) === 2 && partyOf(client)!.members.every((m) => m.online));
    await until(() => partyOf(ca)?.members.find((m) => m.id === b.id)?.online === true);
  });

  it("sala de outro nó: lista, senha conferida no nó da sala e entrada levando ao nó", async () => {
    const [a, b] = [await player(), await player()];
    const ca = await connect(a, url.n1!);
    await ca.waitFor("welcome");
    ca.send({ t: "room_create", settings: settings({ name: "Sala do n1" }), password: "segredo1" });
    await until(() => !!roomOf(ca));
    const code = roomOf(ca)!.code;
    const cb = await connect(b, url.n2!);
    await cb.waitFor("welcome");
    cb.send({ t: "room_list" });
    const list = await cb.waitFor("room_list");
    expect(list.rooms.map((r) => r.code)).toContain(code);
    cb.send({ t: "room_join", code, password: "errada" });
    await cb.waitFor("error", (m) => m.code === "ROOM_BAD_PASSWORD");
    cb.send({ t: "room_join", code, password: "segredo1" });
    const { client } = await follow(cb, b);
    await until(() => roomOf(client)?.members.length === 2);
    await until(() => roomOf(ca)?.members.some((m) => m.id === b.id && m.online) === true);
  });
});
