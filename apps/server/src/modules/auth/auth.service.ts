import type { PrismaClient, User } from "@vanta/db";
import { Prisma } from "@vanta/db";
import {
  MIN_ACCOUNT_AGE,
  ageFromBirthDate,
  type LoginInput,
  type PublicUser,
  type RegisterInput,
} from "@vanta/shared";
import type { AppConfig } from "../../config/env.js";
import { Errors } from "../../lib/errors.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import type { PasswordHasher } from "../../lib/password.js";
import type { Mailer } from "../mail/mailer.js";
import { passwordResetEmail, verificationEmail } from "../mail/templates.js";
import { LoginThrottle } from "./login-throttle.js";

/** Nomes que jogadores não podem usar (evita impersonação da equipe). */
const RESERVED_USERNAMES = new Set(["admin", "administrador", "moderador", "moderator", "vanta", "suporte", "support", "staff", "sistema", "system", "root", "gm"]);

const EMAIL_TOKEN_TTL_MS = 24 * 3600 * 1000;
const RESET_TOKEN_TTL_MS = 3600 * 1000;
/** Tempo em que o refresh token recém-rotacionado ainda é tolerado (abas concorrentes) sem ser tratado como roubo. */
const ROTATION_GRACE_MS = 30 * 1000;

export interface ClientMeta {
  ip: string;
  userAgent: string | null;
}

export interface IssuedSession {
  user: User;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    emailVerified: !!u.emailVerifiedAt,
    role: u.role,
    createdAt: u.createdAt.toISOString(),
  };
}

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly hasher: PasswordHasher,
    private readonly throttle: LoginThrottle,
    private readonly mailer: Mailer,
    private readonly config: AppConfig,
  ) {}

  // ───────────── Cadastro ─────────────

  async register(input: RegisterInput, meta: ClientMeta): Promise<IssuedSession> {
    const usernameLower = input.username.toLowerCase();
    if (RESERVED_USERNAMES.has(usernameLower) || usernameLower.includes("admin")) {
      throw Errors.conflict("USERNAME_UNAVAILABLE", "Este nome de jogador não está disponível.");
    }
    if (ageFromBirthDate(input.birthDate) < MIN_ACCOUNT_AGE) {
      throw Errors.badRequest("AGE_RESTRICTION", `É preciso ter pelo menos ${MIN_ACCOUNT_AGE} anos para criar uma conta.`);
    }
    if (ageFromBirthDate(input.birthDate) > 120) throw Errors.badRequest("VALIDATION_ERROR", "Data de nascimento inválida.");

    const passwordHash = await this.hasher.hash(input.password);
    let user: User;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            username: input.username,
            usernameLower,
            email: input.email,
            passwordHash,
            birthDate: new Date(`${input.birthDate}T00:00:00Z`),
            termsAcceptedAt: new Date(),
          },
        });
        const defaultCharacter = await tx.character.findFirst({ where: { isDefault: true, isActive: true } });
        await tx.userProfile.create({ data: { userId: created.id, displayName: input.username, mainCharacterId: defaultCharacter?.id } });
        await tx.wallet.create({ data: { userId: created.id } });
        await tx.securityEvent.create({ data: { userId: created.id, type: "REGISTER", ip: meta.ip, userAgent: meta.userAgent } });
        return created;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const target = String((e.meta as { target?: string[] | string })?.target ?? "");
        if (target.includes("usernameLower")) throw Errors.conflict("USERNAME_TAKEN", "Este nome de jogador já está em uso.");
        throw Errors.conflict("EMAIL_TAKEN", "Já existe uma conta com este e-mail.");
      }
      throw e;
    }

    await this.sendVerificationEmail(user);
    return this.createSession(user, meta);
  }

  // ───────────── Login ─────────────

  async login(input: LoginInput, meta: ClientMeta): Promise<IssuedSession> {
    const identifier = input.identifier.trim().toLowerCase();
    const user = identifier.includes("@")
      ? await this.prisma.user.findUnique({ where: { email: identifier } })
      : await this.prisma.user.findUnique({ where: { usernameLower: identifier } });

    // Contadores por ID do usuário: e-mail e username da mesma conta compartilham o limite.
    const throttleKey = user?.id ?? `unknown:${identifier}`;
    const locked = await this.throttle.lockedFor(throttleKey, meta.ip);
    if (locked > 0) {
      await this.logSecurity(user?.id ?? null, "LOGIN_BLOCKED_THROTTLE", meta);
      throw Errors.tooMany(`Muitas tentativas de login. Tente novamente em ${Math.ceil(locked / 60)} minuto(s).`, locked);
    }

    const ok = user ? await this.hasher.verify(user.passwordHash, input.password) : (await this.hasher.verifyDummy(input.password), false);
    if (!user || !ok) {
      await this.throttle.registerFailure(throttleKey, meta.ip);
      await this.logSecurity(user?.id ?? null, "LOGIN_FAILED", meta, user ? undefined : { identifier });
      throw Errors.unauthorized("E-mail, nome de jogador ou senha incorretos.");
    }

    await this.assertAccountUsable(user);
    await this.throttle.registerSuccess(throttleKey, meta.ip);
    const updated = await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), lastSeenAt: new Date() } });
    await this.logSecurity(user.id, "LOGIN_SUCCESS", meta);
    return this.createSession(updated, meta);
  }

  /** Conta banida/suspensa não pode entrar. Suspensões expiradas são liberadas automaticamente. */
  async assertAccountUsable(user: User): Promise<void> {
    if (user.status === "ACTIVE") return;
    if (user.status === "DELETED") throw Errors.unauthorized("E-mail, nome de jogador ou senha incorretos.");
    const ban = await this.prisma.ban.findFirst({
      where: { userId: user.id, type: { in: ["SUSPENSION", "PERMANENT"] }, revokedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
      orderBy: { endsAt: { sort: "desc", nulls: "first" } },
    });
    if (!ban && user.status === "SUSPENDED") {
      await this.prisma.user.update({ where: { id: user.id }, data: { status: "ACTIVE" } });
      return;
    }
    if (user.status === "BANNED" || ban?.type === "PERMANENT") {
      throw Errors.forbidden(`Esta conta foi banida permanentemente.${ban ? ` Motivo: ${ban.reason}` : ""}`);
    }
    const until = ban?.endsAt ? ban.endsAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "";
    throw Errors.forbidden(`Esta conta está suspensa${until ? ` até ${until}` : ""}.${ban ? ` Motivo: ${ban.reason}` : ""}`);
  }

  // ───────────── Sessões e refresh tokens ─────────────

  private async createSession(user: User, meta: ClientMeta, familyId?: string): Promise<IssuedSession> {
    const refreshToken = randomToken(32);
    const refreshExpiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86400 * 1000);
    await this.prisma.authSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: sha256(refreshToken),
        familyId: familyId ?? randomToken(16),
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: refreshExpiresAt,
      },
    });
    return { user, refreshToken, refreshExpiresAt };
  }

  /**
   * Rotação de refresh token: cada uso gera um novo token e invalida o anterior.
   * Se um token já rotacionado for reapresentado (fora da tolerância), consideramos
   * que foi roubado e revogamos toda a família de sessões.
   */
  async refresh(refreshToken: string, meta: ClientMeta): Promise<IssuedSession> {
    const session = await this.prisma.authSession.findUnique({ where: { refreshTokenHash: sha256(refreshToken) }, include: { user: true } });
    if (!session) throw Errors.unauthorized("Sessão inválida. Faça login novamente.");

    if (session.revokedAt) {
      // Só um token já ROTACIONADO indica roubo; tokens encerrados por logout/reuso apenas falham.
      const isStolenRotated = session.revokedReason === "ROTATED" && Date.now() - session.revokedAt.getTime() >= ROTATION_GRACE_MS;
      if (isStolenRotated) {
        await this.prisma.authSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "REUSE_DETECTED" } });
        await this.logSecurity(session.userId, "REFRESH_TOKEN_REUSE", meta, { familyId: session.familyId });
      }
      throw Errors.unauthorized("Sessão inválida. Faça login novamente.");
    }
    if (session.expiresAt < new Date()) throw Errors.unauthorized("Sessão expirada. Faça login novamente.");
    await this.assertAccountUsable(session.user);

    // Revogação condicional: se duas requisições chegarem juntas, só uma vence.
    const { count } = await this.prisma.authSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "ROTATED", lastUsedAt: new Date() },
    });
    if (count === 0) throw Errors.unauthorized("Sessão inválida. Faça login novamente.");

    const next = await this.createSession(session.user, meta, session.familyId);
    await this.prisma.user.update({ where: { id: session.userId }, data: { lastSeenAt: new Date() } });
    return next;
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.prisma.authSession.updateMany({ where: { refreshTokenHash: sha256(refreshToken), revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "LOGOUT" } });
  }

  /** Encerra todas as sessões e invalida tokens de acesso já emitidos. */
  async logoutAll(userId: string, meta: ClientMeta): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "LOGOUT_ALL" } }),
      this.prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
    ]);
    await this.logSecurity(userId, "LOGOUT_ALL", meta);
  }

  // ───────────── Verificação de e-mail ─────────────

  async sendVerificationEmail(user: User): Promise<void> {
    if (user.emailVerifiedAt) return;
    const token = randomToken(32);
    await this.prisma.emailVerificationToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS) } });
    const url = `${this.config.PUBLIC_APP_URL}/verificar-email?token=${encodeURIComponent(token)}`;
    await this.mailer.send(verificationEmail(user.email, user.username, url));
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.prisma.emailVerificationToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw Errors.badRequest("INVALID_TOKEN", "Link de verificação inválido ou expirado.");
    }
    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.updateMany({ where: { userId: record.userId, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
    ]);
  }

  // ───────────── Recuperação de senha ─────────────

  /** Sempre responde igual, exista ou não a conta (evita enumeração de e-mails). */
  async forgotPassword(email: string, meta: ClientMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status === "DELETED") return;
    const token = randomToken(32);
    await this.prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS), ip: meta.ip } });
    const url = `${this.config.PUBLIC_APP_URL}/redefinir-senha?token=${encodeURIComponent(token)}`;
    await this.mailer.send(passwordResetEmail(user.email, user.username, url));
    await this.logSecurity(user.id, "PASSWORD_RESET_REQUESTED", meta);
  }

  async resetPassword(token: string, newPassword: string, meta: ClientMeta): Promise<void> {
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw Errors.badRequest("INVALID_TOKEN", "Link de redefinição inválido ou expirado.");
    }
    const passwordHash = await this.hasher.hash(newPassword);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.updateMany({ where: { userId: record.userId, usedAt: null }, data: { usedAt: now } }),
      // Quem recebeu o link no e-mail comprovou posse do endereço.
      this.prisma.user.update({ where: { id: record.userId }, data: { passwordHash, tokenVersion: { increment: 1 }, emailVerifiedAt: now } }),
      this.prisma.authSession.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: now, revokedReason: "PASSWORD_RESET" } }),
    ]);
    await this.logSecurity(record.userId, "PASSWORD_RESET_COMPLETED", meta);
  }

  private async logSecurity(userId: string | null, type: string, meta: ClientMeta, extra?: Record<string, unknown>) {
    await this.prisma.securityEvent.create({ data: { userId, type, ip: meta.ip, userAgent: meta.userAgent, meta: extra as Prisma.InputJsonValue | undefined } });
  }
}
