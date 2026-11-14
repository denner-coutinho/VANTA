/**
 * Promove uma conta existente a administrador (ou superadmin). Uso:
 *   pnpm --filter @vanta/server create-admin <email> [ADMIN|SUPERADMIN|MODERATOR]
 * Não existe rota HTTP para isso de propósito: só quem tem acesso ao servidor pode promover.
 */
import { createPrismaClient } from "@vanta/db";

const [email, role = "ADMIN"] = process.argv.slice(2);
if (!email || !["ADMIN", "SUPERADMIN", "MODERATOR"].includes(role)) {
  console.error("Uso: create-admin <email> [ADMIN|SUPERADMIN|MODERATOR]");
  process.exit(1);
}
const prisma = createPrismaClient();
const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
if (!user) {
  console.error("Conta não encontrada. Crie a conta pelo jogo primeiro.");
  process.exit(1);
}
await prisma.$transaction([
  prisma.user.update({ where: { id: user.id }, data: { role: role as "ADMIN", tokenVersion: { increment: 1 } } }),
  prisma.adminAuditLog.create({ data: { actorId: user.id, action: "ROLE_GRANTED_CLI", targetType: "User", targetId: user.id, before: { role: user.role }, after: { role } } }),
]);
console.log(`${user.username} agora é ${role}.`);
await prisma.$disconnect();
