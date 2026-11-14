import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { GAME_PROTOCOL_VERSION, WEAPON_CATALOG, encodeCommand, type ServerMessage } from "@vanta/shared";
import { GameServer } from "../src/game/server.js";
import { closeTestContext, createTestContext, newPlayer, resetState, type TestContext } from "./helpers.js";

let ctx: TestContext;
let gs: GameServer;
let url: string;
const SECRET = "segredo-de-teste-com-mais-de-32-caracteres-ok";
const RIFLE = WEAPON_CATALOG.find((w) => w.category === "ASSAULT_RIFLE")!.code;

beforeAll(async () => {
  ctx = await createTestContext();
  gs = new GameServer({ prisma: ctx.prisma, jwtSecret: SECRET, allowedOrigins: ["http://localhost:5173"], autoTick: false, recheckMs: 200, log: { info() {}, warn() {}, error: console.error } });
  const port = await gs.start(0, "127.0.0.1");
  url = `ws://127.0.0.1:${port}/game`;
});
afterAll(async () => {
  await gs.stop();
  await closeTestContext(ctx);
});
beforeEach(async () => {
  for (const m of gs.matches.values()) for (const p of m.players) m.forfeit(p.userId);
  await Promise.allSettled([...gs.pendingSaves]);
  gs.matches.clear();
  await ctx.prisma.$executeRawUnsafe(`TRUNCATE "Match" CASCADE`);
  await resetState(ctx);
});

async function registerToken() {
  const res = await ctx.app.inject({ method: "POST", url: "/auth/register", payload: newPlayer() });
  const j = res.json();
  return { token: j.accessToken as string, userId: j.user.id as string, username: j.user.username as string };
}

class TestClient {
  ws: WebSocket;
  msgs: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];
  constructor(origin?: string) {
    this.ws = new WebSocket(url, origin ? { headers: { origin } } : undefined);
    this.ws.on("message", (d) => {
      this.msgs.push(JSON.parse(d.toString()));
      this.waiters.splice(0).forEach((w) => w());
    });
    this.ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.waiters.splice(0).forEach((w) => w());
    });
    this.ws.on("error", () => {});
  }
  open() {
    return new Promise<void>((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
      this.ws.once("unexpected-response", () => rej(new Error("rejeitado")));
    });
  }
  send(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }
  async waitFor<T extends ServerMessage["t"]>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.msgs.find((m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>));
      if (found) return found as Extract<ServerMessage, { t: T }>;
      if (this.closed) throw new Error(`conexão fechada (${this.closed.code} ${this.closed.reason}) esperando ${t}`);
      if (Date.now() > deadline) throw new Error(`timeout esperando ${t}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  async waitClosed(ms = 3000) {
    const deadline = Date.now() + ms;
    while (!this.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return this.closed;
  }
  close() {
    this.ws.close();
  }
}

async function connect(token: string) {
  const c = new TestClient();
  await c.open();
  c.send({ t: "hello", token, v: GAME_PROTOCOL_VERSION });
  await c.waitFor("welcome");
  return c;
}

describe("servidor de jogo (WebSocket)", () => {
  it("rejeita token inválido e conexão sem hello", async () => {
    const c = new TestClient();
    await c.open();
    c.send({ t: "hello", token: "token.falso.qualquer", v: GAME_PROTOCOL_VERSION });
    expect((await c.waitFor("error")).code).toBe("UNAUTHORIZED");
    expect((await c.waitClosed())?.code).toBe(4001);

    const c2 = new TestClient();
    await c2.open();
    c2.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    expect((await c2.waitClosed())?.code).toBe(4001);
  });

  it("bloqueia Origin de outro site (cross-site WebSocket hijacking)", async () => {
    const evil = new TestClient("https://site-malicioso.example");
    await expect(evil.open()).rejects.toThrow();
  });

  it("mensagem malformada recebe erro e não derruba o servidor", async () => {
    const { token } = await registerToken();
    const c = await connect(token);
    c.send({ t: "cmd", c: [[1, 99999, "x", 0, 0, 0]] });
    expect((await c.waitFor("error")).code).toBe("BAD_MESSAGE");
    c.send({ t: "ping", n: 7 });
    expect((await c.waitFor("pong")).n).toBe(7);
    c.close();
  });

  it("fila 1v1 forma partida com dois jogadores reais, joga, salva no banco e atualiza perfis", async () => {
    const a = await registerToken();
    const b = await registerToken();
    const ca = await connect(a.token);
    const cb = await connect(b.token);
    ca.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    const q = await ca.waitFor("queue", (m) => m.state === "searching");
    expect(q).toMatchObject({ inQueue: 1, needed: 2 });
    cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    const ma = await ca.waitFor("match");
    const mb = await cb.waitFor("match");
    expect(ma.info.matchId).toBe(mb.info.matchId);
    expect(ma.info.players.map((p) => p.username).sort()).toEqual([a.username, b.username].sort());
    expect(ma.info.yourTeam).not.toBe(mb.info.yourTeam);

    ca.send({ t: "ready" });
    cb.send({ t: "ready" });
    await new Promise((r) => setTimeout(r, 50));
    const match = gs.matches.get(ma.info.matchId)!;
    // Comandos chegam pela rede; o servidor avança os ticks.
    let seq = 0;
    for (let i = 0; i < 10; i++) {
      ca.send({ t: "cmd", c: [encodeCommand({ seq: ++seq, forward: 0, right: 0, jump: false, crouch: false, sprint: false, aim: false, fire: false, reload: false, slot: 0, yaw: 0, pitch: 0, viewTick: 0 })] });
    }
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 20; i++) gs.stepAll();
    expect(match.phase).toBe("freeze");
    const snap = await ca.waitFor("snap", (s) => s.you.seq === 10);
    expect(snap.others).toHaveLength(1);

    // B desiste → A vence por W.O.; a partida é gravada.
    cb.send({ t: "leave_match" });
    await cb.waitFor("left_match");
    await ca.waitFor("snap", (s) => s.ev.some((e) => e.k === "match_end"));
    await Promise.allSettled([...gs.pendingSaves]);
    const saved = await ctx.prisma.match.findUniqueOrThrow({ where: { id: ma.info.matchId }, include: { players: true } });
    expect(saved).toMatchObject({ mode: "DUEL_1V1", status: "FINISHED", winnerTeam: ma.info.yourTeam });
    expect(saved.players.find((p) => p.userId === b.userId)).toMatchObject({ result: "ABANDONED", abandoned: true });
    expect(saved.players.find((p) => p.userId === a.userId)!.result).toBe("WIN");
    const profA = await ctx.prisma.userProfile.findUniqueOrThrow({ where: { userId: a.userId } });
    expect(profA).toMatchObject({ matchesPlayed: 1, wins: 1 });
    ca.close();
    cb.close();
  });

  it("reconexão: ao voltar, o jogador recebe a partida e o último seq aceito", async () => {
    const a = await registerToken();
    const b = await registerToken();
    const ca = await connect(a.token);
    const cb = await connect(b.token);
    ca.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    const ma = await ca.waitFor("match");
    for (let s = 1; s <= 3; s++) cb.send({ t: "cmd", c: [encodeCommand({ seq: s, forward: 0, right: 0, jump: false, crouch: false, sprint: false, aim: false, fire: false, reload: false, slot: 0, yaw: 0, pitch: 0, viewTick: 0 })] });
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 6; i++) gs.stepAll();
    cb.close();
    await cb.waitClosed();
    await new Promise((r) => setTimeout(r, 50));
    gs.stepAll();
    gs.stepAll();
    await ca.waitFor("snap", (s) => s.ev.some((e) => e.k === "player" && e.connected === false));

    const cb2 = await connect(b.token);
    const welcome = await cb2.waitFor("welcome");
    expect(welcome.inMatch).toBe(true);
    const again = await cb2.waitFor("match");
    expect(again.info.matchId).toBe(ma.info.matchId);
    expect(again.info.lastSeq).toBeGreaterThanOrEqual(3);
    ca.close();
    cb2.close();
  });

  it("nova conexão da mesma conta substitui a antiga", async () => {
    const a = await registerToken();
    const c1 = await connect(a.token);
    const c2 = await connect(a.token);
    expect((await c1.waitClosed())?.code).toBe(4004);
    c2.send({ t: "ping", n: 1 });
    await c2.waitFor("pong");
    c2.close();
  });

  it("arsenal com arma inexistente é recusado", async () => {
    const a = await registerToken();
    const c = await connect(a.token);
    c.send({ t: "queue", mode: "1v1", loadout: ["ARMA_HACKEADA"] });
    expect((await c.waitFor("error")).code).toBe("BAD_LOADOUT");
    c.close();
  });

  it("3v3 só começa com seis jogadores reais e separa os times", async () => {
    const users = await Promise.all(Array.from({ length: 6 }, () => registerToken()));
    const clients = [];
    for (const u of users) clients.push(await connect(u.token));
    for (let i = 0; i < 5; i++) clients[i]!.send({ t: "queue", mode: "3v3", loadout: [RIFLE] });
    await clients[4]!.waitFor("queue", (m) => m.inQueue === 5);
    expect(gs.matches.size).toBe(0);
    clients[5]!.send({ t: "queue", mode: "3v3", loadout: [RIFLE] });
    const infos = await Promise.all(clients.map((c) => c.waitFor("match")));
    const teams = infos[0]!.info.players.reduce((acc, p) => ((acc[p.team] = (acc[p.team] ?? 0) + 1), acc), [0, 0]);
    expect(teams).toEqual([3, 3]);
    expect(new Set(infos.map((i) => i.info.matchId)).size).toBe(1);
    clients.forEach((c) => c.close());
  });

  it("rotação de mapas: partidas seguidas usam mapas diferentes, cada um com o personagem do jogador", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const a = await registerToken();
      const b = await registerToken();
      const ca = await connect(a.token);
      const cb = await connect(b.token);
      ca.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
      cb.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
      const m = await ca.waitFor("match");
      seen.push(m.info.map);
      expect(m.info.players.every((p) => typeof p.character === "string" && p.character.length > 0)).toBe(true);
      ca.close();
      cb.close();
    }
    expect(new Set(seen).size).toBe(2);
  });

  it("banimento derruba a conexão de jogo em segundos", async () => {
    const a = await registerToken();
    const c = await connect(a.token);
    await ctx.prisma.user.update({ where: { id: a.userId }, data: { status: "BANNED" } });
    expect((await c.waitClosed(2000))?.code).toBe(4001);
  });
});
