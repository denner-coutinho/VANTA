import { createPrismaClient } from "@vanta/db";
import { loadConfig } from "./config/env.js";
import { GameServer } from "./game/server.js";

/** Processo separado do servidor de jogo (escala independente da API HTTP). */
const config = loadConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const maps = process.env.GAME_MAPS?.split(",").map((s) => s.trim()).filter(Boolean);
const server = new GameServer({ prisma, jwtSecret: config.JWT_ACCESS_SECRET, allowedOrigins: config.corsOrigins, maps });
const port = await server.start(config.GAME_PORT, config.API_HOST);
console.info(`[game] servidor de jogo ouvindo em :${port} (ws /game)`);

const shutdown = async () => {
  await server.stop();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
