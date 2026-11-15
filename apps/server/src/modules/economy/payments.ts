import Stripe from "stripe";
import type { PaymentStatus, Prisma, PrismaClient } from "@vanta/db";
import { postLedger } from "./wallet.js";

/**
 * Pagamentos de VANTA COINS.
 *
 * - O cartão é digitado na página da Stripe (Checkout hospedado). O jogo nunca vê nem guarda dados de cartão.
 * - Só o webhook assinado pela Stripe credita moedas. O retorno do navegador (success_url) não credita nada.
 * - Cada evento é gravado uma vez (event id único); cada pedido credita uma vez (chave de idempotência).
 */

export interface CheckoutRequest {
  orderId: string;
  userId: string;
  email: string;
  productName: string;
  priceCents: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

/** Evento já verificado, reduzido ao que o jogo usa. */
export type GatewayEvent =
  | { id: string; type: "checkout.completed" | "checkout.async_succeeded"; sessionId: string; orderId: string | null; paymentIntent: string | null; paid: boolean; amountTotal: number | null; currency: string | null; raw: unknown }
  | { id: string; type: "checkout.async_failed" | "checkout.expired"; sessionId: string; orderId: string | null; raw: unknown }
  | { id: string; type: "charge.refunded"; paymentIntent: string | null; amountRefunded: number; amount: number; raw: unknown }
  | { id: string; type: "charge.dispute_created" | "charge.dispute_closed"; paymentIntent: string | null; won: boolean; raw: unknown }
  | { id: string; type: "ignored"; stripeType: string; raw: unknown };

export interface PaymentGateway {
  createCheckout(req: CheckoutRequest): Promise<{ sessionId: string; url: string }>;
  /** Lança erro se a assinatura não confere. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): GatewayEvent;
}

const piId = (v: string | Stripe.PaymentIntent | null | undefined) => (typeof v === "string" ? v : v?.id ?? null);

export class StripeGateway implements PaymentGateway {
  private stripe: Stripe;
  constructor(secretKey: string, private webhookSecret: string, stripe?: Stripe) {
    this.stripe = stripe ?? new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 15_000 });
  }

  async createCheckout(r: CheckoutRequest) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        client_reference_id: r.orderId,
        customer_email: r.email,
        line_items: [{ quantity: 1, price_data: { currency: r.currency.toLowerCase(), unit_amount: r.priceCents, product_data: { name: r.productName } } }],
        metadata: { orderId: r.orderId, userId: r.userId },
        payment_intent_data: { metadata: { orderId: r.orderId, userId: r.userId } },
        success_url: r.successUrl,
        cancel_url: r.cancelUrl,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      },
      { idempotencyKey: `checkout:${r.orderId}` },
    );
    if (!session.url) throw new Error("Stripe não retornou a URL do Checkout.");
    return { sessionId: session.id, url: session.url };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): GatewayEvent {
    if (!signature) throw new Error("Assinatura ausente.");
    const ev = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    return StripeGateway.normalize(ev);
  }

  static normalize(ev: Stripe.Event): GatewayEvent {
    switch (ev.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = ev.data.object;
        return {
          id: ev.id,
          type: ev.type === "checkout.session.completed" ? "checkout.completed" : "checkout.async_succeeded",
          sessionId: s.id,
          orderId: s.client_reference_id ?? s.metadata?.orderId ?? null,
          paymentIntent: piId(s.payment_intent),
          paid: s.payment_status === "paid",
          amountTotal: s.amount_total,
          currency: s.currency,
          raw: ev,
        };
      }
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const s = ev.data.object;
        return { id: ev.id, type: ev.type === "checkout.session.expired" ? "checkout.expired" : "checkout.async_failed", sessionId: s.id, orderId: s.client_reference_id ?? s.metadata?.orderId ?? null, raw: ev };
      }
      case "charge.refunded": {
        const c = ev.data.object;
        return { id: ev.id, type: "charge.refunded", paymentIntent: piId(c.payment_intent), amountRefunded: c.amount_refunded, amount: c.amount, raw: ev };
      }
      case "charge.dispute.created":
      case "charge.dispute.closed": {
        const d = ev.data.object;
        return { id: ev.id, type: ev.type === "charge.dispute.created" ? "charge.dispute_created" : "charge.dispute_closed", paymentIntent: piId(d.payment_intent), won: d.status === "won", raw: ev };
      }
      default:
        return { id: ev.id, type: "ignored", stripeType: ev.type, raw: ev };
    }
  }
}

type Db = PrismaClient;

/**
 * Aplica um evento verificado. Idempotente: o mesmo evento (ou o mesmo pedido) nunca credita duas vezes.
 * Retorna o que foi feito, para log e testes.
 */
export async function applyPaymentEvent(db: Db, ev: GatewayEvent): Promise<string> {
  const already = await db.paymentWebhookEvent.findUnique({ where: { providerEventId: ev.id } });
  if (already?.processedAt) return "duplicate";
  const stored = already ?? (await db.paymentWebhookEvent.create({ data: { providerEventId: ev.id, type: ev.type === "ignored" ? ev.stripeType : ev.type, payload: ev.raw as Prisma.InputJsonValue } }).catch(async (e) => {
    // Corrida entre duas entregas do mesmo evento: a outra já gravou.
    if ((e as { code?: string }).code === "P2002") return db.paymentWebhookEvent.findUniqueOrThrow({ where: { providerEventId: ev.id } });
    throw e;
  }));

  try {
    const outcome = await db.$transaction(async (tx) => {
      const result = await handle(tx, ev);
      await tx.paymentWebhookEvent.update({ where: { id: stored.id }, data: { processedAt: new Date(), error: null, paymentOrderId: result.orderId ?? undefined } });
      return result.outcome;
    });
    return outcome;
  } catch (e) {
    await db.paymentWebhookEvent.update({ where: { id: stored.id }, data: { error: String((e as Error).message).slice(0, 500) } });
    throw e;
  }
}

async function findOrder(tx: Prisma.TransactionClient, by: { orderId?: string | null; sessionId?: string; paymentIntent?: string | null }) {
  if (by.orderId) {
    const o = await tx.paymentOrder.findUnique({ where: { id: by.orderId } });
    if (o) return o;
  }
  if (by.sessionId) {
    const o = await tx.paymentOrder.findUnique({ where: { providerSessionId: by.sessionId } });
    if (o) return o;
  }
  if (by.paymentIntent) return tx.paymentOrder.findUnique({ where: { providerPaymentIntent: by.paymentIntent } });
  return null;
}

async function handle(tx: Prisma.TransactionClient, ev: GatewayEvent): Promise<{ outcome: string; orderId?: string }> {
  switch (ev.type) {
    case "checkout.completed":
    case "checkout.async_succeeded": {
      const order = await findOrder(tx, { orderId: ev.orderId, sessionId: ev.sessionId });
      if (!order) return { outcome: "order-not-found" };
      // Pagamentos assíncronos (boleto, Pix) chegam como completed + unpaid; o crédito vem no async_succeeded.
      if (!ev.paid) {
        await tx.paymentOrder.update({ where: { id: order.id }, data: { providerSessionId: ev.sessionId, providerPaymentIntent: ev.paymentIntent ?? undefined } });
        return { outcome: "awaiting-payment", orderId: order.id };
      }
      // O valor cobrado precisa ser o valor do pedido (o preço vem do banco, não do navegador).
      if (ev.amountTotal !== null && (ev.amountTotal !== order.priceCents || (ev.currency ?? "").toUpperCase() !== order.currency.toUpperCase())) {
        await tx.paymentOrder.update({ where: { id: order.id }, data: { status: "FAILED" } });
        return { outcome: "amount-mismatch", orderId: order.id };
      }
      if (order.status === "PAID" || order.status === "REFUNDED" || order.status === "PARTIALLY_REFUNDED" || order.status === "DISPUTED") return { outcome: "already-paid", orderId: order.id };
      await tx.paymentOrder.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date(), providerSessionId: ev.sessionId, providerPaymentIntent: ev.paymentIntent ?? undefined } });
      await postLedger(tx, {
        userId: order.userId,
        amount: order.coins,
        type: "PURCHASE_CREDIT",
        idempotencyKey: `stripe:order:${order.id}`,
        description: `Compra de ${order.coins.toLocaleString("pt-BR")} VANTA COINS`,
        paymentOrderId: order.id,
      });
      return { outcome: "credited", orderId: order.id };
    }
    case "checkout.async_failed":
    case "checkout.expired": {
      const order = await findOrder(tx, { orderId: ev.orderId, sessionId: ev.sessionId });
      if (!order) return { outcome: "order-not-found" };
      if (order.status !== "PENDING") return { outcome: "ignored-not-pending", orderId: order.id };
      await tx.paymentOrder.update({ where: { id: order.id }, data: { status: ev.type === "checkout.expired" ? "EXPIRED" : "FAILED" } });
      return { outcome: ev.type === "checkout.expired" ? "expired" : "failed", orderId: order.id };
    }
    case "charge.refunded": {
      const order = await findOrder(tx, { paymentIntent: ev.paymentIntent });
      if (!order) return { outcome: "order-not-found" };
      if (ev.amountRefunded <= order.refundedCents) return { outcome: "refund-already-applied", orderId: order.id };
      // Moedas retiradas proporcionais ao novo valor estornado (cumulativo, sem arredondar a favor do jogador).
      const coinsTotal = Math.ceil((order.coins * ev.amountRefunded) / order.priceCents);
      const coinsBefore = Math.ceil((order.coins * order.refundedCents) / order.priceCents);
      const coins = Math.min(order.coins, coinsTotal) - coinsBefore;
      const status: PaymentStatus = ev.amountRefunded >= order.priceCents ? "REFUNDED" : "PARTIALLY_REFUNDED";
      await tx.paymentOrder.update({ where: { id: order.id }, data: { status, refundedCents: ev.amountRefunded } });
      if (coins > 0) {
        await postLedger(tx, {
          userId: order.userId,
          amount: -coins,
          type: "REFUND_DEBIT",
          idempotencyKey: `stripe:refund:${order.id}:${ev.amountRefunded}`,
          description: "Estorno de compra de VANTA COINS",
          paymentOrderId: order.id,
          clampToBalance: true,
        });
      }
      return { outcome: status === "REFUNDED" ? "refunded" : "partially-refunded", orderId: order.id };
    }
    case "charge.dispute_created": {
      const order = await findOrder(tx, { paymentIntent: ev.paymentIntent });
      if (!order) return { outcome: "order-not-found" };
      const remaining = order.coins - Math.ceil((order.coins * order.refundedCents) / order.priceCents);
      await tx.paymentOrder.update({ where: { id: order.id }, data: { status: "DISPUTED" } });
      if (remaining > 0) {
        await postLedger(tx, {
          userId: order.userId,
          amount: -remaining,
          type: "CHARGEBACK_DEBIT",
          idempotencyKey: `stripe:dispute:${order.id}`,
          description: "Contestação de pagamento (chargeback)",
          paymentOrderId: order.id,
          clampToBalance: true,
        });
      }
      return { outcome: "disputed", orderId: order.id };
    }
    case "charge.dispute_closed": {
      const order = await findOrder(tx, { paymentIntent: ev.paymentIntent });
      if (!order) return { outcome: "order-not-found" };
      if (!ev.won || order.status !== "DISPUTED") return { outcome: "dispute-closed", orderId: order.id };
      // Contestação vencida: devolve exatamente o que foi retirado.
      const debit = await tx.walletTransaction.findUnique({ where: { idempotencyKey: `stripe:dispute:${order.id}` } });
      await tx.paymentOrder.update({ where: { id: order.id }, data: { status: "PAID" } });
      if (debit && debit.amount < 0) {
        await postLedger(tx, { userId: order.userId, amount: -debit.amount, type: "ADMIN_ADJUSTMENT", idempotencyKey: `stripe:dispute-won:${order.id}`, description: "Contestação encerrada a seu favor", paymentOrderId: order.id });
      }
      return { outcome: "dispute-won", orderId: order.id };
    }
    case "ignored":
      return { outcome: "ignored" };
  }
}
