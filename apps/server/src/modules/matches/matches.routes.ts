import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors.js";

/** Replay de partida: só quem jogou a partida baixa (o arquivo tem a posição de todos os jogadores). */
export async function matchRoutes(app: FastifyInstance) {
  app.get("/matches/:id/replay", { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    const played = await app.prisma.matchPlayer.findUnique({ where: { matchId_userId: { matchId: id, userId: req.auth.userId } }, select: { id: true } });
    if (!played) throw Errors.notFound("Replay não encontrado.");
    const r = await app.prisma.matchReplay.findUnique({ where: { matchId: id }, select: { data: true, sha256: true } });
    if (!r) throw Errors.notFound("Esta partida não tem replay (antigo demais ou não gravado).");
    return reply
      .header("content-type", "application/octet-stream")
      .header("x-replay-sha256", r.sha256)
      .header("cache-control", "private, max-age=3600")
      .send(Buffer.from(r.data));
  });
}
