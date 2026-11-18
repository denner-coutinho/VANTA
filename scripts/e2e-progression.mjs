// E2E da Fase 7 (parte 3): progressão com dois navegadores reais.
// Partida casual real → XP calculado no servidor → resultado mostra XP → missão concluída e resgatada →
// conquista desbloqueada → histórico de XP → escolha de título.
// Requer: API :4000, servidor de jogo :4100 e cliente :5173 (pnpm dev). Playwright global.
// Uso: node scripts/e2e-progression.mjs [--shots dir]
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(`${execSync("npm root -g").toString().trim()}/playwright`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.E2E_BASE ?? "http://localhost:5173";
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const dbUrl = (process.env.DATABASE_URL ?? readFileSync(`${root}/.env`, "utf8").match(/^DATABASE_URL=(.*)$/m)[1]).replace(/^"|"$/g, "").replace(/\?.*$/, "");
const sql = (q) => execSync(`psql "${dbUrl}" -At -v ON_ERROR_STOP=1`, { input: q }).toString().trim();

let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);
const fail = (msg, extra) => {
  throw new Error(`${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
};
const assert = (c, msg, extra) => c || fail(msg, extra);
const T = 30000;

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];

async function newPlayer(tag) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  await ctx.addInitScript(() => localStorage.setItem("vanta.settings", JSON.stringify({ quality: "low", uiVolume: 0, masterVolume: 0, maxFps: 30 })));
  await ctx.addInitScript(() => {
    const W = window.WebSocket;
    window.WebSocket = class extends W {
      constructor(...a) {
        super(...a);
        this.addEventListener("close", (e) => console.log(`[ws-close] ${a[0]} ${e.code} ${e.reason}`));
      }
    };
  });
  const page = await ctx.newPage();
  page.on("console", (m) => m.text().startsWith("[ws-close]") && page.__log.push(`${new Date().toISOString().slice(11, 23)} ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  page.__log = [];
  page.on("response", (r) => r.url().includes("/auth/") && page.__log.push(`${new Date().toISOString().slice(11, 23)} ${r.request().method()} ${r.url().replace(BASE, "")} ${r.status()}`));
  page.on("requestfailed", (r) => r.url().includes("/auth/") && page.__log.push(`${new Date().toISOString().slice(11, 23)} FAILED ${r.url().replace(BASE, "")} ${r.failure()?.errorText}`));
  page.on("framenavigated", (f) => f === page.mainFrame() && page.__log.push(`${new Date().toISOString().slice(11, 23)} nav ${f.url().replace(BASE, "")}`));
  page.on("websocket", (ws) => ws.url().includes("/game") && ws.on("close", () => page.__log.push(`${new Date().toISOString().slice(11, 23)} game ws closed`)));
  const id = `${tag}${Date.now().toString(36).slice(-5)}`;
  await page.goto(`${BASE}/cadastro`);
  await page.fill('input[name="username"]', `SO_${id}`);
  await page.fill('input[name="email"]', `so_${id}@teste.vanta`);
  await page.fill('input[name="password"]', "SenhaForte123");
  await page.fill('input[name="birthDate"]', "2000-01-01");
  await page.check('input[name="acceptTerms"]');
  await page.click('button[type="submit"]');
  await page.waitForURL("**/menu", { timeout: T });
  // Conectado ao servidor de jogo: só assim recebe convites e pedidos ao vivo.
  await page.waitForSelector('[data-testid="conn-status"][data-state="online"]', { timeout: T });
  return { page, ctx, name: `SO_${id}` };
}
const shot = async (p, name) => SHOTS && p.screenshot({ path: `${SHOTS}/${name}.png` });
const tid = (id) => `[data-testid="${id}"]`;


const players = [];
try {
  const A = await newPlayer("a");
  const B = await newPlayer("b");
  players.push(A, B);
  ok("dois jogadores reais cadastrados");

  await A.page.click(tid("nav-progress"));
  await A.page.waitForURL("**/progresso", { timeout: T });
  await A.page.waitForSelector(`${tid("progress-level")}:has-text("1")`, { timeout: T });
  await A.page.waitForSelector(tid("mission-DAILY_WIN_1"), { timeout: T });
  assert(!(await A.page.isVisible(tid("claim-DAILY_WIN_1"))), "missão ainda não concluída não pode ter resgate");
  ok("tela de progresso: nível 1, missões diárias e semanais vindas do servidor");

  // Partida casual 1v1 de verdade: B abandona, A vence.
  for (const P of [A, B]) {
    await P.page.goto(`${BASE}/jogar`);
    await P.page.waitForSelector(`${tid("net-status")}:has-text("Conectado")`, { timeout: T });
    await P.page.click(tid("queue-casual"));
    await P.page.click(tid("mode-1v1"));
  }
  await A.page.click(tid("find-match"));
  await A.page.waitForSelector(`${tid("queue-status")}:has-text("1 de 2")`, { timeout: T });
  await B.page.click(tid("find-match"));
  await Promise.all([A.page.waitForURL("**/partida", { timeout: T }), B.page.waitForURL("**/partida", { timeout: T })]);
  await B.page.waitForSelector(tid("enter-match"), { timeout: 90000 });
  await B.page.getByRole("button", { name: "Abandonar partida" }).click();
  await B.page.click(tid("confirm-leave"));
  await A.page.waitForSelector(tid("match-result"), { timeout: T });
  await A.page.waitForSelector(tid("progress-card"), { timeout: T });
  const xpText = await A.page.textContent(tid("progress-xp"));
  assert(xpText.trim() === "+250 XP", "vitória sem abates deveria dar 250 XP", xpText);
  await shot(A.page, "52-resultado-xp");
  ok("fim da partida: o servidor calcula e manda +250 XP (vitória) para o resultado");

  const xpDb = sql(`SELECT p."totalXp" || '|' || mp."xpEarned" FROM "UserProfile" p JOIN "User" u ON u.id = p."userId" JOIN "MatchPlayer" mp ON mp."userId" = u.id WHERE u.username = '${A.name}';`);
  assert(xpDb === "450|250", "XP gravado: 250 da partida + 200 da conquista Primeira vitória", xpDb);
  const bXp = sql(`SELECT p."totalXp" FROM "UserProfile" p JOIN "User" u ON u.id = p."userId" WHERE u.username = '${B.name}';`);
  assert(bXp === "0", "quem abandona não ganha XP", bXp);
  ok("no banco: A tem 250 XP da partida + 200 da conquista; B (abandonou) tem 0");

  await A.page.goto(`${BASE}/progresso`);
  await A.page.waitForSelector(tid("claim-DAILY_WIN_1"), { timeout: T });
  await A.page.click(tid("claim-DAILY_WIN_1"));
  await A.page.waitForSelector(`.toast:has-text("+200 XP")`, { timeout: T });
  await A.page.waitForSelector(`${tid("mission-DAILY_WIN_1")} :text("Resgatada")`, { timeout: T });
  const claims = await A.page.evaluate(async (id) => {
    const r = await fetch(`/api/progression/missions/${id}/claim`, { method: "POST", credentials: "include" });
    return r.status;
  }, "x");
  assert(claims === 404 || claims === 401, "resgate de missão inexistente tem de ser recusado", claims);
  ok("A resgata a missão \"Primeira do dia\" (+200 XP) e ela fica marcada como resgatada");

  await A.page.click(tid("progress-tab-achievements"));
  await A.page.waitForSelector(`${tid("achievement-FIRST_WIN")} :text("Desbloqueada")`, { timeout: T });
  await A.page.waitForTimeout(800);
  await shot(A.page, "53-conquistas");
  await A.page.click(tid("progress-tab-history"));
  await A.page.waitForSelector(`${tid("xp-history")} :text("Missão: Primeira do dia")`, { timeout: T });
  await A.page.waitForSelector(`${tid("xp-history")} :text("Conquista: Primeira vitória")`, { timeout: T });
  await A.page.click(tid("progress-tab-missions"));
  await A.page.waitForSelector(tid("mission-WEEKLY_MEDALS_10"), { timeout: T });
  await A.page.waitForTimeout(800);
  await shot(A.page, "54-missoes");
  ok("conquista \"Primeira vitória\" desbloqueada e histórico de XP com partida, conquista e missão");

  // Título: libera "Ace" no banco (simula a conquista) e escolhe na tela.
  sql(`INSERT INTO "UserAchievement" (id, "userId", "achievementId", progress, "unlockedAt") SELECT 'e2e_' || u.id, u.id, a.id, 1, now() FROM "User" u, "Achievement" a WHERE u.username = '${A.name}' AND a.code = 'ACE_1';`);
  await A.page.reload();
  await A.page.waitForSelector(`${tid("title-select")} option[value="Ace"]`, { state: "attached", timeout: T });
  await A.page.selectOption(tid("title-select"), "Ace");
  await A.page.waitForSelector(`.toast:has-text("Ace")`, { timeout: T });
  const title = sql(`SELECT p.title FROM "UserProfile" p JOIN "User" u ON u.id = p."userId" WHERE u.username = '${A.name}';`);
  assert(title === "Ace", "título deveria estar gravado", title);
  ok("título desbloqueado aparece na lista e fica gravado no perfil");

  assert(errors.length === 0, "erros de página", errors);
  ok("nenhum erro de JavaScript");
  console.log(`\nE2E progressão: ${step} etapas OK`);
} catch (e) {
  console.error("✘ FALHOU:", e.message);
  if (SHOTS) for (const [i, P] of players.entries()) await P.page.screenshot({ path: `${SHOTS}/fail-${i}.png` }).catch(() => {});
  for (const P of players) console.error(P.name, P.page.url(), "\n  " + P.page.__log.slice(-25).join("\n  "));
  if (errors.length) console.error("Erros de página:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
