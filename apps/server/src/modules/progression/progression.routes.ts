import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ProgressionService } from "./progression.service.js";

/** Nível, XP, missões, conquistas, medalhas, títulos e histórico de progressão. */
export async function progressionRoutes(app: FastifyInstance) {
  const svc = new ProgressionService(app.prisma);
  const auth = { preHandler: app.authenticate };

  app.get("/progression", auth, async (req) => svc.overview(req.auth.userId));

  app.post("/progression/missions/:id/claim", { preHandler: app.authenticate, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(40) }).parse(req.params);
    return svc.claim(req.auth.userId, id);
  });

  app.put("/profile/title", auth, async (req) => {
    const { title } = z.object({ title: z.string().min(1).max(40).nullable() }).parse(req.body);
    return svc.setTitle(req.auth.userId, title);
  });
}
