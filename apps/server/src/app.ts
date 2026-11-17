import fp from "fastify-plugin";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import { createPrismaClient, type PrismaClient } from "@vanta/db";
import type { AppConfig } from "./config/env.js";
import { errorHandler, Errors } from "./lib/errors.js";
import { PasswordHasher } from "./lib/password.js";
import { authPlugin } from "./plugins/auth.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { LoginThrottle } from "./modules/auth/login-throttle.js";
import { MfaService } from "./modules/auth/mfa.service.js";
import { SecretBox } from "./lib/totp.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { LogMailer, SmtpMailer, type Mailer } from "./modules/mail/mailer.js";
import { meRoutes } from "./modules/users/me.routes.js";
import { contentRoutes } from "./modules/content/content.routes.js";
import { rankedRoutes } from "./modules/ranked/ranked.routes.js";
import { economyRoutes } from "./modules/economy/economy.routes.js";
import { StripeGateway, type PaymentGateway } from "./modules/economy/payments.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { metricsRoutes } from "./modules/health/metrics.routes.js";
import { RedisSocialBus, type SocialBus } from "./modules/social/bus.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";
import { SocialService } from "./modules/social/social.service.js";
import { progressionRoutes } from "./modules/progression/progression.routes.js";
import { socialRoutes } from "./modules/social/social.routes.js";
import { clanRoutes } from "./modules/clans/clans.routes.js";
import { playerRoutes } from "./modules/players/players.routes.js";
import { matchRoutes } from "./modules/matches/matches.routes.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    prisma: PrismaClient;
    redis: Redis;
    authService: AuthService;
    mfaService: MfaService;
    socialBus: SocialBus;
  }
}

export interface AppDeps {
  prisma?: PrismaClient;
  redis?: Redis;
  mailer?: Mailer;
  /** Gateway de pagamento (testes injetam um com cliente Stripe falso). null = pagamentos desativados. */
  payments?: PaymentGateway | null;
  /** Barramento social (testes usam o de memória, compartilhado com o servidor de jogo). */
  socialBus?: SocialBus;
  logger?: boolean | object;
}

export async function buildApp(config: AppConfig, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      deps.logger ??
      (config.isProd
        ? { level: "info", redact: ["req.headers.authorization", "req.headers.cookie"] }
        : { level: "info", transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } }, redact: ["req.headers.authorization", "req.headers.cookie"] }),
    // Número = quantos proxies na frente são confiáveis (o IP real é o primeiro antes deles).
    trustProxy: typeof config.TRUST_PROXY === "number" ? (_addr: string, hop: number) => hop < (config.TRUST_PROXY as number) : config.TRUST_PROXY,
    bodyLimit: 64 * 1024,
  });

  const prisma = deps.prisma ?? createPrismaClient(config.DATABASE_URL);
  const redis = deps.redis ?? new Redis(config.REDIS_URL, { keyPrefix: config.REDIS_KEY_PREFIX, maxRetriesPerRequest: 2 });
  const mailer =
    deps.mailer ??
    (config.SMTP_HOST
      ? new SmtpMailer({ host: config.SMTP_HOST, port: config.SMTP_PORT, user: config.SMTP_USER, pass: config.SMTP_PASS, from: config.MAIL_FROM })
      : new LogMailer(app.log));
  if (config.isProd && !config.SMTP_HOST) throw new Error("SMTP_HOST é obrigatório em produção.");

  app.decorate("config", config);
  app.decorate("prisma", prisma);
  app.decorate("redis", redis);
  const socialBus = deps.socialBus ?? new RedisSocialBus(config.REDIS_URL, `${config.REDIS_KEY_PREFIX}social`);
  app.decorate("socialBus", socialBus);
  const hasher = new PasswordHasher(config.ARGON2_MEMORY_KIB);
  const throttle = new LoginThrottle(redis);
  app.decorate("authService", new AuthService(prisma, hasher, throttle, mailer, config));
  // Sem chave própria (só desenvolvimento e testes), deriva do segredo do JWT; produção exige a chave.
  app.decorate("mfaService", new MfaService(prisma, redis, hasher, throttle, new SecretBox(config.MFA_ENCRYPTION_KEY || `dev-mfa:${config.JWT_ACCESS_SECRET}`)));

  app.addHook("onClose", async () => {
    if (!deps.prisma) await prisma.$disconnect();
    if (!deps.redis) redis.disconnect();
    if (!deps.socialBus) await socialBus.close();
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "NOT_FOUND", message: "Rota não encontrada." } }));

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } });
  await app.register(cors, {
    origin: (origin, cb) => {
      // Requisições sem Origin (curl, servidor-servidor) são aceitas; navegadores precisam estar na lista.
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      cb(Errors.forbidden("Origem não permitida."), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Vanta-Client", "Idempotency-Key"],
  });
  await app.register(cookie);
  await app.register(jwt, { secret: config.JWT_ACCESS_SECRET, sign: { algorithm: "HS256" }, verify: { algorithms: ["HS256"] } });
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_PER_MIN,
    timeWindow: "1 minute",
    redis,
    nameSpace: "rl:",
    skipOnError: false,
    errorResponseBuilder: (_req, ctx) => {
      const err = Errors.tooMany("Muitas requisições. Aguarde um pouco e tente novamente.", Math.ceil(ctx.ttl / 1000));
      return Object.assign(err, { statusCode: 429 });
    },
  });
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(fp(metricsRoutes));
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(contentRoutes);
  await app.register(rankedRoutes);
  const payments = deps.payments !== undefined ? deps.payments : config.STRIPE_SECRET_KEY ? new StripeGateway(config.STRIPE_SECRET_KEY, config.STRIPE_WEBHOOK_SECRET) : null;
  if (!payments) app.log.warn("Stripe não configurada: compra de VANTA COINS desativada.");
  await app.register(economyRoutes, { payments });
  await app.register(progressionRoutes);
  await app.register(clanRoutes);
  await app.register(playerRoutes);
  await app.register(matchRoutes);
  await app.register(socialRoutes, { social: new SocialService(prisma, socialBus) });
  await app.register(adminRoutes, { bus: socialBus });

  return app;
}
