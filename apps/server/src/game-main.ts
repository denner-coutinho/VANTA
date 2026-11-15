import { createPrismaClient } from "@vanta/db";
import { loadConfig } from "./config/env.js";
import { GameServer } from "./game/server.js";
import { RedisSocialBus } from "./modules/social/bus.js";

/** Processo separado do servidor de jogo (escala independente da API HTTP). */
const config = loadConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const maps = process.env.GAME_MAPS?.split(",").map((s) => s.trim()).filter(Boolean);
// Eventos sociais publicados pela API (amizades, bloqueios) chegam pelo Redis.
const bus = new RedisSocialBus(config.REDIS_URL, `${config.REDIS_KEY_PREFIX}social`);
const server = new GameServer({ prisma, jwtSecret: config.JWT_ACCESS_SECRET, allowedOrigins: config.corsOrigins, maps, bus });
const port = await server.start(config.GAME_PORT, config.API_HOST);
console.info(`[game] servidor de jogo ouvindo em :${port} (ws /game)`);

const shutdown = async () => {
  await server.stop();
  await bus.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
