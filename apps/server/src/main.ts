import { loadConfig } from "./config/env.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = await buildApp(config);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} recebido, encerrando...`);
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.API_PORT, host: config.API_HOST });
