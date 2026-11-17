import { createPrismaClient } from "@vanta/db";
import { loadConfig } from "./config/env.js";
import { GameServer } from "./game/server.js";
import { RedisSocialBus } from "./modules/social/bus.js";
import { PasswordHasher } from "./lib/password.js";
import { pruneReplays } from "./modules/matches/replay.js";
import { RedisCluster } from "./game/cluster.js";

/** Processo separado do servidor de jogo (escala independente da API HTTP). */
const config = loadConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const maps = process.env.GAME_MAPS?.split(",").map((s) => s.trim()).filter(Boolean);
// Eventos sociais publicados pela API (amizades, bloqueios) chegam pelo Redis.
const bus = new RedisSocialBus(config.REDIS_URL, `${config.REDIS_KEY_PREFIX}social`);
// Com GAME_NODE_ID, este processo é um nó de um cluster de servidores de jogo (estado compartilhado no Redis).
const cluster = config.GAME_NODE_ID ? new RedisCluster(config.REDIS_URL, config.GAME_NODE_ID, config.REDIS_KEY_PREFIX) : undefined;
const server = new GameServer({ prisma, jwtSecret: config.JWT_ACCESS_SECRET, allowedOrigins: config.corsOrigins, maps, bus, hasher: new PasswordHasher(config.ARGON2_MEMORY_KIB), metricsToken: config.METRICS_TOKEN, cluster, publicUrl: config.GAME_PUBLIC_URL || undefined });
const port = await server.start(config.GAME_PORT, config.API_HOST);
console.info(`[game] servidor de jogo ouvindo em :${port} (ws /game)${cluster ? `, nó ${config.GAME_NODE_ID} do cluster` : ""}`);

// Replays vencidos (mais de 30 dias) saem do banco ao subir e a cada 6 horas.
const prune = () => pruneReplays(prisma).then((n) => n && console.info(`[game] ${n} replays vencidos apagados`)).catch((e) => console.error("[game] limpeza de replays", e));
void prune();
const pruneTimer = setInterval(() => void prune(), 6 * 3600_000);
pruneTimer.unref();

const shutdown = async () => {
  clearInterval(pruneTimer);
  await server.stop();
  await bus.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
