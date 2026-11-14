-- Regras de integridade que o Prisma não expressa no schema.

-- Saldo de VANTA COINS nunca pode ficar negativo.
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balance_non_negative" CHECK ("balance" >= 0);
-- Lançamentos nunca têm valor zero e o saldo resultante nunca é negativo.
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_amount_non_zero" CHECK ("amount" <> 0);
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_balance_after_non_negative" CHECK ("balanceAfter" >= 0);
-- Preços e pacotes positivos.
ALTER TABLE "CoinPackage" ADD CONSTRAINT "CoinPackage_positive" CHECK ("coins" > 0 AND "priceCents" > 0 AND "bonusCoins" >= 0);
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_positive" CHECK ("coins" > 0 AND "priceCents" > 0 AND "refundedCents" >= 0 AND "refundedCents" <= "priceCents");
ALTER TABLE "StoreItem" ADD CONSTRAINT "StoreItem_price_positive" CHECK ("priceVc" IS NULL OR "priceVc" > 0);
-- Amizade armazenada uma vez por par, em ordem.
ALTER TABLE "Friend" ADD CONSTRAINT "Friend_ordered_pair" CHECK ("userAId" < "userBId");
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_not_self" CHECK ("blockerId" <> "blockedId");
ALTER TABLE "FriendRequest" ADD CONSTRAINT "FriendRequest_not_self" CHECK ("fromId" <> "toId");
-- No máximo um pedido de amizade pendente por direção.
CREATE UNIQUE INDEX "FriendRequest_one_pending" ON "FriendRequest" ("fromId", "toId") WHERE "status" = 'PENDING';
-- Apenas uma temporada ativa por vez.
CREATE UNIQUE INDEX "RankedSeason_single_active" ON "RankedSeason" ("isActive") WHERE "isActive" = true;
-- Tabelas de auditoria e razão contábil são somente-inserção.
CREATE OR REPLACE FUNCTION vanta_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Tabela % é somente-inserção', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "WalletTransaction_append_only" BEFORE UPDATE OR DELETE ON "WalletTransaction" FOR EACH ROW EXECUTE FUNCTION vanta_forbid_mutation();
CREATE TRIGGER "AdminAuditLog_append_only" BEFORE UPDATE OR DELETE ON "AdminAuditLog" FOR EACH ROW EXECUTE FUNCTION vanta_forbid_mutation();
