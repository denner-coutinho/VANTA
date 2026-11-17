import type { FastifyInstance } from "fastify";
import { createRegistry, httpMetrics, metricsAuthorized } from "../../lib/metrics.js";

/** GET /metrics (Prometheus) da API. Desligado sem METRICS_TOKEN; com ele, exige o token. */
export async function metricsRoutes(app: FastifyInstance) {
  const registry = createRegistry("api");
  const http = httpMetrics(registry);

  app.addHook("onResponse", async (req, reply) => {
    // Rota como foi declarada (/players/:username), nunca a URL crua: evita uma série por jogador.
    const route = req.routeOptions.url ?? "sem_rota";
    if (route === "/metrics") return;
    http.requests.inc({ method: req.method, route, status: String(reply.statusCode) });
    http.duration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
  });

  app.get("/metrics", { config: { rateLimit: false } }, async (req, reply) => {
    const token = app.config.METRICS_TOKEN;
    if (!token) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Não encontrado." } });
    if (!metricsAuthorized(req.headers.authorization, token)) return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Token de métricas inválido." } });
    return reply.type(registry.contentType).send(await registry.metrics());
  });
}
