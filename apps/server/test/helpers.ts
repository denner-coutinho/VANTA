import { totp, totpStep } from "../src/lib/totp.js";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { createPrismaClient, type PrismaClient } from "@vanta/db";
import { buildApp, type AppDeps } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryMailer } from "../src/modules/mail/mailer.js";
import { MemorySocialBus } from "../src/modules/social/bus.js";

export interface TestContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  redis: Redis;
  mailer: MemoryMailer;
  bus: MemorySocialBus;
}

const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://vanta:vanta@localhost:5432/vanta_test?schema=public";

export async function createTestContext(deps: Pick<AppDeps, "payments"> = {}): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DB,
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    REDIS_KEY_PREFIX: "vanta-test:",
    JWT_ACCESS_SECRET: "segredo-de-teste-com-mais-de-32-caracteres-ok",
    ARGON2_MEMORY_KIB: "4096",
    PUBLIC_APP_URL: "http://localhost:5173",
  });
  const prisma = createPrismaClient(TEST_DB);
  const redis = new Redis(config.REDIS_URL, { keyPrefix: config.REDIS_KEY_PREFIX });
  const mailer = new MemoryMailer();
  const bus = new MemorySocialBus();
  const app = await buildApp(config, { prisma, redis, mailer, logger: false, payments: deps.payments ?? null, socialBus: bus });
  await app.ready();
  return { app, prisma, redis, mailer, bus };
}

/** Limpa dados de jogadores (mantém o conteúdo do seed) e o Redis de testes. */
export async function resetState(ctx: TestContext) {
  await ctx.prisma.$executeRawUnsafe(
    `TRUNCATE "User","AuthSession","EmailVerificationToken","PasswordResetToken","SecurityEvent","UserProfile","Wallet","WalletTransaction","Ban","AdminAuditLog","Inventory","RankedRating","PaymentOrder","PaymentWebhookEvent","Friend","FriendRequest","UserBlock","UserMute","Report","Notification" RESTART IDENTITY CASCADE`,
  );
  const keys = await ctx.redis.keys("vanta-test:*");
  if (keys.length) await ctx.redis.del(...keys.map((k) => k.replace(/^vanta-test:/, "")));
}

export async function closeTestContext(ctx: TestContext) {
  await ctx.app.close();
  await ctx.prisma.$disconnect();
  ctx.redis.disconnect();
}

let counter = 0;
export function newPlayer(overrides: Record<string, unknown> = {}) {
  counter++;
  return {
    username: `Operador${counter}`,
    email: `operador${counter}@teste.vanta`,
    password: "SenhaForte123",
    birthDate: "2000-05-10",
    acceptTerms: true,
    ...overrides,
  };
}

export function getRefreshCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === "vanta_rt")?.value;
}

export function tokenFromMail(text: string): string {
  const m = text.match(/token=([A-Za-z0-9_%-]+)/);
  if (!m) throw new Error("token não encontrado no e-mail");
  return decodeURIComponent(m[1]!);
}

/**
 * Liga a verificação em duas etapas pela API de verdade (como um app autenticador faria) e devolve o
 * token novo, já com a segunda etapa. Usado para cargos da equipe, que só entram no painel assim.
 */
export async function enableMfa(ctx: TestContext, token: string, password = "SenhaForte123") {
  const h = { authorization: `Bearer ${token}` };
  const setup = await ctx.app.inject({ method: "POST", url: "/auth/mfa/setup", headers: h, payload: { password } });
  if (setup.statusCode !== 200) throw new Error(`setup ${setup.statusCode} ${setup.body}`);
  const secret = setup.json().secret as string;
  const res = await ctx.app.inject({ method: "POST", url: "/auth/mfa/enable", headers: h, payload: { code: totp(secret) } });
  if (res.statusCode !== 200) throw new Error(`enable ${res.statusCode} ${res.body}`);
  const j = res.json();
  return { token: j.accessToken as string, secret, recoveryCodes: j.recoveryCodes as string[] };
}

/** Código válido ainda não usado: libera o passo atual (o servidor recusa repetir o mesmo passo). */
export async function freshTotp(ctx: TestContext, userId: string, secret: string) {
  await ctx.prisma.user.update({ where: { id: userId }, data: { totpLastStep: totpStep() - 2 } });
  return totp(secret);
}
