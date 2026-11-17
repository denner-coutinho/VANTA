import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { roleRequiresMfa, type UserRole } from "@vanta/shared";
import { AppError, Errors } from "../lib/errors.js";

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  /** Versão de token do usuário: incrementada em troca de senha / logout global. */
  tv: number;
  /** Sessão aberta com a segunda etapa (código do app ou de recuperação). */
  mfa?: boolean;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: UserRole[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Cargo da equipe sem a segunda etapa nesta sessão: 403 MFA_REQUIRED. */
    assertStaffMfa: (req: FastifyRequest) => void;
  }
  interface FastifyRequest {
    auth: { userId: string; role: UserRole; mfa: boolean };
  }
}

const ROLE_RANK: Record<UserRole, number> = { PLAYER: 0, MODERATOR: 1, ADMIN: 2, SUPERADMIN: 3 };

/**
 * Autenticação por token de acesso (JWT HS256, curto) no header Authorization.
 * A cada requisição o servidor confere no banco: conta ativa, tokenVersion e papel atual.
 * Assim um banimento ou troca de senha tem efeito imediato, sem esperar o token expirar.
 */
export const authPlugin = fp(async (app) => {
  app.decorateRequest("auth", null as unknown as FastifyRequest["auth"]);

  app.decorate("authenticate", async (req: FastifyRequest) => {
    let payload: AccessTokenPayload;
    try {
      payload = await req.jwtVerify<AccessTokenPayload>();
    } catch {
      throw Errors.unauthorized("Sessão expirada ou inválida.");
    }
    const user = await app.prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, role: true, status: true, tokenVersion: true, totpEnabledAt: true } });
    if (!user || user.tokenVersion !== payload.tv || (user.status !== "ACTIVE")) {
      throw Errors.unauthorized("Sessão expirada ou inválida.");
    }
    req.auth = { userId: user.id, role: user.role, mfa: payload.mfa === true && !!user.totpEnabledAt };
  });

  app.decorate("assertStaffMfa", (req: FastifyRequest) => {
    if (roleRequiresMfa(req.auth.role) && !req.auth.mfa) {
      throw new AppError(403, "MFA_REQUIRED", "O painel da equipe exige a verificação em duas etapas. Ligue em Perfil › Verificação em duas etapas (tela Segurança) e entre de novo com o código.");
    }
  });

  app.decorate("requireRole", (...roles: UserRole[]) => {
    const min = Math.min(...roles.map((r) => ROLE_RANK[r]));
    return async (req: FastifyRequest, reply: FastifyReply) => {
      await app.authenticate(req, reply);
      if (ROLE_RANK[req.auth.role] < min) throw Errors.forbidden();
      app.assertStaffMfa(req);
    };
  });
});
