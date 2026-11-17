import type { FastifyInstance, FastifyReply } from "fastify";
import {
  forgotPasswordSchema,
  loginMfaSchema,
  loginSchema,
  mfaDisableSchema,
  mfaEnableSchema,
  mfaRegenerateSchema,
  mfaSetupSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type AuthResponse,
  type MfaChallengeResponse,
  type MfaCodesResponse,
  type MfaEnableResponse,
} from "@vanta/shared";
import { MFA_CHALLENGE_TTL_SEC } from "./mfa.service.js";
import { Errors } from "../../lib/errors.js";
import { clientMeta } from "../../lib/request.js";
import { toPublicUser, type IssuedSession } from "./auth.service.js";

export const REFRESH_COOKIE = "vanta_rt";

export async function authRoutes(app: FastifyInstance) {
  const { authService, mfaService, config } = app;
  // Limites por IP para rotas sensíveis (além do bloqueio por conta do LoginThrottle).
  const strict = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
  const medium = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  const cookieOpts = {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "strict" as const,
    path: config.REFRESH_COOKIE_PATH,
  };

  async function sessionBody(reply: FastifyReply, s: IssuedSession): Promise<AuthResponse> {
    const accessToken = await reply.jwtSign({ sub: s.user.id, role: s.user.role, tv: s.user.tokenVersion, ...(s.mfa ? { mfa: true } : {}) }, { expiresIn: config.ACCESS_TOKEN_TTL_SECONDS });
    reply.setCookie(REFRESH_COOKIE, s.refreshToken, { ...cookieOpts, expires: s.refreshExpiresAt });
    return { accessToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, user: toPublicUser(s.user) };
  }
  async function sendSession(reply: FastifyReply, s: IssuedSession, status = 200) {
    return reply.status(status).send(await sessionBody(reply, s));
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
    const out = await authService.login(input, clientMeta(req));
    if (out.kind === "session") return sendSession(reply, out.session);
    const body: MfaChallengeResponse = { mfaRequired: true, mfaToken: await mfaService.createChallenge(out.user), expiresIn: MFA_CHALLENGE_TTL_SEC };
    return reply.send(body);
  });

  /** Segunda etapa do login: código do app autenticador ou um código de recuperação. */
  app.post("/auth/login/mfa", strict, async (req, reply) => {
    const { mfaToken, code } = loginMfaSchema.parse(req.body);
    const meta = clientMeta(req);
    const user = await mfaService.completeChallenge(mfaToken, code, meta);
    return sendSession(reply, await authService.finishLogin(user, meta, true));
  });

  // ───────── Verificação em duas etapas da própria conta ─────────

  app.get("/auth/mfa", { preHandler: app.authenticate }, async (req) => mfaService.status(req.auth.userId, req.auth.role, req.auth.mfa));

  app.post("/auth/mfa/setup", { ...strict, preHandler: app.authenticate }, async (req) => {
    const { password } = mfaSetupSchema.parse(req.body);
    return mfaService.beginSetup(req.auth.userId, password, clientMeta(req));
  });

  /** Liga a verificação, encerra as outras sessões e devolve esta já com a segunda etapa. */
  app.post("/auth/mfa/enable", { ...strict, preHandler: app.authenticate }, async (req, reply) => {
    const { code } = mfaEnableSchema.parse(req.body);
    const meta = clientMeta(req);
    const { user, recoveryCodes } = await mfaService.enable(req.auth.userId, code, meta);
    const body: MfaEnableResponse = { ...(await sessionBody(reply, await authService.createSession(user, meta, undefined, true))), recoveryCodes };
    return reply.send(body);
  });

  app.post("/auth/mfa/disable", { ...strict, preHandler: app.authenticate }, async (req, reply) => {
    const { password, code } = mfaDisableSchema.parse(req.body);
    const meta = clientMeta(req);
    const user = await mfaService.disable(req.auth.userId, password, code, meta);
    return sendSession(reply, await authService.createSession(user, meta));
  });

  app.post("/auth/mfa/recovery-codes", { ...strict, preHandler: app.authenticate }, async (req): Promise<MfaCodesResponse> => {
    const { code } = mfaRegenerateSchema.parse(req.body);
    return { recoveryCodes: await mfaService.regenerateCodes(req.auth.userId, code, clientMeta(req)) };
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
