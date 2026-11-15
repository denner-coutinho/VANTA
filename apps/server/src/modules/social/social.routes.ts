import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { REPORT_REASONS, usernameSchema } from "@vanta/shared";
import type { SocialService } from "./social.service.js";

const userId = z.string().min(1).max(40);

/** Amigos, bloqueios, silenciados, jogadores recentes, denúncias e notificações. */
export async function socialRoutes(app: FastifyInstance, opts: { social: SocialService }) {
  const social = opts.social;
  const auth = { preHandler: app.authenticate };
  const limited = (max: number, timeWindow: string) => ({ preHandler: app.authenticate, config: { rateLimit: { max, timeWindow } } });

  app.get("/social/overview", auth, async (req) => social.overview(req.auth.userId));

  app.get("/social/search", limited(60, "1 minute"), async (req) => {
    const { q } = z.object({ q: z.string().max(20).default("") }).parse(req.query);
    return { results: await social.search(req.auth.userId, q) };
  });

  app.get("/social/recent", auth, async (req) => ({ players: await social.recent(req.auth.userId) }));

  app.post("/social/requests", limited(30, "1 hour"), async (req) => {
    const { username } = z.object({ username: usernameSchema }).parse(req.body);
    return social.sendRequest(req.auth.userId, username);
  });
  app.post("/social/requests/:id/accept", auth, async (req) => {
    const { id } = z.object({ id: userId }).parse(req.params);
    await social.accept(req.auth.userId, id);
    return { ok: true };
  });
  app.post("/social/requests/:id/decline", auth, async (req) => {
    const { id } = z.object({ id: userId }).parse(req.params);
    await social.decline(req.auth.userId, id);
    return { ok: true };
  });
  app.delete("/social/requests/:id", auth, async (req) => {
    const { id } = z.object({ id: userId }).parse(req.params);
    await social.cancel(req.auth.userId, id);
    return { ok: true };
  });

  app.delete("/social/friends/:userId", auth, async (req) => {
    const p = z.object({ userId }).parse(req.params);
    await social.removeFriend(req.auth.userId, p.userId);
    return { ok: true };
  });

  app.post("/social/blocks", limited(30, "1 minute"), async (req) => {
    const b = z.object({ userId }).parse(req.body);
    await social.block(req.auth.userId, b.userId);
    return { ok: true };
  });
  app.delete("/social/blocks/:userId", auth, async (req) => {
    const p = z.object({ userId }).parse(req.params);
    await social.unblock(req.auth.userId, p.userId);
    return { ok: true };
  });

  app.post("/social/mutes", limited(30, "1 minute"), async (req) => {
    const b = z.object({ userId }).parse(req.body);
    await social.mute(req.auth.userId, b.userId);
    return { ok: true };
  });
  app.delete("/social/mutes/:userId", auth, async (req) => {
    const p = z.object({ userId }).parse(req.params);
    await social.unmute(req.auth.userId, p.userId);
    return { ok: true };
  });

  app.post("/reports", limited(10, "1 hour"), async (req, reply) => {
    const b = z
      .object({ userId, reason: z.enum(REPORT_REASONS), matchId: z.string().min(1).max(40).optional(), description: z.string().max(1000).optional() })
      .parse(req.body);
    const r = await social.report(req.auth.userId, b);
    return reply.status(201).send(r);
  });

  app.get("/notifications", auth, async (req) => {
    const [items, unread] = await Promise.all([
      app.prisma.notification.findMany({ where: { userId: req.auth.userId }, orderBy: { createdAt: "desc" }, take: 30 }),
      app.prisma.notification.count({ where: { userId: req.auth.userId, readAt: null } }),
    ]);
    return { unread, items: items.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() })) };
  });
  app.post("/notifications/read", auth, async (req) => {
    const b = z.object({ ids: z.array(z.string().min(1).max(40)).max(100).optional() }).parse(req.body ?? {});
    const r = await app.prisma.notification.updateMany({ where: { userId: req.auth.userId, readAt: null, ...(b.ids ? { id: { in: b.ids } } : {}) }, data: { readAt: new Date() } });
    return { updated: r.count };
  });
}
