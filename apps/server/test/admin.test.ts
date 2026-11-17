import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_PROTOCOL_VERSION, WEAPON_CATALOG, type PlayerMatchStats, type SocialEvent } from "@vanta/shared";
import { GameServer } from "../src/game/server.js";
import type { MatchResult } from "../src/game/match.js";
import { TestClient } from "./game-helpers.js";
import { closeTestContext, createTestContext, newPlayer, resetState, type TestContext } from "./helpers.js";

let ctx: TestContext;
let gs: GameServer;
let url: string;
const SECRET = "segredo-de-teste-com-mais-de-32-caracteres-ok";
const RIFLE = WEAPON_CATALOG.find((w) => w.category === "ASSAULT_RIFLE")!.code;
const events: Array<{ to: string; ev: SocialEvent }> = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.bus.subscribe((to, ev) => events.push({ to, ev }));
  gs = new GameServer({ prisma: ctx.prisma, jwtSecret: SECRET, allowedOrigins: [], autoTick: false, recheckMs: 60_000, bus: ctx.bus, log: { info() {}, warn() {}, error: console.error } });
  const port = await gs.start(0, "127.0.0.1");
  url = `ws://127.0.0.1:${port}/game`;
});
afterAll(async () => {
  await gs.stop();
  await closeTestContext(ctx);
});
beforeEach(async () => {
  await ctx.prisma.$executeRawUnsafe(`TRUNCATE "Match" CASCADE`);
  await ctx.prisma.$executeRawUnsafe(`DELETE FROM "RankedSeason"`);
  await resetState(ctx);
  events.length = 0;
});

type Role = "PLAYER" | "MODERATOR" | "ADMIN" | "SUPERADMIN";
async function user(role: Role = "PLAYER") {
  const body = newPlayer();
  const j = (await ctx.app.inject({ method: "POST", url: "/auth/register", payload: body })).json();
  if (role !== "PLAYER") await ctx.prisma.user.update({ where: { id: j.user.id }, data: { role } });
  return { id: j.user.id as string, username: j.user.username as string, email: body.email, password: body.password, token: j.accessToken as string, h: { authorization: `Bearer ${j.accessToken}` } };
}
type U = Awaited<ReturnType<typeof user>>;
const get = (u: U, path: string) => ctx.app.inject({ method: "GET", url: path, headers: u.h });
const post = (u: U, path: string, payload: object) => ctx.app.inject({ method: "POST", url: path, headers: u.h, payload });
const put = (u: U, path: string, payload: object) => ctx.app.inject({ method: "PUT", url: path, headers: u.h, payload });

/** Partida gravada pelo servidor de jogo com mensagens de chat do denunciado. */
async function matchWithChat(a: U, b: U) {
  const matchId = crypto.randomUUID();
  const players = [a, b].map((p, i) => ({ id: p.id, username: p.username, kills: 0, deaths: 0, assists: 0, headshots: 0, damage: 0, shots: 0, hits: 0, abandoned: false, mvp: i === 0, characterId: null, team: i as 0 | 1 })) as Array<PlayerMatchStats & { characterId: string | null }>;
  const r: MatchResult = {
    matchId, mode: "1v1", mapCode: "NEON_DISTRICT", ranked: false, winner: 0, score: [5, 0], reason: "score", startedAt: new Date(Date.now() - 60_000), endedAt: new Date(), roundsToWin: 5, roomId: null, players,
    events: [{ tick: 100, round: 1, type: "chat", actorId: b.id, data: { channel: "all", text: "mensagem ofensiva de teste" } }, { tick: 120, round: 1, type: "chat", actorId: a.id, data: { channel: "all", text: "do denunciante" } }],
  };
  await gs.persist(r);
  return matchId;
}

describe("painel administrativo", () => {
  it("jogador não entra; cada cargo recebe as próprias permissões", async () => {
    const [p, mod, sup] = [await user(), await user("MODERATOR"), await user("SUPERADMIN")];
    expect((await get(p, "/admin/me")).statusCode).toBe(403);
    expect((await get(p, "/admin/overview")).statusCode).toBe(403);
    const m = (await get(mod, "/admin/me")).json();
    expect(m.permissions).toContain("reports.handle");
    expect(m.permissions).not.toContain("wallet.adjust");
    expect((await get(sup, "/admin/me")).json().permissions).toContain("roles.manage");
  });

  it("moderador trata a denúncia com a prova do chat e aplica silêncio; tudo fica no registro", async () => {
    const [a, b, mod, mod2] = [await user(), await user(), await user("MODERATOR"), await user("MODERATOR")];
    const matchId = await matchWithChat(a, b);
    const rep = (await post(a, "/reports", { userId: b.id, reason: "TOXIC_CHAT", matchId, description: "xingou no chat" })).json();
    const list = (await get(mod, "/admin/reports")).json();
    expect(list.reports.map((r: { id: string }) => r.id)).toEqual([rep.id]);
    const detail = (await get(mod, `/admin/reports/${rep.id}`)).json();
    expect(detail.chat).toEqual([expect.objectContaining({ text: "mensagem ofensiva de teste", channel: "all", round: 1 })]);
    expect(detail.reported.username).toBe(b.username);

    // Fora do limite do moderador: recusado sem mexer em nada.
    const tooLong = await post(mod, `/admin/reports/${rep.id}/resolve`, { status: "ACTION_TAKEN", resolution: "ofensas confirmadas", ban: { type: "SUSPENSION", reason: "ofensas no chat", hours: 100 } });
    expect(tooLong.statusCode).toBe(403);
    expect(await ctx.prisma.ban.count()).toBe(0);

    const ok = await post(mod, `/admin/reports/${rep.id}/resolve`, { status: "ACTION_TAKEN", resolution: "ofensas confirmadas", ban: { type: "CHAT_MUTE", reason: "ofensas no chat", hours: 24 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "ACTION_TAKEN", handledBy: mod.username });
    const ban = await ctx.prisma.ban.findFirstOrThrow({ where: { userId: b.id } });
    expect(ban).toMatchObject({ type: "CHAT_MUTE", issuedById: mod.id });
    expect(ban.endsAt!.getTime() - ban.startsAt.getTime()).toBe(24 * 3600_000);
    expect(events).toContainEqual({ to: b.id, ev: { k: "relations_changed" } });

    // Outro moderador não trata de novo a mesma denúncia.
    const again = await post(mod2, `/admin/reports/${rep.id}/resolve`, { status: "DISMISSED", resolution: "duplicada aqui" });
    expect(again.statusCode).toBe(409);

    const audit = (await get(mod, "/admin/audit")).json();
    expect(audit.entries.map((e: { action: string }) => e.action).sort()).toEqual(["ban.create", "report.resolve"]);
    expect(audit.entries[0].ip).toBeNull(); // moderador não vê IP
    // Moderador só vê o que ele mesmo fez.
    expect((await get(mod2, "/admin/audit")).json().entries).toEqual([]);
  });

  it("hierarquia: ninguém pune a si mesmo nem cargo igual ou maior; moderador não vê e-mail", async () => {
    const [p, mod, mod2, adm] = [await user(), await user("MODERATOR"), await user("MODERATOR"), await user("ADMIN")];
    const mute = { type: "CHAT_MUTE", reason: "teste de hierarquia", hours: 1 };
    expect((await post(mod, `/admin/users/${mod.id}/bans`, mute)).statusCode).toBe(403);
    expect((await post(mod, `/admin/users/${mod2.id}/bans`, mute)).statusCode).toBe(403);
    expect((await post(mod, `/admin/users/${adm.id}/bans`, mute)).statusCode).toBe(403);
    expect((await post(mod, `/admin/users/${p.id}/bans`, { type: "RANKED_BAN", reason: "boosting no ranqueado", hours: 24 })).statusCode).toBe(403);
    expect((await post(mod, `/admin/users/${p.id}/bans`, { type: "PERMANENT", reason: "trapaça", hours: null })).statusCode).toBe(403);
    expect((await post(adm, `/admin/users/${mod.id}/bans`, mute)).statusCode).toBe(200);

    const seen = (await get(mod, `/admin/users/${p.id}`)).json();
    expect(seen.email).toMatch(/^\w{2}\*\*\*@teste\.vanta$/);
    const full = (await get(adm, `/admin/users/${p.id}`)).json();
    expect(full.email).toBe(p.email);
    // Moderador não acha conta pelo e-mail; admin acha.
    expect((await get(mod, `/admin/users?q=${encodeURIComponent(p.email)}`)).json().users).toEqual([]);
    expect((await get(adm, `/admin/users?q=${encodeURIComponent(p.email)}`)).json().users.map((u: { id: string }) => u.id)).toEqual([p.id]);
    expect(await ctx.prisma.adminAuditLog.count({ where: { action: "user.view", actorId: adm.id } })).toBe(1);
    expect(await ctx.prisma.adminAuditLog.count({ where: { action: "user.view", actorId: mod.id } })).toBe(0);
  });

  it("suspensão derruba sessão e partida na hora; revogar devolve a conta", async () => {
    const [p, adm] = [await user(), await user("ADMIN")];
    const c = new TestClient(url);
    await c.open();
    c.send({ t: "hello", token: p.token, v: GAME_PROTOCOL_VERSION });
    await c.waitFor("welcome");

    const res = await post(adm, `/admin/users/${p.id}/bans`, { type: "SUSPENSION", reason: "trapaça em investigação", hours: 48 });
    expect(res.statusCode).toBe(200);
    expect(events).toContainEqual({ to: p.id, ev: { k: "account_changed" } });
    expect((await c.waitClosed())?.code).toBe(4001);
    expect((await get(p, "/me")).statusCode).toBe(401);
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { identifier: p.email, password: p.password } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.message).toMatch(/suspensa até .*trapaça em investigação/);
    expect(await ctx.prisma.authSession.count({ where: { userId: p.id, revokedAt: null } })).toBe(0);

    const banId = res.json().id;
    expect((await post(adm, `/admin/bans/${banId}/revoke`, { reason: "investigação encerrada" })).statusCode).toBe(200);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("ACTIVE");
    expect((await ctx.app.inject({ method: "POST", url: "/auth/login", payload: { identifier: p.email, password: p.password } })).statusCode).toBe(200);
    expect((await post(adm, `/admin/bans/${banId}/revoke`, { reason: "de novo" })).statusCode).toBe(409);
  });

  it("banimento do ranqueado barra a fila ranqueada, mas não a casual", async () => {
    const [p, adm] = [await user(), await user("ADMIN")];
    await ctx.prisma.rankedSeason.create({ data: { number: 1, name: "Temporada de teste", startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400_000), isActive: true } });
    expect((await post(adm, `/admin/users/${p.id}/bans`, { type: "RANKED_BAN", reason: "boosting comprovado", hours: 72 })).statusCode).toBe(200);
    const c = new TestClient(url);
    await c.open();
    c.send({ t: "hello", token: p.token, v: GAME_PROTOCOL_VERSION });
    await c.waitFor("welcome");
    c.send({ t: "queue", mode: "1v1", loadout: [RIFLE], ranked: true });
    expect((await c.waitFor("error")).message).toMatch(/Você está banido do ranqueado até/);
    c.send({ t: "queue", mode: "1v1", loadout: [RIFLE] });
    expect(await c.waitFor("queue", (m) => m.state === "searching")).toMatchObject({ ranked: false });
    c.close();
  });

  it("só o superadmin muda cargos, e nunca o próprio nem o de outro superadmin", async () => {
    const [p, adm, sup, sup2] = [await user(), await user("ADMIN"), await user("SUPERADMIN"), await user("SUPERADMIN")];
    const body = { role: "MODERATOR", reason: "entrou para a moderação" };
    expect((await put(adm, `/admin/users/${p.id}/role`, body)).statusCode).toBe(403);
    expect((await put(sup, `/admin/users/${sup.id}/role`, body)).statusCode).toBe(403);
    expect((await put(sup, `/admin/users/${sup2.id}/role`, body)).statusCode).toBe(403);
    expect((await put(sup, `/admin/users/${p.id}/role`, { role: "SUPERADMIN", reason: "não pode" })).statusCode).toBe(400);
    const ok = await put(sup, `/admin/users/${p.id}/role`, body);
    expect(ok.json()).toEqual({ role: "MODERATOR", changed: true });
    // O token antigo (com o cargo antigo) deixa de valer.
    expect((await get(p, "/me")).statusCode).toBe(401);
    const entry = await ctx.prisma.adminAuditLog.findFirstOrThrow({ where: { action: "role.set" } });
    expect(entry).toMatchObject({ actorId: sup.id, targetId: p.id, before: { role: "PLAYER" } });
  });

  it("o registro de auditoria não aceita alteração nem exclusão", async () => {
    const [p, adm] = [await user(), await user("ADMIN")];
    await post(adm, `/admin/users/${p.id}/bans`, { type: "CHAT_MUTE", reason: "teste do registro", hours: 1 });
    const n = await ctx.prisma.adminAuditLog.count();
    expect(n).toBeGreaterThan(0);
    await expect(ctx.prisma.adminAuditLog.updateMany({ data: { action: "apagado" } })).rejects.toThrow(/somente-inserção/);
    await expect(ctx.prisma.adminAuditLog.deleteMany({})).rejects.toThrow(/somente-inserção/);
    expect(await ctx.prisma.adminAuditLog.count()).toBe(n);
  });

  it("admin concede item com auditoria; não concede duas vezes", async () => {
    const [p, adm, mod] = [await user(), await user("ADMIN"), await user("MODERATOR")];
    const item = await ctx.prisma.storeItem.findFirstOrThrow();
    const body = { storeItemId: item.id, reason: "compensação de bug" };
    expect((await post(mod, `/admin/users/${p.id}/grant`, body)).statusCode).toBe(403);
    expect((await post(adm, `/admin/users/${p.id}/grant`, body)).statusCode).toBe(200);
    expect((await post(adm, `/admin/users/${p.id}/grant`, body)).statusCode).toBe(409);
    expect(await ctx.prisma.inventory.count({ where: { userId: p.id, source: "ADMIN_GRANT" } })).toBe(1);
    expect(await ctx.prisma.adminAuditLog.count({ where: { action: "item.grant", targetId: p.id } })).toBe(1);
  });
});

describe("configurações na conta", () => {
  it("guarda as teclas validadas no servidor", async () => {
    const p = await user();
    const def = (await get(p, "/me/settings")).json();
    expect(def.keybinds.forward).toEqual(["KeyW", "ArrowUp"]);
    const saved = (await put(p, "/me/settings", { keybinds: { ...def.keybinds, jump: ["KeyF"], reload: ["KeyF", "Escape"] }, sensitivity: 1.5 })).json();
    expect(saved.keybinds.jump).toEqual(["KeyF"]);
    expect(saved.keybinds.reload).toEqual(["KeyR"]); // F já é do pulo e Escape é reservada: volta ao padrão
    expect(saved.sensitivity).toBe(1.5);
    expect((await get(p, "/me/settings")).json()).toEqual(saved);
    expect((await put(p, "/me/settings", { sensitivity: 99 })).statusCode).toBe(400);
  });
});
