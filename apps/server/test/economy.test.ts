import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { SEASON_REWARD_VC, WEAPON_CATALOG, rankForPoints, seasonEmblemCode, type StoreCatalogResponse } from "@vanta/shared";
import { StripeGateway } from "../src/modules/economy/payments.js";
import { ledgerSum, postLedger } from "../src/modules/economy/wallet.js";
import { closeSeason } from "../src/modules/ranked/season.service.js";
import { GameServer } from "../src/game/server.js";
import { TestClient } from "./game-helpers.js";
import { closeTestContext, createTestContext, newPlayer, resetState, type TestContext } from "./helpers.js";
import { GAME_PROTOCOL_VERSION } from "@vanta/shared";

const WHSEC = "whsec_teste_economia_vanta";
const stripe = new Stripe("sk_test_sem_rede_nos_testes");
/** Sessões criadas pelo "Checkout": o cliente Stripe dos testes não sai para a rede. */
const sessions: Array<Stripe.Checkout.SessionCreateParams & { id: string }> = [];
stripe.checkout.sessions.create = (async (params: Stripe.Checkout.SessionCreateParams) => {
  const id = `cs_test_${sessions.length + 1}`;
  sessions.push({ ...params, id });
  return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
}) as unknown as typeof stripe.checkout.sessions.create;

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({ payments: new StripeGateway("sk_test_x", WHSEC, stripe) });
});
afterAll(async () => closeTestContext(ctx));
beforeEach(async () => {
  sessions.length = 0;
  await resetState(ctx);
});

async function register(opts: { verified?: boolean; role?: "ADMIN" } = {}) {
  const res = await ctx.app.inject({ method: "POST", url: "/auth/register", payload: newPlayer() });
  const j = res.json();
  if (opts.verified) await ctx.prisma.user.update({ where: { id: j.user.id }, data: { emailVerifiedAt: new Date() } });
  if (opts.role) await ctx.prisma.user.update({ where: { id: j.user.id }, data: { role: opts.role } });
  return { token: j.accessToken as string, userId: j.user.id as string, auth: { authorization: `Bearer ${j.accessToken}` } };
}
type P = Awaited<ReturnType<typeof register>>;

const give = (userId: string, amount: number, key: string = crypto.randomUUID()) =>
  ctx.prisma.$transaction((tx) => postLedger(tx, { userId, amount, type: "ADMIN_ADJUSTMENT", idempotencyKey: `test:${key}`, description: "teste" }));
const balance = async (userId: string) => (await ctx.prisma.wallet.findUnique({ where: { userId } }))?.balance ?? 0;
const catalog = async (p: P) => (await ctx.app.inject({ method: "GET", url: "/store/catalog", headers: p.auth })).json() as StoreCatalogResponse;
const buy = (p: P, itemId: string, extra: Record<string, unknown> = {}) => ctx.app.inject({ method: "POST", url: "/store/purchase", headers: p.auth, payload: { itemId, ...extra } });

/** Envia um evento como a Stripe envia: corpo JSON cru + cabeçalho Stripe-Signature. */
function webhook(event: Record<string, unknown>, secret = WHSEC) {
  const payload = JSON.stringify({ object: "event", api_version: "2025-01-01", created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 1, request: null, ...event });
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return ctx.app.inject({ method: "POST", url: "/payments/stripe/webhook", headers: { "content-type": "application/json", "stripe-signature": sig }, payload });
}
const sessionCompleted = (sessionId: string, orderId: string, over: Record<string, unknown> = {}) => ({
  id: `evt_${crypto.randomUUID()}`,
  type: "checkout.session.completed",
  data: { object: { id: sessionId, object: "checkout.session", client_reference_id: orderId, metadata: { orderId }, payment_intent: `pi_${sessionId}`, payment_status: "paid", amount_total: 1990, currency: "brl", ...over } },
});

async function checkout(p: P, code = "VC_1200") {
  const pkg = await ctx.prisma.coinPackage.findUniqueOrThrow({ where: { code } });
  const requestId = crypto.randomUUID();
  const res = await ctx.app.inject({ method: "POST", url: "/payments/checkout", headers: p.auth, payload: { packageId: pkg.id, requestId } });
  return { res, pkg, requestId };
}

describe("carteira (razão)", () => {
  it("saldo nunca fica negativo e o cache bate com a soma do razão", async () => {
    const a = await register();
    await give(a.userId, 500);
    await expect(ctx.prisma.$transaction((tx) => postLedger(tx, { userId: a.userId, amount: -600, type: "STORE_DEBIT", idempotencyKey: "x1", description: "x" }))).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(await balance(a.userId)).toBe(500);
    expect(await ledgerSum(ctx.prisma, a.userId)).toBe(500);
  });

  it("mesma chave de idempotência não lança duas vezes", async () => {
    const a = await register();
    await give(a.userId, 300, "k");
    await give(a.userId, 300, "k");
    expect(await balance(a.userId)).toBe(300);
    expect(await ctx.prisma.walletTransaction.count({ where: { walletUserId: a.userId } })).toBe(1);
  });

  it("GET /wallet mostra saldo e histórico paginado do próprio jogador", async () => {
    const a = await register();
    for (let i = 0; i < 3; i++) await give(a.userId, 100);
    const p1 = (await ctx.app.inject({ method: "GET", url: "/wallet?limit=2", headers: a.auth })).json();
    expect(p1.balance).toBe(300);
    expect(p1.transactions).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await ctx.app.inject({ method: "GET", url: `/wallet?limit=2&cursor=${p1.nextCursor}`, headers: a.auth })).json();
    expect(p2.transactions).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
  });
});

describe("loja e inventário", () => {
  it("catálogo lista só itens à venda, com preço do banco e sem emblemas de temporada", async () => {
    const a = await register();
    const c = await catalog(a);
    expect(c.items.length).toBeGreaterThanOrEqual(20);
    expect(c.items.every((i) => i.priceVc! > 0 && i.type !== "EMBLEM")).toBe(true);
    expect(c.items.some((i) => i.type === "WEAPON_SKIN" && i.target?.kind === "weapon")).toBe(true);
    expect(c.items.some((i) => i.type === "CHARACTER_SKIN" && i.target?.kind === "character")).toBe(true);
  });

  it("compra debita o preço do banco (ignora preço enviado pelo cliente) e entrega o item", async () => {
    const a = await register();
    await give(a.userId, 1000);
    const item = (await catalog(a)).items.find((i) => i.priceVc === 600)!;
    const res = await buy(a, item.id, { priceVc: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().balance).toBe(400);
    expect(await balance(a.userId)).toBe(400);
    const inv = (await ctx.app.inject({ method: "GET", url: "/inventory", headers: a.auth })).json();
    expect(inv.items.map((i: { id: string }) => i.id)).toContain(item.id);
    expect(await ledgerSum(ctx.prisma, a.userId)).toBe(400);
  });

  it("sem saldo a compra é recusada e nada muda", async () => {
    const a = await register();
    await give(a.userId, 100);
    const item = (await catalog(a)).items[0]!;
    const res = await buy(a, item.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INSUFFICIENT_FUNDS");
    expect(await balance(a.userId)).toBe(100);
    expect(await ctx.prisma.inventory.count({ where: { userId: a.userId } })).toBe(0);
  });

  it("não compra duas vezes o mesmo item, nem com cliques simultâneos", async () => {
    const a = await register();
    await give(a.userId, 5000);
    const item = (await catalog(a)).items.find((i) => i.priceVc === 300)!;
    const results = await Promise.all(Array.from({ length: 5 }, () => buy(a, item.id)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409).length).toBe(4);
    expect(await balance(a.userId)).toBe(4700);
    expect(await ledgerSum(ctx.prisma, a.userId)).toBe(4700);
  });

  it("compras simultâneas de itens diferentes nunca gastam mais que o saldo", async () => {
    const a = await register();
    await give(a.userId, 900);
    const items = (await catalog(a)).items.filter((i) => i.priceVc === 300).slice(0, 5);
    const results = await Promise.all(items.map((i) => buy(a, i.id)));
    const ok = results.filter((r) => r.statusCode === 200).length;
    expect(ok).toBeLessThanOrEqual(3);
    expect(await balance(a.userId)).toBe(900 - ok * 300);
    expect(await ctx.prisma.inventory.count({ where: { userId: a.userId } })).toBe(ok);
    expect(await ledgerSum(ctx.prisma, a.userId)).toBe(900 - ok * 300);
  });

  it("item fora de venda (recompensa) não pode ser comprado", async () => {
    const a = await register();
    await give(a.userId, 5000);
    const emblem = await ctx.prisma.storeItem.findUniqueOrThrow({ where: { code: seasonEmblemCode(1) } });
    expect((await buy(a, emblem.id)).statusCode).toBe(404);
  });

  it("equipar troca a skin daquela arma, não mexe nas outras, e aparece em /me", async () => {
    const a = await register();
    await give(a.userId, 10000);
    const items = (await catalog(a)).items;
    const [d1, d2] = items.filter((i) => i.target?.code === "DX50_JUIZA");
    const other = items.find((i) => i.type === "WEAPON_SKIN" && i.target?.code === "VK7_LAMINA")!;
    for (const i of [d1!, d2!, other]) expect((await buy(a, i.id)).statusCode).toBe(200);
    const equip = (id: string, equip = true) => ctx.app.inject({ method: "POST", url: "/inventory/equip", headers: a.auth, payload: { itemId: id, equip } });
    await equip(d1!.id);
    await equip(other.id);
    await equip(d2!.id);
    const inv = (await ctx.app.inject({ method: "GET", url: "/inventory", headers: a.auth })).json().items as Array<{ id: string; equipped: boolean }>;
    const eq = new Map(inv.map((i) => [i.id, i.equipped]));
    expect([eq.get(d1!.id), eq.get(d2!.id), eq.get(other.id)]).toEqual([false, true, true]);
    const me = (await ctx.app.inject({ method: "GET", url: "/me", headers: a.auth })).json();
    expect(me.cosmetics.weapons.DX50_JUIZA).toEqual(d2!.material);
    expect(me.wallet.balance).toBe(10000 - d1!.priceVc! - d2!.priceVc! - other.priceVc!);
    await equip(d2!.id, false);
    const me2 = (await ctx.app.inject({ method: "GET", url: "/me", headers: a.auth })).json();
    expect(me2.cosmetics.weapons.DX50_JUIZA).toBeUndefined();
  });

  it("não equipa item que não possui", async () => {
    const a = await register();
    const item = (await catalog(a)).items[0]!;
    expect((await ctx.app.inject({ method: "POST", url: "/inventory/equip", headers: a.auth, payload: { itemId: item.id } })).statusCode).toBe(404);
  });
});

describe("compra de VANTA COINS (Stripe)", () => {
  it("cria o pedido com valores do banco e manda para o Checkout hospedado", async () => {
    const a = await register({ verified: true });
    const { res, pkg } = await checkout(a);
    expect(res.statusCode).toBe(200);
    const { orderId, url } = res.json();
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const s = sessions[0]!;
    expect(s.client_reference_id).toBe(orderId);
    expect(s.line_items![0]!.price_data!.unit_amount).toBe(pkg.priceCents);
    expect(s.success_url).toContain(`/loja?pedido=${orderId}`);
    const order = await ctx.prisma.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ status: "PENDING", coins: pkg.coins, priceCents: pkg.priceCents, providerSessionId: s.id });
    expect(await balance(a.userId)).toBe(0); // voltar do Checkout não credita nada
  });

  it("exige e-mail confirmado", async () => {
    const a = await register();
    expect((await checkout(a)).res.statusCode).toBe(403);
  });

  it("webhook assinado credita uma vez; reenvio do mesmo evento e evento repetido não duplicam", async () => {
    const a = await register({ verified: true });
    const { res, pkg } = await checkout(a);
    const { orderId } = res.json();
    const ev = sessionCompleted(sessions[0]!.id, orderId, { amount_total: pkg.priceCents });
    expect((await webhook(ev)).statusCode).toBe(200);
    expect((await webhook(ev)).statusCode).toBe(200);
    expect((await webhook({ ...ev, id: `evt_${crypto.randomUUID()}` })).statusCode).toBe(200);
    expect(await balance(a.userId)).toBe(pkg.coins);
    const order = await ctx.prisma.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("PAID");
    const view = (await ctx.app.inject({ method: "GET", url: `/payments/orders/${orderId}`, headers: a.auth })).json();
    expect(view.status).toBe("PAID");
  });

  it("assinatura inválida é rejeitada e não credita", async () => {
    const a = await register({ verified: true });
    const { res } = await checkout(a);
    const r = await webhook(sessionCompleted(sessions[0]!.id, res.json().orderId), "whsec_outro_segredo");
    expect(r.statusCode).toBe(400);
    expect(await balance(a.userId)).toBe(0);
    const forged = await ctx.app.inject({ method: "POST", url: "/payments/stripe/webhook", headers: { "content-type": "application/json" }, payload: JSON.stringify(sessionCompleted("cs_x", res.json().orderId)) });
    expect(forged.statusCode).toBe(400);
  });

  it("valor pago diferente do pedido não credita", async () => {
    const a = await register({ verified: true });
    const { res } = await checkout(a);
    await webhook(sessionCompleted(sessions[0]!.id, res.json().orderId, { amount_total: 1 }));
    expect(await balance(a.userId)).toBe(0);
    expect((await ctx.prisma.paymentOrder.findUniqueOrThrow({ where: { id: res.json().orderId } })).status).toBe("FAILED");
  });

  it("pagamento assíncrono só credita quando confirmado; sessão expirada encerra o pedido", async () => {
    const a = await register({ verified: true });
    const { res, pkg } = await checkout(a);
    const { orderId } = res.json();
    const sid = sessions[0]!.id;
    await webhook(sessionCompleted(sid, orderId, { payment_status: "unpaid", amount_total: pkg.priceCents }));
    expect(await balance(a.userId)).toBe(0);
    await webhook({ id: `evt_${crypto.randomUUID()}`, type: "checkout.session.async_payment_succeeded", data: { object: { id: sid, object: "checkout.session", client_reference_id: orderId, payment_intent: `pi_${sid}`, payment_status: "paid", amount_total: pkg.priceCents, currency: "brl" } } });
    expect(await balance(a.userId)).toBe(pkg.coins);

    const b = await checkout(a, "VC_500");
    await webhook({ id: `evt_${crypto.randomUUID()}`, type: "checkout.session.expired", data: { object: { id: sessions[1]!.id, object: "checkout.session", client_reference_id: b.res.json().orderId } } });
    expect((await ctx.prisma.paymentOrder.findUniqueOrThrow({ where: { id: b.res.json().orderId } })).status).toBe("EXPIRED");
  });

  it("estorno retira as moedas (proporcional no parcial) e chargeback retira o resto, sem saldo negativo", async () => {
    const a = await register({ verified: true });
    const { res, pkg } = await checkout(a, "VC_1200");
    const { orderId } = res.json();
    const sid = sessions[0]!.id;
    await webhook(sessionCompleted(sid, orderId, { amount_total: pkg.priceCents }));
    const pi = `pi_${sid}`;
    const charge = (refunded: number) => ({ id: `evt_${crypto.randomUUID()}`, type: "charge.refunded", data: { object: { id: "ch_1", object: "charge", payment_intent: pi, amount: pkg.priceCents, amount_refunded: refunded } } });
    await webhook(charge(Math.round(pkg.priceCents / 2)));
    expect(await balance(a.userId)).toBe(pkg.coins - Math.ceil((pkg.coins * Math.round(pkg.priceCents / 2)) / pkg.priceCents));
    expect((await ctx.prisma.paymentOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("PARTIALLY_REFUNDED");

    // Gastou o que sobrou na loja; depois vem a contestação: o saldo zera, não fica negativo.
    const left = await balance(a.userId);
    const item = (await catalog(a)).items.find((i) => i.priceVc! <= left)!;
    expect((await buy(a, item.id)).statusCode).toBe(200);
    await webhook({ id: `evt_${crypto.randomUUID()}`, type: "charge.dispute.created", data: { object: { id: "dp_1", object: "dispute", payment_intent: pi, status: "needs_response" } } });
    expect(await balance(a.userId)).toBe(0);
    const cb = await ctx.prisma.walletTransaction.findFirstOrThrow({ where: { walletUserId: a.userId, type: "CHARGEBACK_DEBIT" } });
    expect((cb.meta as { shortfall?: number }).shortfall).toBeGreaterThan(0);
    expect(await ledgerSum(ctx.prisma, a.userId)).toBe(0);
    expect((await ctx.prisma.paymentOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("DISPUTED");
  });

  it("sem Stripe configurada a compra de VC fica indisponível (sem simular)", async () => {
    const off = await createTestContext();
    try {
      const res = await off.app.inject({ method: "GET", url: "/store/coin-packages" });
      expect(res.json().paymentsEnabled).toBe(false);
      const r = await off.app.inject({ method: "POST", url: "/auth/register", payload: newPlayer() });
      const auth = { authorization: `Bearer ${r.json().accessToken}` };
      const pkg = await off.prisma.coinPackage.findFirstOrThrow();
      const c = await off.app.inject({ method: "POST", url: "/payments/checkout", headers: auth, payload: { packageId: pkg.id, requestId: crypto.randomUUID() } });
      expect(c.statusCode).toBe(503);
      expect(c.json().error.code).toBe("PAYMENTS_DISABLED");
    } finally {
      await closeTestContext(off);
    }
  });
});

describe("admin e temporada", () => {
  it("ajuste de saldo exige ADMIN e fica auditado", async () => {
    const [p, adm] = [await register(), await register({ role: "ADMIN" })];
    const payload = { userId: p.userId, amount: 250, reason: "compensação de teste", requestId: crypto.randomUUID() };
    expect((await ctx.app.inject({ method: "POST", url: "/admin/wallet/adjust", headers: p.auth, payload })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: "/admin/wallet/adjust", headers: adm.auth, payload })).json()).toMatchObject({ balance: 250, applied: true });
    expect((await ctx.app.inject({ method: "POST", url: "/admin/wallet/adjust", headers: adm.auth, payload })).json()).toMatchObject({ balance: 250, applied: false });
    expect(await ctx.prisma.adminAuditLog.count({ where: { action: "wallet.adjust", targetId: p.userId } })).toBe(1);
  });

  it("encerrar a temporada dá VC pelo melhor tier e o emblema, uma vez, só a quem se classificou", async () => {
    await ctx.prisma.$executeRawUnsafe(`TRUNCATE "Match","RankHistory" CASCADE`);
    await ctx.prisma.$executeRawUnsafe(`DELETE FROM "RankedSeason"`); // DELETE (não TRUNCATE CASCADE): preserva os itens da loja ligados a temporadas
    const now = Date.now();
    const season = await ctx.prisma.rankedSeason.create({ data: { number: 1, name: "Temporada de teste", startsAt: new Date(now - 1000), endsAt: new Date(now + 86400_000), isActive: true } });
    // O seed criou o emblema ligado à temporada que acabou de ser apagada: recria para esta.
    await ctx.prisma.storeItem.upsert({ where: { code: seasonEmblemCode(1) }, update: { seasonId: season.id }, create: { code: seasonEmblemCode(1), type: "EMBLEM", name: "Emblema · Temporada 1", description: "x", rarity: "SEASONAL", priceVc: null, imageKey: "e", seasonId: season.id } });
    const [a, b, c] = [await register(), await register(), await register()];
    const rate = (userId: string, mode: "DUEL_1V1" | "TEAM_2V2", points: number, placementLeft = 0) => ctx.prisma.rankedRating.create({ data: { userId, seasonId: season.id, mode, points, peakPoints: points, placementLeft } });
    await rate(a.userId, "DUEL_1V1", 200);
    await rate(a.userId, "TEAM_2V2", 1500); // melhor modo de A
    await rate(b.userId, "DUEL_1V1", 50);
    await rate(c.userId, "DUEL_1V1", 0, 3); // não terminou a classificação
    await closeSeason(ctx.prisma, season.id);
    expect(await balance(a.userId)).toBe(SEASON_REWARD_VC[rankForPoints(1500).tier]);
    expect(await balance(b.userId)).toBe(SEASON_REWARD_VC[rankForPoints(50).tier]);
    expect(await balance(c.userId)).toBe(0);
    const emblem = await ctx.prisma.storeItem.findUniqueOrThrow({ where: { code: seasonEmblemCode(1) } });
    expect(await ctx.prisma.inventory.count({ where: { storeItemId: emblem.id } })).toBe(2);
    await expect(closeSeason(ctx.prisma, season.id)).rejects.toMatchObject({ code: "SEASON_CLOSED" });
    expect(await balance(a.userId)).toBe(SEASON_REWARD_VC[rankForPoints(1500).tier]);
  });
});

describe("cosméticos na partida", () => {
  it("o servidor de jogo repassa a skin equipada do operador e das armas do arsenal", async () => {
    const gs = new GameServer({ prisma: ctx.prisma, jwtSecret: "segredo-de-teste-com-mais-de-32-caracteres-ok", allowedOrigins: [], autoTick: false, recheckMs: 60_000, log: { info() {}, warn() {}, error: console.error } });
    const url = `ws://127.0.0.1:${await gs.start(0, "127.0.0.1")}/game`;
    try {
      const [a, b] = [await register(), await register()];
      await give(a.userId, 10000);
      const items = (await catalog(a)).items;
      const raven = items.find((i) => i.target?.code === "RAVEN")!;
      const rifle = WEAPON_CATALOG.find((w) => w.code === "VK7_LAMINA")!;
      const rifleSkin = items.find((i) => i.target?.code === rifle.code)!;
      for (const i of [raven, rifleSkin]) {
        await buy(a, i.id);
        await ctx.app.inject({ method: "POST", url: "/inventory/equip", headers: a.auth, payload: { itemId: i.id } });
      }
      const ravenId = (await ctx.prisma.character.findUniqueOrThrow({ where: { code: "RAVEN" } })).id;
      await ctx.prisma.userProfile.update({ where: { userId: a.userId }, data: { mainCharacterId: ravenId } });
      const clients = [];
      for (const p of [a, b]) {
        const cl = new TestClient(url);
        await cl.open();
        cl.send({ t: "hello", token: p.token, v: GAME_PROTOCOL_VERSION });
        await cl.waitFor("welcome");
        cl.send({ t: "queue", mode: "1v1", loadout: [rifle.code, "P9_FAISCA"] });
        clients.push(cl);
      }
      const info = (await clients[1]!.waitFor("match")).info;
      const seen = info.players.find((p) => p.id === a.userId)!;
      expect(seen.cosmetics?.character).toEqual(raven.material);
      expect(seen.cosmetics?.weapons).toEqual({ [rifle.code]: rifleSkin.material });
      expect(info.players.find((p) => p.id === b.userId)!.cosmetics).toEqual({ character: null, weapons: {} });
      clients.forEach((c) => c.close());
    } finally {
      await gs.stop();
    }
  });
});

describe("emblemas", () => {
  it("emblema de temporada é de coleção: não equipa", async () => {
    const a = await register();
    const emblem = await ctx.prisma.storeItem.findUniqueOrThrow({ where: { code: seasonEmblemCode(1) } });
    await ctx.prisma.inventory.create({ data: { userId: a.userId, storeItemId: emblem.id, source: "SEASON_REWARD" } });
    const r = await ctx.app.inject({ method: "POST", url: "/inventory/equip", headers: a.auth, payload: { itemId: emblem.id } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("NOT_EQUIPPABLE");
  });
});
