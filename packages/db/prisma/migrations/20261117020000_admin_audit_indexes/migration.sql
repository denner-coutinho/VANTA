-- Busca do painel administrativo por ação e por data.
-- (O registro já é somente inserção desde 20261114160800_integrity_constraints.)
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");
