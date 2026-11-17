/**
 * Teste de carga da API HTTP (Fase 8, parte 2).
 *
 * N "trabalhadores" fazem requisições autenticadas em sequência, sorteando rotas de leitura que o
 * cliente usa no menu (perfil, carteira, loja, ranqueado, social...). Usa as contas carga_* criadas
 * pelo load-test.ts (rode ele antes, no mesmo banco). Mede vazão e latência por rota e, no fim,
 * quanto custa o hash de senha (Argon2id) que limita a taxa de login/cadastro.
 *
 * A API precisa estar com RATE_LIMIT_PER_MIN alto durante o teste: todas as requisições saem do
 * mesmo IP, e o limite padrão (300/min por IP) recusaria quase tudo.
 *
 * Uso: DATABASE_URL=.../vanta_load pnpm --filter @vanta/server load-api -- --workers 50 --duration 30 --api http://127.0.0.1:4300
 */
import { performance } from "node:perf_hooks";
import { createSigner } from "fast-jwt";
import { createPrismaClient } from "@vanta/db";
import { PasswordHasher } from "../src/lib/password.js";

const argv = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
};
const WORKERS = Number(arg("workers", "50"));
const DURATION_S = Number(arg("duration", "30"));
const API = arg("api", "http://127.0.0.1:4000").replace(/\/$/, "");
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const METRICS_TOKEN = process.env.METRICS_TOKEN ?? "";

const dbName = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
  } catch {
    return "";
  }
})();
if (process.env.NODE_ENV === "production" || !/load|carga/i.test(dbName)) {
  console.error(`Recusado: rode contra um banco de teste de carga (nome com "load" ou "carga"), não "${dbName}".`);
  process.exit(1);
}

const prisma = createPrismaClient();
const users = await prisma.user.findMany({ where: { usernameLower: { startsWith: "carga_" } }, select: { id: true, username: true, tokenVersion: true }, take: 500 });
await prisma.$disconnect();
if (!users.length) {
  console.error("Nenhuma conta carga_*: rode o load-test.ts antes (ele cria as contas).");
  process.exit(1);
}
const sign = createSigner({ key: SECRET, algorithm: "HS256", expiresIn: (DURATION_S + 300) * 1000 });
const tokens = users.map((u) => sign({ sub: u.id, role: "PLAYER", tv: u.tokenVersion }));

const ROUTES = ["/me", "/wallet", "/inventory", "/progression", "/store/catalog", "/ranked/overview", "/content/weapons", "/social/overview", "/rankings/level", "/notifications", `/players/${users[0]!.username}`];
const lat = new Map<string, number[]>(ROUTES.map((r) => [r, []]));
const statuses = new Map<number | string, number>();
const bump = (k: number | string) => statuses.set(k, (statuses.get(k) ?? 0) + 1);

async function metric(name: string): Promise<number> {
  if (!METRICS_TOKEN) return NaN;
  try {
    const text = await (await fetch(`${API}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
    const line = text.split("\n").find((l) => l.startsWith(name));
    return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : NaN;
  } catch {
    return NaN;
  }
}

console.info(`[api] ${WORKERS} trabalhadores, ${DURATION_S}s, ${API}`);
const cpu0 = await metric("vanta_process_cpu_seconds_total");
const t0 = performance.now();
const end = t0 + DURATION_S * 1000;
await Promise.all(
  Array.from({ length: WORKERS }, async (_, w) => {
    const token = tokens[w % tokens.length]!;
    while (performance.now() < end) {
      const route = ROUTES[Math.floor(Math.random() * ROUTES.length)]!;
      const s = performance.now();
      try {
        const res = await fetch(API + route, { headers: { authorization: `Bearer ${token}` } });
        await res.arrayBuffer();
        bump(res.status);
        if (res.ok) lat.get(route)!.push(performance.now() - s);
      } catch (e) {
        bump(`erro: ${(e as Error).message}`);
      }
    }
  }),
);
const secs = (performance.now() - t0) / 1000;
const cpu1 = await metric("vanta_process_cpu_seconds_total");
const rss = await metric("vanta_process_resident_memory_bytes");

const pct = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]! : NaN);
const all = [...lat.values()].flat().sort((a, b) => a - b);
console.info("\n──────── resultado ────────");
console.info(`Vazão: ${(all.length / secs).toFixed(0)} req/s com sucesso · respostas: ${JSON.stringify(Object.fromEntries(statuses))}`);
console.info(`Latência geral: p50 ${pct(all, 50).toFixed(1)} ms · p95 ${pct(all, 95).toFixed(1)} ms · p99 ${pct(all, 99).toFixed(1)} ms`);
for (const [route, a] of lat) {
  a.sort((x, y) => x - y);
  console.info(`  ${route.padEnd(24)} p50 ${pct(a, 50).toFixed(1).padStart(6)} ms · p99 ${pct(a, 99).toFixed(1).padStart(6)} ms · ${a.length}`);
}
if (Number.isFinite(cpu1)) console.info(`CPU da API: ${(((cpu1 - cpu0) / secs) * 100).toFixed(0)}% de um núcleo · memória ${(rss / 1048576).toFixed(0)} MB`);

// Custo do hash de senha (cada login e cadastro faz um).
const memKiB = Number(process.env.ARGON2_MEMORY_KIB ?? 19456);
const hasher = new PasswordHasher(memKiB);
const h0 = performance.now();
for (let i = 0; i < 20; i++) await hasher.hash(`senha-de-teste-${i}`);
const perHash = (performance.now() - h0) / 20;
console.info(`Argon2id (${memKiB} KiB): ${perHash.toFixed(0)} ms por hash → ~${(1000 / perHash).toFixed(0)} logins/s por núcleo`);
process.exit(0);
