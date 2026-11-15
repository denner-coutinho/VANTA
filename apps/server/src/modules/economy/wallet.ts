import type { Prisma, PrismaClient, WalletTxType } from "@vanta/db";
import { Errors } from "../../lib/errors.js";

type Tx = Prisma.TransactionClient | PrismaClient;

export interface LedgerEntry {
  userId: string;
  /** Positivo = crédito, negativo = débito. Nunca zero. */
  amount: number;
  type: WalletTxType;
  /** Mesma chave = mesmo lançamento: repetir a operação não credita/debita de novo. */
  idempotencyKey: string;
  description: string;
  paymentOrderId?: string | null;
  meta?: Prisma.InputJsonValue;
  /**
   * Débitos externos (estorno, chargeback) não podem ser recusados: se faltar saldo,
   * debita até zerar e registra o que faltou em `meta.shortfall`. Débitos da loja nunca usam isso.
   */
  clampToBalance?: boolean;
}

export interface LedgerResult {
  transactionId: string;
  balanceAfter: number;
  /** false quando a chave de idempotência já existia (nada foi alterado). */
  applied: boolean;
  amount: number;
}

/**
 * Único ponto que altera saldo de VANTA COINS.
 * - Razão somente-inserção (`WalletTransaction`); `Wallet.balance` é o cache da soma.
 * - Bloqueio otimista pela `version`: duas operações simultâneas nunca leem o mesmo saldo.
 * - Saldo nunca fica negativo.
 * Deve rodar dentro de uma transação do Prisma junto com o efeito (item, pedido) que justifica o lançamento.
 */
export async function postLedger(tx: Tx, e: LedgerEntry): Promise<LedgerResult> {
  if (!Number.isInteger(e.amount) || e.amount === 0) throw new Error("Lançamento inválido: valor precisa ser inteiro diferente de zero.");
  const existing = await tx.walletTransaction.findUnique({ where: { idempotencyKey: e.idempotencyKey } });
  if (existing) {
    if (existing.walletUserId !== e.userId) throw Errors.conflict("IDEMPOTENCY_CONFLICT", "Chave de operação já usada.");
    return { transactionId: existing.id, balanceAfter: existing.balanceAfter, applied: false, amount: existing.amount };
  }

  const wallet = await tx.wallet.upsert({ where: { userId: e.userId }, update: {}, create: { userId: e.userId } });
  let amount = e.amount;
  let meta = e.meta;
  if (wallet.balance + amount < 0) {
    if (!e.clampToBalance) throw Errors.conflict("INSUFFICIENT_FUNDS", "Saldo de VANTA COINS insuficiente.");
    const shortfall = -(wallet.balance + amount);
    amount = -wallet.balance;
    meta = { ...((e.meta as object | undefined) ?? {}), shortfall };
  }
  const balanceAfter = wallet.balance + amount;

  const updated = await tx.wallet.updateMany({ where: { userId: e.userId, version: wallet.version }, data: { balance: balanceAfter, version: { increment: 1 } } });
  if (updated.count !== 1) throw Errors.conflict("WALLET_BUSY", "Outra operação alterou a carteira ao mesmo tempo. Tente novamente.");

  const row = await tx.walletTransaction.create({
    data: { walletUserId: e.userId, type: e.type, amount, balanceAfter, idempotencyKey: e.idempotencyKey, description: e.description, paymentOrderId: e.paymentOrderId ?? null, meta: meta ?? undefined },
  });
  return { transactionId: row.id, balanceAfter, applied: true, amount };
}

/** Confere que o cache bate com a soma do razão (usado em testes e na auditoria). */
export async function ledgerSum(tx: Tx, userId: string) {
  const agg = await tx.walletTransaction.aggregate({ where: { walletUserId: userId }, _sum: { amount: true } });
  return agg._sum.amount ?? 0;
}
