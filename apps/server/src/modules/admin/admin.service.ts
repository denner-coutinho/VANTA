import type { Prisma, PrismaClient } from "@vanta/db";
import {
  canRevoke,
  hasPermission,
  levelFromTotalXp,
  maskEmail,
  outranks,
  punishmentError,
  type AdminAuditEntry,
  type AdminBanView,
  type AdminReportView,
  type BanInput,
  type BanTypeCode,
  type UserRole,
} from "@vanta/shared";
import { Errors } from "../../lib/errors.js";
import type { SocialBus } from "../social/bus.js";

type Tx = Prisma.TransactionClient;
export interface Actor { userId: string; role: UserRole; ip: string | null }

/** Punição em vigor agora. */
export const activeBanWhere = (now = new Date()): Prisma.BanWhereInput => ({ revokedAt: null, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] });

const BAN_INCLUDE = { issuedBy: { select: { username: true } } } as const;
type BanRow = Prisma.BanGetPayload<{ include: typeof BAN_INCLUDE }>;

export function toBanView(b: BanRow, now = new Date()): AdminBanView {
  return {
    id: b.id,
    type: b.type,
    reason: b.reason,
    issuedBy: b.issuedBy?.username ?? null,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt?.toISOString() ?? null,
    revokedAt: b.revokedAt?.toISOString() ?? null,
    active: !b.revokedAt && b.startsAt <= now && (!b.endsAt || b.endsAt > now),
  };
}

export const REPORT_INCLUDE = {
  reporter: { select: { id: true, username: true } },
  reported: { select: { id: true, username: true, role: true, status: true } },
  handledBy: { select: { username: true } },
} as const;
type ReportRow = Prisma.ReportGetPayload<{ include: typeof REPORT_INCLUDE }>;

export function toReportView(r: ReportRow): AdminReportView {
  return {
    id: r.id,
    reporter: r.reporter,
    reported: r.reported,
    reason: r.reason,
    description: r.description,
    matchId: r.matchId,
    status: r.status,
    handledBy: r.handledBy?.username ?? null,
    resolution: r.resolution,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * Regras do painel administrativo. Cada ação confere a permissão do cargo e a hierarquia
 * (só se age sobre cargo menor) e grava no registro de auditoria na mesma transação.
 * O registro é somente inserção (gatilho no banco).
 */
export class AdminService {
  constructor(private readonly db: PrismaClient, private readonly bus: SocialBus | null) {}

  audit(tx: Tx, actor: Actor, action: string, targetType: string, targetId: string | null, data: { before?: unknown; after?: unknown } = {}) {
    return tx.adminAuditLog.create({
      data: { actorId: actor.userId, action, targetType, targetId, before: (data.before ?? undefined) as Prisma.InputJsonValue | undefined, after: (data.after ?? undefined) as Prisma.InputJsonValue | undefined, ip: actor.ip },
    });
  }

  private async targetFor(tx: Tx, actor: Actor, userId: string) {
    const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true, username: true, role: true, status: true } });
    if (!target || target.status === "DELETED") throw Errors.notFound("Jogador não encontrado.");
    if (target.id === actor.userId) throw Errors.forbidden("Você não pode aplicar isso na sua própria conta.");
    if (!outranks(actor.role, target.role)) throw Errors.forbidden("Você só pode agir sobre contas de cargo menor que o seu.");
    return target;
  }

  /** Aplica uma punição (dentro de uma transação existente). Devolve o evento a publicar depois do commit. */
  async applyBan(tx: Tx, actor: Actor, userId: string, input: BanInput, reportId?: string) {
    const target = await this.targetFor(tx, actor, userId);
    const err = punishmentError(actor.role, input.type, input.hours);
    if (err) throw Errors.forbidden(err);
    const now = new Date();
    const endsAt = input.hours === null ? null : new Date(now.getTime() + input.hours * 3600_000);
    const ban = await tx.ban.create({ data: { userId, type: input.type, reason: input.reason, issuedById: actor.userId, startsAt: now, endsAt }, include: BAN_INCLUDE });
    const locksAccount = input.type === "SUSPENSION" || input.type === "PERMANENT";
    if (locksAccount) {
      const status = input.type === "PERMANENT" ? "BANNED" : target.status === "BANNED" ? "BANNED" : "SUSPENDED";
      // Derruba todas as sessões: o próximo pedido com o token antigo já é recusado.
      await tx.user.update({ where: { id: userId }, data: { status, tokenVersion: { increment: 1 } } });
      await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason: "BANNED" } });
    }
    await this.audit(tx, actor, "ban.create", "User", userId, {
      before: { status: target.status },
      after: { banId: ban.id, type: input.type, hours: input.hours, reason: input.reason, reportId: reportId ?? null, username: target.username },
    });
    return { ban: toBanView(ban, now), notify: { userId, kind: locksAccount ? "account" : input.type === "CHAT_MUTE" ? "relations" : null } as const };
  }

  async publish(n: { userId: string; kind: "account" | "relations" | null }) {
    if (!this.bus || !n.kind) return;
    await this.bus.publish([n.userId], n.kind === "account" ? { k: "account_changed" } : { k: "relations_changed" }).catch(() => undefined);
  }

  async ban(actor: Actor, userId: string, input: BanInput) {
    const r = await this.db.$transaction((tx) => this.applyBan(tx, actor, userId, input));
    await this.publish(r.notify);
    return r.ban;
  }

  async revokeBan(actor: Actor, banId: string, reason: string) {
    const r = await this.db.$transaction(async (tx) => {
      const ban = await tx.ban.findUnique({ where: { id: banId }, include: BAN_INCLUDE });
      if (!ban) throw Errors.notFound("Punição não encontrada.");
      if (ban.revokedAt) throw Errors.conflict("ALREADY_REVOKED", "Essa punição já foi revogada.");
      await this.targetFor(tx, actor, ban.userId);
      if (!canRevoke(actor.role, ban.type as BanTypeCode)) throw Errors.forbidden("Seu cargo não pode revogar esse tipo de punição.");
      const now = new Date();
      const updated = await tx.ban.update({ where: { id: banId }, data: { revokedAt: now }, include: BAN_INCLUDE });
      if (ban.type === "SUSPENSION" || ban.type === "PERMANENT") {
        // A conta só volta se não sobrar outra suspensão ou banimento em vigor.
        const other = await tx.ban.findFirst({ where: { userId: ban.userId, id: { not: ban.id }, type: { in: ["SUSPENSION", "PERMANENT"] }, ...activeBanWhere(now) }, select: { type: true } });
        await tx.user.update({ where: { id: ban.userId }, data: { status: other ? (other.type === "PERMANENT" ? "BANNED" : "SUSPENDED") : "ACTIVE" } });
      }
      await this.audit(tx, actor, "ban.revoke", "User", ban.userId, { before: { banId, type: ban.type, endsAt: ban.endsAt }, after: { reason } });
      return { ban: toBanView(updated, now), userId: ban.userId, type: ban.type };
    });
    if (r.type === "CHAT_MUTE") await this.publish({ userId: r.userId, kind: "relations" });
    return r.ban;
  }

  async resolveReport(actor: Actor, reportId: string, body: { status: "IN_REVIEW" | "ACTION_TAKEN" | "DISMISSED"; resolution?: string; ban?: BanInput }) {
    if (!hasPermission(actor.role, "reports.handle")) throw Errors.forbidden();
    const r = await this.db.$transaction(async (tx) => {
      // Trava a denúncia: dois moderadores não tratam a mesma ao mesmo tempo.
      await tx.$queryRaw`SELECT id FROM "Report" WHERE id = ${reportId} FOR UPDATE`;
      const report = await tx.report.findUnique({ where: { id: reportId }, include: REPORT_INCLUDE });
      if (!report) throw Errors.notFound("Denúncia não encontrada.");
      if (report.status === "ACTION_TAKEN" || report.status === "DISMISSED") throw Errors.conflict("REPORT_CLOSED", `Essa denúncia já foi tratada por ${report.handledBy?.username ?? "outra pessoa"}.`);
      let notify: { userId: string; kind: "account" | "relations" | null } | null = null;
      let banId: string | null = null;
      if (body.ban) {
        const applied = await this.applyBan(tx, actor, report.reportedId, body.ban, report.id);
        notify = applied.notify;
        banId = applied.ban.id;
      }
      const closed = body.status !== "IN_REVIEW";
      const updated = await tx.report.update({
        where: { id: reportId },
        data: { status: body.status, handledById: actor.userId, resolution: body.resolution ?? report.resolution, resolvedAt: closed ? new Date() : null },
        include: REPORT_INCLUDE,
      });
      await this.audit(tx, actor, "report.resolve", "Report", reportId, {
        before: { status: report.status },
        after: { status: body.status, resolution: body.resolution ?? null, banId, reported: report.reported.username },
      });
      return { view: toReportView(updated), notify };
    });
    if (r.notify) await this.publish(r.notify);
    return r.view;
  }

  async setRole(actor: Actor, userId: string, role: "PLAYER" | "MODERATOR" | "ADMIN", reason: string) {
    if (!hasPermission(actor.role, "roles.manage")) throw Errors.forbidden();
    const r = await this.db.$transaction(async (tx) => {
      const target = await this.targetFor(tx, actor, userId);
      if (target.role === role) return { role, changed: false };
      // Novo token: o cargo antigo deixa de valer nos tokens já emitidos.
      await tx.user.update({ where: { id: userId }, data: { role, tokenVersion: { increment: 1 } } });
      await this.audit(tx, actor, "role.set", "User", userId, { before: { role: target.role }, after: { role, reason, username: target.username } });
      return { role, changed: true };
    });
    if (r.changed) await this.publish({ userId, kind: "account" });
    return r;
  }

  async userDetail(actor: Actor, userId: string) {
    const u = await this.db.user.findUnique({
      where: { id: userId },
      include: {
        profile: { select: { totalXp: true, title: true, matchesPlayed: true, wins: true, losses: true, kills: true, deaths: true } },
        wallet: { select: { balance: true } },
        bans: { include: BAN_INCLUDE, orderBy: { createdAt: "desc" }, take: 30 },
        reportsAgainst: { include: REPORT_INCLUDE, orderBy: { createdAt: "desc" }, take: 20 },
        matchPlayers: { include: { match: { select: { id: true, mode: true, type: true, endedAt: true } } }, orderBy: { match: { createdAt: "desc" } }, take: 10 },
      },
    });
    if (!u) throw Errors.notFound("Jogador não encontrado.");
    const now = new Date();
    const canEmail = hasPermission(actor.role, "users.viewEmail");
    const openReports = u.reportsAgainst.filter((r) => r.status === "OPEN" || r.status === "IN_REVIEW").length;
    // Abrir a ficha com e-mail completo é um acesso a dado pessoal: fica registrado.
    if (canEmail) await this.audit(this.db, actor, "user.view", "User", u.id, { after: { username: u.username } });
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      status: u.status,
      level: levelFromTotalXp(u.profile?.totalXp ?? 0).level,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
      openReports,
      email: canEmail ? u.email : maskEmail(u.email),
      emailVerified: !!u.emailVerifiedAt,
      title: u.profile?.title ?? null,
      balance: u.wallet?.balance ?? 0,
      stats: { matchesPlayed: u.profile?.matchesPlayed ?? 0, wins: u.profile?.wins ?? 0, losses: u.profile?.losses ?? 0, kills: u.profile?.kills ?? 0, deaths: u.profile?.deaths ?? 0 },
      bans: u.bans.map((b) => toBanView(b, now)),
      reports: u.reportsAgainst.map(toReportView),
      recentMatches: u.matchPlayers.map((mp) => ({ matchId: mp.match.id, mode: mp.match.mode, type: mp.match.type, result: mp.result, kills: mp.kills, deaths: mp.deaths, endedAt: mp.match.endedAt?.toISOString() ?? null })),
    };
  }

  async auditPage(actor: Actor, q: { actorId?: string; action?: string; targetId?: string; cursor?: string; limit: number }) {
    const where: Prisma.AdminAuditLogWhereInput = {
      // Moderador vê só o que ele mesmo fez; admin+ vê tudo.
      ...(hasPermission(actor.role, "audit.viewAll") ? (q.actorId ? { actorId: q.actorId } : {}) : { actorId: actor.userId }),
      ...(q.action ? { action: q.action } : {}),
      ...(q.targetId ? { targetId: q.targetId } : {}),
    };
    const rows = await this.db.adminAuditLog.findMany({
      where,
      include: { actor: { select: { id: true, username: true, role: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, q.limit);
    const userIds = [...new Set(page.filter((r) => r.targetType === "User" && r.targetId).map((r) => r.targetId!))];
    const names = new Map((await this.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } })).map((u) => [u.id, u.username]));
    const entries: AdminAuditEntry[] = page.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      targetLabel: r.targetType === "User" && r.targetId ? names.get(r.targetId) ?? null : null,
      before: r.before,
      after: r.after,
      // IP de quem agiu só para quem vê o registro completo.
      ip: hasPermission(actor.role, "audit.viewAll") ? r.ip : null,
      createdAt: r.createdAt.toISOString(),
    }));
    return { entries, nextCursor: rows.length > q.limit ? page.at(-1)!.id : null };
  }
}
