import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createClanSchema, updateClanSchema, type ClanLeaderboardResponse } from "@vanta/shared";
import { ClanService, toSummary } from "./clans.service.js";

/** Clãs: criar, convidar, entrar, sair, cargos, histórico e ranking. Toda permissão é conferida no servidor. */
export async function clanRoutes(app: FastifyInstance) {
  const svc = new ClanService(app.prisma);
  const auth = { preHandler: app.authenticate };
  const write = { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  const id = z.object({ id: z.string().min(1).max(40) });
  const target = z.object({ userId: z.string().min(1).max(40) });

  app.get("/clans/me", auth, async (req) => svc.mine(req.auth.userId));
  app.get("/clans", auth, async (req) => svc.search(z.object({ q: z.string().trim().max(24).optional() }).parse(req.query).q || undefined));
  app.get("/clans/tag/:tag", auth, async (req) => svc.byTag(z.object({ tag: z.string().regex(/^[A-Za-z0-9]{2,5}$/) }).parse(req.params).tag, req.auth.userId));
  app.post("/clans", write, async (req) => svc.create(req.auth.userId, createClanSchema.parse(req.body)));
  app.patch("/clans/me", write, async (req) => svc.update(req.auth.userId, updateClanSchema.parse(req.body)));
  app.post("/clans/me/invites", write, async (req) => svc.invite(req.auth.userId, z.object({ username: z.string().min(3).max(20) }).parse(req.body).username));
  app.post("/clans/invites/:id/accept", write, async (req) => svc.acceptInvite(req.auth.userId, id.parse(req.params).id));
  app.post("/clans/invites/:id/decline", write, async (req) => svc.declineInvite(req.auth.userId, id.parse(req.params).id));
  app.post("/clans/:id/join", write, async (req) => svc.join(req.auth.userId, id.parse(req.params).id));
  app.post("/clans/me/leave", write, async (req) => svc.leave(req.auth.userId));
  app.post("/clans/me/kick", write, async (req) => svc.kick(req.auth.userId, target.parse(req.body).userId));
  app.post("/clans/me/role", write, async (req) => {
    const b = target.extend({ role: z.enum(["OFFICER", "MEMBER"]) }).parse(req.body);
    return svc.setRole(req.auth.userId, b.userId, b.role);
  });
  app.post("/clans/me/transfer", write, async (req) => svc.transfer(req.auth.userId, target.parse(req.body).userId));
  app.delete("/clans/me", write, async (req) => svc.disband(req.auth.userId));

  app.get("/rankings/clans", auth, async (req): Promise<ClanLeaderboardResponse> => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(100) }).parse(req.query);
    const [total, rows, mine] = await Promise.all([
      app.prisma.clan.count(),
      app.prisma.clan.findMany({ orderBy: [{ rating: "desc" }, { createdAt: "asc" }], take: q.limit, select: { id: true, name: true, tag: true, logoKey: true, isOpen: true, rating: true, wins: true, losses: true, _count: { select: { members: true } } } }),
      app.prisma.clanMember.findUnique({ where: { userId: req.auth.userId }, select: { clan: { select: { tag: true, rating: true, createdAt: true } } } }),
    ]);
    const me = mine ? { position: (await app.prisma.clan.count({ where: { OR: [{ rating: { gt: mine.clan.rating } }, { rating: mine.clan.rating, createdAt: { lt: mine.clan.createdAt } }] } })) + 1, tag: mine.clan.tag } : null;
    return { total, entries: rows.map((r, i) => ({ ...toSummary(r), position: i + 1 })), mine: me };
  });
}
