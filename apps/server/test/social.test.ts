import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SocialEvent } from "@vanta/shared";
import { closeTestContext, createTestContext, newPlayer, resetState, type TestContext } from "./helpers.js";

let ctx: TestContext;
let events: Array<{ to: string; ev: SocialEvent }> = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.bus.subscribe((to, ev) => events.push({ to, ev }));
});
afterAll(async () => closeTestContext(ctx));
beforeEach(async () => {
  await ctx.prisma.$executeRawUnsafe(`TRUNCATE "Match" CASCADE`);
  await resetState(ctx);
  events = [];
});

interface P {
  id: string;
  username: string;
  token: string;
}

async function player(): Promise<P> {
  const res = await ctx.app.inject({ method: "POST", url: "/auth/register", payload: newPlayer() });
  const j = res.json();
  return { id: j.user.id, username: j.user.username, token: j.accessToken };
}

function call(p: P, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: { authorization: `Bearer ${p.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

async function befriend(a: P, b: P) {
  const r = await call(a, "POST", "/social/requests", { username: b.username });
  expect(r.statusCode).toBe(200);
  const acc = await call(b, "POST", `/social/requests/${r.json().requestId}/accept`);
  expect(acc.statusCode).toBe(200);
}

describe("amigos", () => {
  it("pedido → aceitar: os dois viram amigos e recebem o evento em tempo real", async () => {
    const [a, b] = [await player(), await player()];
    const r = await call(a, "POST", "/social/requests", { username: b.username.toUpperCase() });
    expect(r.json().status).toBe("sent");
    expect(events.find((e) => e.to === b.id && e.ev.k === "friend_request")).toBeTruthy();

    const ovB = (await call(b, "GET", "/social/overview")).json();
    expect(ovB.incoming).toHaveLength(1);
    expect(ovB.incoming[0].user.username).toBe(a.username);
    expect((await call(a, "GET", "/social/overview")).json().outgoing).toHaveLength(1);

    // Só o destinatário aceita.
    expect((await call(a, "POST", `/social/requests/${r.json().requestId}/accept`)).statusCode).toBe(404);
    expect((await call(b, "POST", `/social/requests/${r.json().requestId}/accept`)).statusCode).toBe(200);
    const fa = (await call(a, "GET", "/social/overview")).json();
    expect(fa.friends.map((f: { id: string }) => f.id)).toEqual([b.id]);
    expect(fa.outgoing).toHaveLength(0);
    expect(events.filter((e) => e.ev.k === "friend_accepted").map((e) => e.to).sort()).toEqual([a.id, b.id].sort());
    // Notificação para quem enviou.
    const notes = (await call(a, "GET", "/notifications")).json();
    expect(notes.unread).toBe(1);
    expect(notes.items[0].type).toBe("FRIEND_ACCEPTED");
  });

  it("pedido duplicado, a si mesmo, a quem não existe e a quem já é amigo", async () => {
    const [a, b] = [await player(), await player()];
    expect((await call(a, "POST", "/social/requests", { username: a.username })).json().error.code).toBe("SELF");
    expect((await call(a, "POST", "/social/requests", { username: "NinguemAqui" })).statusCode).toBe(404);
    await call(a, "POST", "/social/requests", { username: b.username });
    expect((await call(a, "POST", "/social/requests", { username: b.username })).json().error.code).toBe("REQUEST_PENDING");
    // B adiciona A de volta: vira aceite automático.
    const back = await call(b, "POST", "/social/requests", { username: a.username });
    expect(back.json().status).toBe("accepted");
    expect((await call(a, "POST", "/social/requests", { username: b.username })).json().error.code).toBe("ALREADY_FRIENDS");
  });

  it("aceitar duas vezes ao mesmo tempo cria uma amizade só", async () => {
    const [a, b] = [await player(), await player()];
    const id = (await call(a, "POST", "/social/requests", { username: b.username })).json().requestId;
    const res = await Promise.all([call(b, "POST", `/social/requests/${id}/accept`), call(b, "POST", `/social/requests/${id}/accept`)]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 404]);
    expect(await ctx.prisma.friend.count()).toBe(1);
  });

  it("recusar, cancelar e desfazer amizade", async () => {
    const [a, b, c] = [await player(), await player(), await player()];
    const r1 = (await call(a, "POST", "/social/requests", { username: b.username })).json().requestId;
    expect((await call(b, "POST", `/social/requests/${r1}/decline`)).statusCode).toBe(200);
    expect((await call(b, "GET", "/social/overview")).json().incoming).toHaveLength(0);
    const r2 = (await call(a, "POST", "/social/requests", { username: c.username })).json().requestId;
    expect((await call(c, "DELETE", `/social/requests/${r2}`)).statusCode).toBe(404); // só quem enviou cancela
    expect((await call(a, "DELETE", `/social/requests/${r2}`)).statusCode).toBe(200);
    expect((await call(c, "GET", "/social/overview")).json().incoming).toHaveLength(0);

    await befriend(a, c);
    expect((await call(c, "DELETE", `/social/friends/${a.id}`)).statusCode).toBe(200);
    expect((await call(a, "GET", "/social/overview")).json().friends).toHaveLength(0);
    expect(events.filter((e) => e.ev.k === "friend_removed").map((e) => e.to).sort()).toEqual([a.id, c.id].sort());
  });

  it("busca por prefixo mostra a relação e esconde quem me bloqueou", async () => {
    const [a, b, c] = [await player(), await player(), await player()];
    await befriend(a, b);
    await call(c, "POST", "/social/blocks", { userId: a.id });
    const res = (await call(a, "GET", `/social/search?q=operador`)).json().results as Array<{ id: string; relation: string }>;
    expect(res.find((r) => r.id === b.id)?.relation).toBe("friend");
    expect(res.find((r) => r.id === c.id)).toBeUndefined();
    expect(res.find((r) => r.id === a.id)).toBeUndefined();
    expect((await call(a, "GET", `/social/search?q=o`)).json().results).toEqual([]);
  });
});

describe("bloqueio e silêncio", () => {
  it("bloquear desfaz a amizade, cancela pedidos e impede novos pedidos nos dois sentidos", async () => {
    const [a, b, c] = [await player(), await player(), await player()];
    await befriend(a, b);
    await call(c, "POST", "/social/requests", { username: a.username });
    expect((await call(a, "POST", "/social/blocks", { userId: b.id })).statusCode).toBe(200);
    expect((await call(a, "POST", "/social/blocks", { userId: c.id })).statusCode).toBe(200);
    const ov = (await call(a, "GET", "/social/overview")).json();
    expect(ov.friends).toHaveLength(0);
    expect(ov.incoming).toHaveLength(0);
    expect(ov.blocked.map((u: { id: string }) => u.id).sort()).toEqual([b.id, c.id].sort());
    // Quem bloqueou recebe um aviso claro; quem foi bloqueado não descobre (parece que a conta não existe).
    expect((await call(a, "POST", "/social/requests", { username: b.username })).json().error.code).toBe("BLOCKED");
    expect((await call(b, "POST", "/social/requests", { username: a.username })).statusCode).toBe(404);
    expect(events.some((e) => e.to === b.id && e.ev.k === "relations_changed")).toBe(true);

    expect((await call(a, "DELETE", `/social/blocks/${b.id}`)).statusCode).toBe(200);
    expect((await call(b, "POST", "/social/requests", { username: a.username })).statusCode).toBe(200);
    expect((await call(a, "POST", "/social/blocks", { userId: a.id })).json().error.code).toBe("SELF");
  });

  it("silenciar aparece na lista e pode ser desfeito", async () => {
    const [a, b] = [await player(), await player()];
    expect((await call(a, "POST", "/social/mutes", { userId: b.id })).statusCode).toBe(200);
    expect((await call(a, "POST", "/social/mutes", { userId: b.id })).statusCode).toBe(200); // idempotente
    expect((await call(a, "GET", "/social/overview")).json().muted.map((u: { id: string }) => u.id)).toEqual([b.id]);
    await call(a, "DELETE", `/social/mutes/${b.id}`);
    expect((await call(a, "GET", "/social/overview")).json().muted).toEqual([]);
  });
});

describe("jogadores recentes e denúncias", () => {
  async function playedTogether(players: P[], teams: number[]) {
    const map = await ctx.prisma.gameMap.findFirstOrThrow();
    return ctx.prisma.match.create({
      data: {
        mode: "TEAM_2V2",
        type: "CASUAL",
        status: "FINISHED",
        mapId: map.id,
        roundsToWin: 6,
        endedAt: new Date(),
        players: { create: players.map((p, i) => ({ userId: p.id, team: teams[i]! })) },
      },
    });
  }

  it("lista quem jogou comigo, sem repetir, indicando aliado ou adversário", async () => {
    const [a, b, c, d] = [await player(), await player(), await player(), await player()];
    await playedTogether([a, b, c, d], [0, 0, 1, 1]);
    await playedTogether([a, b], [0, 1]);
    const list = (await call(a, "GET", "/social/recent")).json().players as Array<{ id: string; teammate: boolean }>;
    expect(list.map((p) => p.id).sort()).toEqual([b.id, c.id, d.id].sort());
    expect(list.find((p) => p.id === c.id)?.teammate).toBe(false);
    expect(list).toHaveLength(3);
  });

  it("denúncia exige ter jogado junto quando cita a partida e não aceita duplicata", async () => {
    const [a, b, c] = [await player(), await player(), await player()];
    const m = await playedTogether([a, b], [0, 1]);
    const ok = await call(a, "POST", "/reports", { userId: b.id, reason: "TOXIC_CHAT", matchId: m.id, description: "xingou no chat" });
    expect(ok.statusCode).toBe(201);
    expect((await call(a, "POST", "/reports", { userId: b.id, reason: "TOXIC_CHAT", matchId: m.id })).json().error.code).toBe("ALREADY_REPORTED");
    expect((await call(c, "POST", "/reports", { userId: b.id, reason: "CHEATING", matchId: m.id })).json().error.code).toBe("NOT_IN_MATCH");
    expect((await call(a, "POST", "/reports", { userId: a.id, reason: "OTHER" })).json().error.code).toBe("SELF");
    expect((await call(a, "POST", "/reports", { userId: b.id, reason: "INVENTADO" })).statusCode).toBe(400);
    const row = await ctx.prisma.report.findFirstOrThrow();
    expect(row).toMatchObject({ reporterId: a.id, reportedId: b.id, reason: "TOXIC_CHAT", status: "OPEN" });
  });

  it("rotas sociais exigem login", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/social/overview" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/reports", payload: {} })).statusCode).toBe(401);
  });
});
