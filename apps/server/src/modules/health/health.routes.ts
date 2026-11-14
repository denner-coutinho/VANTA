import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", { config: { rateLimit: false } }, async (_req, reply) => {
    const checks = { db: false, redis: false };
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      checks.db = true;
    } catch {}
    try {
      checks.redis = (await app.redis.ping()) === "PONG";
    } catch {}
    const ok = checks.db && checks.redis;
    return reply.status(ok ? 200 : 503).send({ status: ok ? "ok" : "degraded", checks, uptimeSec: Math.round(process.uptime()) });
  });
}
