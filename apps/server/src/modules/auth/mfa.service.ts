import type { PrismaClient, User } from "@vanta/db";
import type { Redis } from "ioredis";
import QRCode from "qrcode";
import type { MfaSetupResponse, MfaStatus, UserRole } from "@vanta/shared";
import { roleRequiresMfa } from "@vanta/shared";
import { Errors } from "../../lib/errors.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import type { PasswordHasher } from "../../lib/password.js";
import { SecretBox, newRecoveryCode, newTotpSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from "../../lib/totp.js";
import type { LoginThrottle } from "./login-throttle.js";
import type { ClientMeta } from "./auth.service.js";

/** Tempo para digitar o código depois da senha, e tentativas por desafio. */
export const MFA_CHALLENGE_TTL_SEC = 5 * 60;
export const MFA_CHALLENGE_ATTEMPTS = 5;
/** Cadastro iniciado e não confirmado expira. */
const PENDING_TTL_MS = 15 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;

/**
 * Verificação em duas etapas (TOTP + códigos de recuperação).
 * Regras: o segredo fica cifrado no banco; o mesmo código não vale duas vezes; erros de código
 * contam no mesmo bloqueio do login por senha; ligar, desligar ou trocar os códigos encerra as outras sessões.
 */
export class MfaService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly hasher: PasswordHasher,
    private readonly throttle: LoginThrottle,
    private readonly box: SecretBox,
  ) {}

  private chKey(token: string) {
    return `mfa:ch:${sha256(token)}`;
  }

  async status(userId: string, role: UserRole, sessionVerified: boolean): Promise<MfaStatus> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { totpEnabledAt: true } });
    const left = u.totpEnabledAt ? await this.prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } }) : 0;
    return { enabled: !!u.totpEnabledAt, enabledAt: u.totpEnabledAt?.toISOString() ?? null, required: roleRequiresMfa(role), sessionVerified: sessionVerified && !!u.totpEnabledAt, recoveryCodesLeft: left };
  }

  // ───────── Cadastro do app ─────────

  /** Pede a senha de novo (quem pegou uma sessão aberta não liga a verificação no lugar do dono). */
  async beginSetup(userId: string, password: string, meta: ClientMeta): Promise<MfaSetupResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt) throw Errors.conflict("MFA_ALREADY_ENABLED", "A verificação em duas etapas já está ligada.");
    await this.checkPassword(user, password, meta);
    const secret = newTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totpPendingEnc: this.box.seal(secret), totpPendingAt: new Date() } });
    const url = otpauthUrl(secret, user.username);
    const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
    return { secret, otpauthUrl: url, qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
  }

  /** Confirma com um código do app. Devolve os códigos de recuperação (só agora, em texto). */
  async enable(userId: string, code: string, meta: ClientMeta): Promise<{ user: User; recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt) throw Errors.conflict("MFA_ALREADY_ENABLED", "A verificação em duas etapas já está ligada.");
    if (!user.totpPendingEnc || !user.totpPendingAt || Date.now() - user.totpPendingAt.getTime() > PENDING_TTL_MS) {
      throw Errors.badRequest("MFA_SETUP_EXPIRED", "Comece o cadastro do app de novo (o QR code expirou).");
    }
    const secret = this.box.open(user.totpPendingEnc);
    const step = verifyTotp(secret, code);
    if (step === null) {
      await this.log(userId, "MFA_ENABLE_FAILED", meta);
      throw Errors.badRequest("MFA_INVALID_CODE", "Código incorreto. Confira o horário do celular e tente o código atual.");
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const now = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { totpSecretEnc: user.totpPendingEnc, totpEnabledAt: now, totpLastStep: step, totpPendingEnc: null, totpPendingAt: null, tokenVersion: { increment: 1 } },
      }),
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha256(normalizeRecoveryCode(c)) })) }),
      this.prisma.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason: "MFA_ENABLED" } }),
    ]);
    await this.log(userId, "MFA_ENABLED", meta);
    return { user: updated, recoveryCodes: codes };
  }

  async disable(userId: string, password: string, code: string, meta: ClientMeta): Promise<User> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpEnabledAt) throw Errors.badRequest("MFA_NOT_ENABLED", "A verificação em duas etapas não está ligada.");
    await this.checkPassword(user, password, meta);
    await this.checkCode(user, code, meta);
    const now = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, totpPendingEnc: null, totpPendingAt: null, tokenVersion: { increment: 1 } } }),
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason: "MFA_DISABLED" } }),
    ]);
    await this.log(userId, "MFA_DISABLED", meta);
    return updated;
  }

  async regenerateCodes(userId: string, code: string, meta: ClientMeta): Promise<string[]> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpEnabledAt) throw Errors.badRequest("MFA_NOT_ENABLED", "A verificação em duas etapas não está ligada.");
    await this.checkCode(user, code, meta, { allowRecovery: false });
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await this.prisma.$transaction([
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha256(normalizeRecoveryCode(c)) })) }),
    ]);
    await this.log(userId, "MFA_RECOVERY_REGENERATED", meta);
    return codes;
  }

  // ───────── Login em duas etapas ─────────

  /** Senha certa numa conta com a verificação ligada: devolve um desafio de uso único. */
  async createChallenge(user: User): Promise<string> {
    const token = randomToken(32);
    const key = this.chKey(token);
    await this.redis.multi().hset(key, { uid: user.id, tv: String(user.tokenVersion), att: "0" }).expire(key, MFA_CHALLENGE_TTL_SEC).exec();
    return token;
  }

  /** Confere o código do desafio. Devolve o usuário para abrir a sessão (já com a segunda etapa). */
  async completeChallenge(token: string, code: string, meta: ClientMeta): Promise<User> {
    const key = this.chKey(token);
    const ch = await this.redis.hgetall(key);
    const expired = () => Errors.unauthorized("O tempo para digitar o código acabou. Entre com a senha de novo.");
    if (!ch.uid) throw expired();
    const attempts = await this.redis.hincrby(key, "att", 1);
    if (attempts > MFA_CHALLENGE_ATTEMPTS) {
      await this.redis.del(key);
      throw expired();
    }
    const locked = await this.throttle.lockedFor(ch.uid, meta.ip);
    if (locked > 0) {
      await this.redis.del(key);
      await this.log(ch.uid, "LOGIN_BLOCKED_THROTTLE", meta);
      throw Errors.tooMany(`Muitas tentativas de login. Tente novamente em ${Math.ceil(locked / 60)} minuto(s).`, locked);
    }
    const user = await this.prisma.user.findUnique({ where: { id: ch.uid } });
    // Senha trocada, sessões encerradas ou verificação desligada depois da senha: o desafio morre.
    if (!user || !user.totpEnabledAt || String(user.tokenVersion) !== ch.tv) {
      await this.redis.del(key);
      throw expired();
    }
    try {
      await this.checkCode(user, code, meta);
    } catch (e) {
      if (attempts >= MFA_CHALLENGE_ATTEMPTS) await this.redis.del(key);
      throw e;
    }
    // Uso único: só um pedido consome o desafio.
    if ((await this.redis.del(key)) === 0) throw expired();
    await this.throttle.registerSuccess(user.id, meta.ip);
    return user;
  }

  // ───────── Conferências ─────────

  private async checkPassword(user: User, password: string, meta: ClientMeta) {
    const locked = await this.throttle.lockedFor(user.id, meta.ip);
    if (locked > 0) throw Errors.tooMany(`Muitas tentativas. Tente novamente em ${Math.ceil(locked / 60)} minuto(s).`, locked);
    if (!(await this.hasher.verify(user.passwordHash, password))) {
      await this.throttle.registerFailure(user.id, meta.ip);
      await this.log(user.id, "MFA_PASSWORD_FAILED", meta);
      throw Errors.badRequest("INVALID_PASSWORD", "Senha incorreta.");
    }
  }

  /**
   * Código do app (6 dígitos, cada passo de 30 s vale uma vez) ou de recuperação (vale uma vez).
   * Erros entram no bloqueio do login.
   */
  async checkCode(user: User, code: string, meta: ClientMeta, opts: { allowRecovery?: boolean } = {}): Promise<"totp" | "recovery"> {
    const fail = async (): Promise<never> => {
      await this.throttle.registerFailure(user.id, meta.ip);
      await this.log(user.id, "MFA_CODE_FAILED", meta);
      throw Errors.badRequest("MFA_INVALID_CODE", "Código incorreto.");
    };
    const clean = code.trim();
    if (/^\d{6}$/.test(clean)) {
      if (!user.totpSecretEnc) return fail();
      const step = verifyTotp(this.box.open(user.totpSecretEnc), clean);
      if (step === null) return fail();
      const { count } = await this.prisma.user.updateMany({
        where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
        data: { totpLastStep: step },
      });
      if (count === 0) {
        await this.log(user.id, "MFA_CODE_REUSED", meta);
        throw Errors.badRequest("MFA_CODE_USED", "Este código já foi usado. Espere o próximo aparecer no app.");
      }
      return "totp";
    }
    if (opts.allowRecovery === false) return fail();
    const { count } = await this.prisma.mfaRecoveryCode.updateMany({
      where: { userId: user.id, codeHash: sha256(normalizeRecoveryCode(clean)), usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count === 0) return fail();
    await this.log(user.id, "MFA_RECOVERY_USED", meta);
    return "recovery";
  }

  private async log(userId: string, type: string, meta: ClientMeta) {
    await this.prisma.securityEvent.create({ data: { userId, type, ip: meta.ip, userAgent: meta.userAgent } });
  }
}
