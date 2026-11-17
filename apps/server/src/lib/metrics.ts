import { timingSafeEqual } from "node:crypto";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Métricas no formato do Prometheus (Fase 8, parte 2).
 * Cada processo (API e servidor de jogo) tem o próprio registro e expõe GET /metrics.
 * O endpoint só existe com METRICS_TOKEN definido e exige "Authorization: Bearer <token>";
 * o nginx de produção também bloqueia /api/metrics, então ele nunca fica público.
 */
export function createRegistry(service: "api" | "game"): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  // CPU, memória, heap, atraso do event loop e coleta de lixo do Node.
  collectDefaultMetrics({ register: registry, prefix: "vanta_" });
  return registry;
}

/** Compara o cabeçalho Authorization com o token em tempo constante. */
export function metricsAuthorized(header: string | undefined, token: string): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function httpMetrics(registry: Registry) {
  return {
    requests: new Counter({
      name: "vanta_http_requests_total",
      help: "Requisições HTTP atendidas, por rota e status.",
      labelNames: ["method", "route", "status"] as const,
      registers: [registry],
    }),
    duration: new Histogram({
      name: "vanta_http_request_duration_seconds",
      help: "Tempo de resposta da API, por rota.",
      labelNames: ["method", "route"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
  };
}

export type GameMetrics = ReturnType<typeof gameMetrics>;

/** Métricas do servidor de jogo. Os valores de estado (conexões, partidas, filas) são lidos na hora da coleta. */
export function gameMetrics(registry: Registry, state: () => { connections: number; players: number; matches: Record<string, number>; queues: Record<string, number> }) {
  const read = () => state();
  return {
    connections: new Gauge({
      name: "vanta_game_connections",
      help: "Conexões WebSocket abertas (inclui as que ainda não se identificaram).",
      registers: [registry],
      collect() {
        this.set(read().connections);
      },
    }),
    players: new Gauge({
      name: "vanta_game_players_online",
      help: "Jogadores identificados conectados.",
      registers: [registry],
      collect() {
        this.set(read().players);
      },
    }),
    matches: new Gauge({
      name: "vanta_game_matches_active",
      help: "Partidas em andamento, por modo.",
      labelNames: ["mode"] as const,
      registers: [registry],
      collect() {
        this.reset();
        for (const [mode, n] of Object.entries(read().matches)) this.set({ mode }, n);
      },
    }),
    queues: new Gauge({
      name: "vanta_game_queue_players",
      help: "Jogadores na fila, por fila (modo:casual|ranked).",
      labelNames: ["queue"] as const,
      registers: [registry],
      collect() {
        this.reset();
        for (const [queue, n] of Object.entries(read().queues)) this.set({ queue }, n);
      },
    }),
    tick: new Histogram({
      name: "vanta_game_tick_duration_seconds",
      help: "Tempo para avançar todas as partidas um tick (orçamento: 16,7 ms a 60 Hz).",
      buckets: [0.0005, 0.001, 0.002, 0.004, 0.008, 0.0167, 0.033, 0.066],
      registers: [registry],
    }),
    tickLag: new Counter({
      name: "vanta_game_tick_catchup_total",
      help: "Ticks executados com atraso (o loop precisou recuperar) e travadas de mais de 250 ms.",
      labelNames: ["kind"] as const,
      registers: [registry],
    }),
    messagesIn: new Counter({
      name: "vanta_game_messages_in_total",
      help: "Mensagens recebidas dos clientes, por tipo.",
      labelNames: ["type"] as const,
      registers: [registry],
    }),
    messagesOut: new Counter({ name: "vanta_game_messages_out_total", help: "Mensagens enviadas aos clientes.", registers: [registry] }),
    bytesOut: new Counter({ name: "vanta_game_bytes_out_total", help: "Bytes enviados aos clientes (JSON).", registers: [registry] }),
    rejected: new Counter({
      name: "vanta_game_rejected_total",
      help: "Mensagens ou conexões recusadas, por motivo.",
      labelNames: ["reason"] as const,
      registers: [registry],
    }),
    matchesStarted: new Counter({
      name: "vanta_game_matches_started_total",
      help: "Partidas iniciadas, por modo.",
      labelNames: ["mode"] as const,
      registers: [registry],
    }),
    matchesEnded: new Counter({
      name: "vanta_game_matches_ended_total",
      help: "Partidas encerradas, por modo.",
      labelNames: ["mode"] as const,
      registers: [registry],
    }),
  };
}
