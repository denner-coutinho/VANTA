import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ROLE_PERMISSIONS,
  banInputSchema,
  hasPermission,
  levelFromTotalXp,
  resolveReportSchema,
  setRoleSchema,
  type AdminMeResponse,
  type AdminOverview,
  type AdminPermission,
  type AdminReportDetail,
  type AdminUserRow,
} from "@vanta/shared";
import { Errors } from "../../lib/errors.js";
import { grantItem } from "../economy/store.service.js";
import type { SocialBus } from "../social/bus.js";
import { AdminService, REPORT_INCLUDE, activeBanWhere, toBanView, toReportView, type Actor } from "./admin.service.js";

const id = z.string().min(1).max(40);

/** Painel administrativo. Todas as rotas exigem pelo menos moderador e conferem a permissão específica. */
export async function adminRoutes(app: FastifyInstance, opts: { bus: SocialBus | null }) {
  const svc = new AdminService(app.prisma, opts.bus);
  const can = (p: AdminPermission) => ({
    preHandler: async (req: FastifyRequest, reply: Parameters<typeof app.authenticate>[1]) => {
      await app.authenticate(req, reply);
      if (!hasPermission(req.auth.role, p)) throw Errors.forbidden();
      app.assertStaffMfa(req);
    },
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  });
  const actor = (req: FastifyRequest): Actor => ({ userId: req.auth.userId, role: req.auth.role, ip: req.ip ?? null });

  app.get("/admin/me", can("panel.view"), async (req): Promise<AdminMeResponse> => ({ role: req.auth.role, permissions: [...ROLE_PERMISSIONS[req.auth.role]] }));

  app.get("/admin/overview", can("panel.view"), async (req): Promise<AdminOverview> => {
    const day = new Date(Date.now() - 24 * 3600_000);
    const [users, newUsers24h, matches24h, openReports, activeBans, audit] = await Promise.all([
      app.prisma.user.count({ where: { status: { not: "DELETED" } } }),
      app.prisma.user.count({ where: { createdAt: { gte: day } } }),
      app.prisma.match.count({ where: { endedAt: { gte: day } } }),
      app.prisma.report.count({ where: { status: { in: ["OPEN", "IN_REVIEW"] } } }),
      app.prisma.ban.count({ where: activeBanWhere() }),
      svc.auditPage(actor(req), { limit: 8 }),
    ]);
    return { users, newUsers24h, matches24h, openReports, activeBans, recentAudit: audit.entries };
  });

  // ───────── Denúncias ─────────

  app.get("/admin/reports", can("reports.view"), async (req) => {
    const q = z.object({ status: z.enum(["OPEN", "IN_REVIEW", "ACTION_TAKEN", "DISMISSED", "PENDING"]).default("PENDING"), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const rows = await app.prisma.report.findMany({
      where: q.status === "PENDING" ? { status: { in: ["OPEN", "IN_REVIEW"] } } : { status: q.status },
      include: REPORT_INCLUDE,
      orderBy: { createdAt: q.status === "PENDING" ? "asc" : "desc" },
      take: q.limit,
    });
    return { reports: rows.map(toReportView) };
  });

  app.get("/admin/reports/:id", can("reports.view"), async (req): Promise<AdminReportDetail> => {
    const p = z.object({ id }).parse(req.params);
    const r = await app.prisma.report.findUnique({ where: { id: p.id }, include: REPORT_INCLUDE });
    if (!r) throw Errors.notFound("Denúncia não encontrada.");
    const [chat, priorReports, bans] = await Promise.all([
      // Prova: o que o denunciado escreveu na partida (gravado pelo servidor de jogo).
      r.matchId ? app.prisma.matchEvent.findMany({ where: { matchId: r.matchId, type: "chat", actorId: r.reportedId }, orderBy: { tick: "asc" }, take: 200 }) : [],
      app.prisma.report.count({ where: { reportedId: r.reportedId, id: { not: r.id } } }),
      app.prisma.ban.findMany({ where: { userId: r.reportedId, ...activeBanWhere() }, include: { issuedBy: { select: { username: true } } } }),
    ]);
    return {
      ...toReportView(r),
      chat: chat.map((e) => { const d = e.data as { channel?: string; text?: string }; return { round: e.round, channel: d.channel ?? "?", text: d.text ?? "", at: e.createdAt.toISOString() }; }),
      priorReports,
      activeBans: bans.map((b) => toBanView(b)),
    };
  });

  app.post("/admin/reports/:id/resolve", can("reports.handle"), async (req) => {
    const p = z.object({ id }).parse(req.params);
    return svc.resolveReport(actor(req), p.id, resolveReportSchema.parse(req.body));
  });

  // ───────── Jogadores ─────────

  app.get("/admin/users", can("users.view"), async (req): Promise<{ users: AdminUserRow[] }> => {
    const q = z.object({ q: z.string().trim().max(40).default(""), status: z.enum(["ACTIVE", "SUSPENDED", "BANNED", "ALL"]).default("ALL") }).parse(req.query);
    const term = q.q.toLowerCase();
    // E-mail só entra na busca para quem pode ver e-mail.
    const byEmail = hasPermission(req.auth.role, "users.viewEmail") && term.includes("@");
    const rows = await app.prisma.user.findMany({
      where: {
        status: q.status === "ALL" ? { not: "DELETED" } : q.status,
        ...(term ? (byEmail ? { email: term } : { OR: [{ usernameLower: { contains: term } }, { id: term }] }) : {}),
      },
      include: { profile: { select: { totalXp: true } }, _count: { select: { reportsAgainst: { where: { status: { in: ["OPEN", "IN_REVIEW"] } } } } } },
      orderBy: term ? { usernameLower: "asc" } : { createdAt: "desc" },
      take: 50,
    });
    return {
      users: rows.map((u) => ({
        id: u.id, username: u.username, role: u.role, status: u.status,
        level: levelFromTotalXp(u.profile?.totalXp ?? 0).level,
        createdAt: u.createdAt.toISOString(), lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
        openReports: u._count.reportsAgainst,
      })),
    };
  });

  app.get("/admin/users/:id", can("users.view"), async (req) => {
    const p = z.object({ id }).parse(req.params);
    return svc.userDetail(actor(req), p.id);
  });

  app.post("/admin/users/:id/bans", can("panel.view"), async (req) => {
    const p = z.object({ id }).parse(req.params);
    return svc.ban(actor(req), p.id, banInputSchema.parse(req.body));
  });

  app.post("/admin/bans/:id/revoke", can("punish.revoke"), async (req) => {
    const p = z.object({ id }).parse(req.params);
    const b = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body);
    return svc.revokeBan(actor(req), p.id, b.reason);
  });

  app.put("/admin/users/:id/role", can("roles.manage"), async (req) => {
    const p = z.object({ id }).parse(req.params);
    const b = setRoleSchema.parse(req.body);
    return svc.setRole(actor(req), p.id, b.role, b.reason);
  });

  app.post("/admin/users/:id/mfa/reset", can("roles.manage"), async (req) => {
    const p = z.object({ id }).parse(req.params);
    const b = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body);
    return svc.resetMfa(actor(req), p.id, b.reason);
  });

  app.post("/admin/users/:id/grant", can("items.grant"), async (req) => {
    const p = z.object({ id }).parse(req.params);
    const b = z.object({ storeItemId: id, reason: z.string().trim().min(5).max(200) }).parse(req.body);
    return app.prisma.$transaction(async (tx) => {
      const [user, item] = await Promise.all([
        tx.user.findUnique({ where: { id: p.id }, select: { id: true, username: true, status: true } }),
        tx.storeItem.findUnique({ where: { id: b.storeItemId }, select: { id: true, name: true } }),
      ]);
      if (!user || user.status === "DELETED") throw Errors.notFound("Jogador não encontrado.");
      if (!item) throw Errors.notFound("Item não encontrado.");
      const owned = await tx.inventory.findUnique({ where: { userId_storeItemId: { userId: user.id, storeItemId: item.id } } });
      if (owned) throw Errors.conflict("ALREADY_OWNED", `${user.username} já tem ${item.name}.`);
      await grantItem(tx, user.id, item.id, "ADMIN_GRANT");
      await svc.audit(tx, actor(req), "item.grant", "User", user.id, { after: { storeItemId: item.id, item: item.name, reason: b.reason, username: user.username } });
      return { ok: true, item: item.name };
    });
  });

  app.get("/admin/items", can("items.grant"), async () => ({
    items: await app.prisma.storeItem.findMany({ select: { id: true, name: true, type: true, rarity: true }, orderBy: [{ type: "asc" }, { name: "asc" }] }),
  }));

  // ───────── Auditoria ─────────

  app.get("/admin/audit", can("panel.view"), async (req) => {
    const q = z.object({ actorId: id.optional(), action: z.string().max(40).optional(), targetId: id.optional(), cursor: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    return svc.auditPage(actor(req), q);
  });
}
