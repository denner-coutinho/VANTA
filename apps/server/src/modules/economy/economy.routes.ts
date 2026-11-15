import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CheckoutResponse, CoinPackagesResponse, PaymentOrderView, StoreCatalogResponse, StoreItemView, WalletResponse } from "@vanta/shared";
import { AppError, Errors } from "../../lib/errors.js";
import { STORE_ITEM_INCLUDE, forSaleWhere, purchaseItem, setEquipped, toItemView } from "./store.service.js";
import { applyPaymentEvent, type PaymentGateway } from "./payments.js";
import { postLedger } from "./wallet.js";

const ITEM_ORDER = [{ type: "asc" as const }, { priceVc: "asc" as const }, { name: "asc" as const }];
const id = z.string().min(1).max(40);

/**
 * Economia: carteira, loja, inventário e compra de VANTA COINS.
 * Regras: o saldo e os preços vêm sempre do banco; o cliente só envia o que quer comprar.
 */
export async function economyRoutes(app: FastifyInstance, opts: { payments: PaymentGateway | null }) {
  const gateway = opts.payments;
  const buyLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  const balanceOf = async (userId: string) => (await app.prisma.wallet.findUnique({ where: { userId } }))?.balance ?? 0;

  // ───────── Loja e inventário ─────────

  app.get("/store/catalog", { preHandler: app.authenticate }, async (req): Promise<StoreCatalogResponse> => {
    const userId = req.auth.userId;
    const [items, owned, balance] = await Promise.all([
      app.prisma.storeItem.findMany({ where: forSaleWhere(), include: STORE_ITEM_INCLUDE, orderBy: ITEM_ORDER }),
      app.prisma.inventory.findMany({ where: { userId } }),
      balanceOf(userId),
    ]);
    const inv = new Map(owned.map((o) => [o.storeItemId, o]));
    return { balance, items: items.map((i) => toItemView(i, inv.get(i.id))) };
  });

  app.post("/store/purchase", { ...buyLimit, preHandler: app.authenticate }, async (req) => {
    const { itemId } = z.object({ itemId: id }).parse(req.body);
    return purchaseItem(app.prisma, req.auth.userId, itemId);
  });

  app.get("/inventory", { preHandler: app.authenticate }, async (req): Promise<{ items: StoreItemView[] }> => {
    const rows = await app.prisma.inventory.findMany({ where: { userId: req.auth.userId }, include: { storeItem: { include: STORE_ITEM_INCLUDE } }, orderBy: { acquiredAt: "desc" } });
    return { items: rows.map((r) => toItemView(r.storeItem, r)) };
  });

  app.post("/inventory/equip", { preHandler: app.authenticate }, async (req) => {
    const body = z.object({ itemId: id, equip: z.boolean().default(true) }).parse(req.body);
    return setEquipped(app.prisma, req.auth.userId, body.itemId, body.equip);
  });

  // ───────── Carteira ─────────

  app.get("/wallet", { preHandler: app.authenticate }, async (req): Promise<WalletResponse> => {
    const q = z.object({ cursor: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const userId = req.auth.userId;
    const rows = await app.prisma.walletTransaction.findMany({
      where: { walletUserId: userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: { id: true, type: true, amount: true, balanceAfter: true, description: true, createdAt: true },
    });
    const page = rows.slice(0, q.limit);
    return {
      balance: await balanceOf(userId),
      transactions: page.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
      nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
    };
  });

  // ───────── Compra de VANTA COINS (Stripe Checkout) ─────────

  app.get("/store/coin-packages", async (): Promise<CoinPackagesResponse> => {
    const packages = await app.prisma.coinPackage.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" }, select: { id: true, code: true, coins: true, bonusCoins: true, priceCents: true, currency: true } });
    return { paymentsEnabled: !!gateway, packages };
  });

  app.post("/payments/checkout", { ...buyLimit, preHandler: app.authenticate }, async (req): Promise<CheckoutResponse> => {
    if (!gateway) throw new AppError(503, "PAYMENTS_DISABLED", "A compra de VANTA COINS ainda não está disponível neste servidor.");
    const body = z.object({ packageId: id, requestId: z.string().uuid() }).parse(req.body);
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: req.auth.userId }, select: { id: true, email: true, emailVerifiedAt: true } });
    if (!user.emailVerifiedAt) throw Errors.forbidden("Confirme seu e-mail antes de comprar VANTA COINS: o recibo e a recuperação da conta dependem dele.");
    const pkg = await app.prisma.coinPackage.findFirst({ where: { id: body.packageId, isActive: true } });
    if (!pkg) throw Errors.notFound("Pacote indisponível.");

    // Um pedido por clique (requestId). Repetir o mesmo clique devolve a mesma sessão da Stripe.
    let order = await app.prisma.paymentOrder.findUnique({ where: { clientRequestId: body.requestId } });
    if (order && (order.userId !== user.id || order.coinPackageId !== pkg.id)) throw Errors.conflict("IDEMPOTENCY_CONFLICT", "Pedido inválido. Recarregue a página.");
    if (order && order.status !== "PENDING") throw Errors.conflict("ORDER_CLOSED", "Este pedido já foi encerrado.");
    order ??= await app.prisma.paymentOrder.create({
      data: { userId: user.id, coinPackageId: pkg.id, coins: pkg.coins + pkg.bonusCoins, priceCents: pkg.priceCents, currency: pkg.currency, clientRequestId: body.requestId },
    });

    const base = app.config.PUBLIC_APP_URL.replace(/\/$/, "");
    const session = await gateway.createCheckout({
      orderId: order.id,
      userId: user.id,
      email: user.email,
      productName: `${order.coins.toLocaleString("pt-BR")} VANTA COINS`,
      priceCents: order.priceCents,
      currency: order.currency,
      successUrl: `${base}/loja?pedido=${order.id}`,
      cancelUrl: `${base}/loja?pedido=${order.id}&cancelado=1`,
    });
    await app.prisma.paymentOrder.update({ where: { id: order.id }, data: { providerSessionId: session.sessionId } });
    return { orderId: order.id, url: session.url };
  });

  app.get("/payments/orders/:id", { preHandler: app.authenticate }, async (req): Promise<PaymentOrderView> => {
    const { id: orderId } = z.object({ id }).parse(req.params);
    const o = await app.prisma.paymentOrder.findFirst({ where: { id: orderId, userId: req.auth.userId } });
    if (!o) throw Errors.notFound("Pedido não encontrado.");
    return { id: o.id, status: o.status, coins: o.coins, priceCents: o.priceCents, currency: o.currency, createdAt: o.createdAt.toISOString(), paidAt: o.paidAt?.toISOString() ?? null };
  });

  // Webhook: precisa do corpo exatamente como a Stripe enviou para conferir a assinatura.
  await app.register(async (hook) => {
    hook.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));
    hook.post("/payments/stripe/webhook", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
      if (!gateway) return reply.status(503).send({ error: { code: "PAYMENTS_DISABLED", message: "Pagamentos desativados." } });
      let ev;
      try {
        ev = gateway.verifyWebhook(req.body as Buffer, req.headers["stripe-signature"] as string | undefined);
      } catch {
        req.log.warn("webhook da Stripe com assinatura inválida");
        return reply.status(400).send({ error: { code: "BAD_SIGNATURE", message: "Assinatura inválida." } });
      }
      const outcome = await applyPaymentEvent(app.prisma, ev);
      req.log.info({ eventId: ev.id, type: ev.type, outcome }, "webhook de pagamento");
      return { received: true };
    });
  });

  // ───────── Administração (ADMIN+, auditado) ─────────

  app.post("/admin/wallet/adjust", { preHandler: app.requireRole("ADMIN") }, async (req) => {
    const body = z.object({ userId: id, amount: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0), reason: z.string().trim().min(5).max(200), requestId: z.string().uuid() }).parse(req.body);
    const result = await app.prisma.$transaction(async (tx) => {
      const r = await postLedger(tx, { userId: body.userId, amount: body.amount, type: "ADMIN_ADJUSTMENT", idempotencyKey: `admin:${body.requestId}`, description: `Ajuste: ${body.reason}`, meta: { actorId: req.auth.userId } });
      if (r.applied) await tx.adminAuditLog.create({ data: { actorId: req.auth.userId, action: "wallet.adjust", targetType: "User", targetId: body.userId, after: { amount: body.amount, reason: body.reason, balanceAfter: r.balanceAfter }, ip: req.ip } });
      return r;
    });
    return { balance: result.balanceAfter, applied: result.applied };
  });
}
