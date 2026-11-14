import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Prepara o banco de testes (TEST_DATABASE_URL): aplica migrations pendentes e o seed idempotente.
 * Não apaga o banco: cada arquivo de teste limpa apenas os dados de jogadores que cria (TRUNCATE).
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://vanta:vanta@localhost:5432/vanta_test?schema=public";
  if (!/vanta_test|_test\b/.test(url)) throw new Error("TEST_DATABASE_URL precisa apontar para um banco de testes (nome com _test).");
  const dbDir = resolve(import.meta.dirname, "../../../packages/db");
  const env = { ...process.env, DATABASE_URL: url };
  execSync("npx prisma migrate deploy", { cwd: dbDir, env, stdio: "pipe" });
  execSync("npx tsx prisma/seed.ts", { cwd: dbDir, env, stdio: "pipe" });
}
