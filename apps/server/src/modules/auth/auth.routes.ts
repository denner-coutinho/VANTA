import type { FastifyInstance, FastifyReply } from "fastify";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type AuthResponse,
} from "@vanta/shared";
import { Errors } from "../../lib/errors.js";
import { clientMeta } from "../../lib/request.js";
import { toPublicUser, type IssuedSession } from "./auth.service.js";

export const REFRESH_COOKIE = "vanta_rt";

export async function authRoutes(app: FastifyInstance) {
  const { authService, config } = app;
  // Limites por IP para rotas sensíveis (além do bloqueio por conta do LoginThrottle).
  const strict = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
  const medium = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  const cookieOpts = {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "strict" as const,
    path: config.REFRESH_COOKIE_PATH,
  };

  async function sendSession(reply: FastifyReply, s: IssuedSession, status = 200) {
    const accessToken = await reply.jwtSign({ sub: s.user.id, role: s.user.role, tv: s.user.tokenVersion }, { expiresIn: config.ACCESS_TOKEN_TTL_SECONDS });
    reply.setCookie(REFRESH_COOKIE, s.refreshToken, { ...cookieOpts, expires: s.refreshExpiresAt });
    const body: AuthResponse = { accessToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, user: toPublicUser(s.user) };
    return reply.status(status).send(body);
  }

  /**
   * Proteção CSRF para rotas que usam o cookie de refresh: além do SameSite=Strict,
   * exigimos um header customizado, que formulários de outros sites não conseguem enviar.
   */
  function assertCsrfHeader(headers: Record<string, unknown>) {
    if (headers["x-vanta-client"] !== "web") throw Errors.forbidden("Requisição recusada.");
  }

  app.post("/auth/register", strict, async (req, reply) => {
    const input = registerSchema.parse(req.body);
    return sendSession(reply, await authService.register(input, clientMeta(req)), 201);
  });

  app.post("/auth/login", strict, async (req, reply) => {
    const input = loginSchema.parse(req.body);
    return sendSession(reply, await authService.login(input, clientMeta(req)));
  });

  app.post("/auth/refresh", medium, async (req, reply) => {
    assertCsrfHeader(req.headers);
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw Errors.unauthorized("Sessão não encontrada.");
    try {
      return await sendSession(reply, await authService.refresh(token, clientMeta(req)));
    } catch (e) {
      reply.clearCookie(REFRESH_COOKIE, cookieOpts);
      throw e;
    }
  });

  app.post("/auth/logout", medium, async (req, reply) => {
    assertCsrfHeader(req.headers);
    await authService.logout(req.cookies[REFRESH_COOKIE]);
    reply.clearCookie(REFRESH_COOKIE, cookieOpts);
    return reply.status(204).send();
  });

  app.post("/auth/logout-all", { ...medium, preHandler: app.authenticate }, async (req, reply) => {
    await authService.logoutAll(req.auth.userId, clientMeta(req));
    reply.clearCookie(REFRESH_COOKIE, cookieOpts);
    return reply.status(204).send();
  });

  app.post("/auth/verify-email", medium, async (req, reply) => {
    const { token } = verifyEmailSchema.parse(req.body);
    await authService.verifyEmail(token);
    return reply.send({ ok: true });
  });

  app.post("/auth/resend-verification", { config: { rateLimit: { max: 3, timeWindow: "10 minutes" } }, preHandler: app.authenticate }, async (req, reply) => {
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: req.auth.userId } });
    if (user.emailVerifiedAt) throw Errors.badRequest("ALREADY_VERIFIED", "Seu e-mail já está verificado.");
    await authService.sendVerificationEmail(user);
    return reply.send({ ok: true });
  });

  app.post("/auth/forgot-password", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    await authService.forgotPassword(email, clientMeta(req));
    return reply.send({ ok: true, message: "Se existir uma conta com este e-mail, enviaremos um link de recuperação." });
  });

  app.post("/auth/reset-password", strict, async (req, reply) => {
    const { token, password } = resetPasswordSchema.parse(req.body);
    await authService.resetPassword(token, password, clientMeta(req));
    return reply.send({ ok: true });
  });
}
