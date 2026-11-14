import type { FastifyRequest } from "fastify";

export function clientMeta(req: FastifyRequest) {
  return { ip: req.ip, userAgent: (req.headers["user-agent"] ?? "").slice(0, 300) || null };
}
