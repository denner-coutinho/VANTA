// E2E da Fase 7 (parte 3b): clãs, perfil público, cartão do jogador e rankings, com dois navegadores reais.
// Requer: API :4000, servidor de jogo :4100 e cliente :5173 (pnpm dev). Playwright global.
// Uso: node scripts/e2e-clans.mjs [--shots dir]
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
  const TAG = `Q${Date.now().toString(36).slice(-3).toUpperCase()}`;
  const CLAN = `Esquadrao ${TAG}`;

  await A.page.click(tid("nav-clan"));
  await A.page.waitForURL("**/cla", { timeout: T });
  await A.page.fill(tid("clan-name"), CLAN);
  await A.page.fill(tid("clan-tag"), TAG.toLowerCase());
  assert((await A.page.inputValue(tid("clan-tag"))) === TAG, "tag vira maiúscula ao digitar");
  await A.page.click(tid("logo-shape-hex"));
  await A.page.click(tid("logo-color-red"));
  await A.page.uncheck(tid("clan-open"));
  await A.page.click(tid("clan-submit"));
  await A.page.waitForSelector(`${tid("clan-title")}:has-text("[${TAG}]")`, { timeout: T });
  const row = sql(`SELECT c."logoKey" || '|' || c."isOpen" || '|' || m.role FROM "Clan" c JOIN "ClanMember" m ON m."clanId" = c.id JOIN "User" u ON u.id = m."userId" WHERE c.tag = '${TAG}' AND u.username = '${A.name}';`);
  assert(row === "hex:red|false|LEADER", "clã gravado com logo, fechado e A como líder", row);
  ok(`A cria o clã [${TAG}] fechado, com logo hexágono vermelho, e vira líder`);

  // B não consegue entrar sem convite (clã fechado).
  await B.page.goto(`${BASE}/cla`);
  await B.page.fill(tid("clan-search"), TAG);
  await B.page.press(tid("clan-search"), "Enter");
  await B.page.waitForSelector(tid(`clan-result-${TAG}`), { timeout: T });
  assert(!(await B.page.isVisible(tid(`join-clan-${TAG}`))), "clã fechado não pode ter botão Entrar");
  ok("B acha o clã na busca, mas não há como entrar sem convite");

  await A.page.fill(tid("clan-invite-input"), B.name);
  await A.page.click(tid("clan-invite-send"));
  await A.page.waitForSelector(`.toast:has-text("Convite enviado")`, { timeout: T });
  await B.page.reload();
  await B.page.waitForSelector(tid(`clan-invite-${TAG}`), { timeout: T });
  await B.page.click(tid(`accept-clan-${TAG}`));
  await B.page.waitForSelector(tid(`clan-member-${B.name}`), { timeout: T });
  await B.page.waitForSelector(tid(`clan-member-${A.name}`), { timeout: T });
  assert(!(await B.page.isVisible(tid(`clan-kick-${A.name}`))), "membro não pode remover o líder");
  ok("A convida B pelo nome; B aceita e vê os dois membros (sem poder remover o líder)");

  await A.page.reload();
  await A.page.click(tid(`clan-role-${B.name}`));
  await A.page.waitForSelector(`${tid(`clan-member-${B.name}`)} :text("Oficial")`, { timeout: T });
  await B.page.reload();
  await B.page.click(tid("clan-desc-edit"));
  await B.page.fill(tid("clan-desc-input"), "Treino toda quinta às 21h");
  await B.page.click(tid("clan-desc-save"));
  await B.page.waitForSelector(`.clan-desc:has-text("Treino toda quinta")`, { timeout: T });
  assert(!(await B.page.isVisible(tid("clan-toggle-open"))), "só o líder abre ou fecha o clã");
  await A.page.reload();
  await A.page.waitForSelector(`.clan-desc:has-text("Treino toda quinta")`, { timeout: T });
  await A.page.waitForTimeout(600);
  await shot(A.page, "55-cla");
  ok("A promove B a oficial; B edita a descrição (mas não pode abrir/fechar o clã)");

  await A.page.goto(`${BASE}/menu`);
  await A.page.click(tid("nav-ranking"));
  await A.page.waitForURL("**/ranking", { timeout: T });
  await A.page.waitForSelector(tid("ranking-mode-1v1"), { timeout: T });
  await A.page.click(tid("ranking-tab-level"));
  await A.page.waitForSelector(tid("ranking-level"), { timeout: T });
  await A.page.click(tid("ranking-tab-clans"));
  await A.page.waitForSelector(tid(`ranking-clan-${TAG}`), { timeout: T });
  await A.page.waitForTimeout(600);
  await shot(A.page, "57-ranking-clas");
  ok("ranking: abas ranqueado (por modo e temporada), nível e clãs; o clã novo aparece");

  await B.page.click(`${tid(`clan-member-${A.name}`)} a`);
  await B.page.waitForURL(`**/jogador/${A.name}`, { timeout: T });
  await B.page.waitForSelector(`${tid("player-card")}:has-text("[${TAG}]")`, { timeout: T });
  assert(!(await B.page.isVisible(tid("card-pick"))), "visitante não edita o cartão de outro");
  ok("B abre o perfil público de A pelo clã: cartão com a tag do clã, sem poder editar");

  await A.page.goto(`${BASE}/menu`);
  await A.page.click(".player-chip");
  await A.page.click(tid("open-public-profile"));
  await A.page.waitForSelector(tid("card-pick"), { timeout: T });
  assert(await A.page.isDisabled(tid("card-circuit")), "cartão de nível 5 bloqueado no nível 1");
  await A.page.click(tid("avatar-red"));
  await A.page.waitForFunction(() => document.querySelector('[data-testid="player-card"] .avatar')?.getAttribute("style")?.includes("255, 59, 107"), null, { timeout: T });
  sql(`UPDATE "UserProfile" p SET "totalXp" = 5000 FROM "User" u WHERE u.id = p."userId" AND u.username = '${A.name}';`);
  await A.page.reload();
  await A.page.click(tid("card-circuit"));
  await A.page.waitForSelector(`${tid("player-card")}[data-card="circuit"]`, { timeout: T });
  const card = sql(`SELECT p."playerCardKey" || '|' || p."avatarKey" FROM "UserProfile" p JOIN "User" u ON u.id = p."userId" WHERE u.username = '${A.name}';`);
  assert(card === "circuit|red", "cartão e avatar gravados", card);
  await A.page.waitForTimeout(600);
  await shot(A.page, "56-perfil-publico");
  ok("A muda a cor do avatar; o cartão Circuito só libera ao chegar no nível 5 (XP ajustado no banco para o teste)");

  await A.page.goto(`${BASE}/cla`);
  await A.page.click(tid(`clan-kick-${B.name}`));
  await A.page.waitForSelector(tid(`clan-member-${B.name}`), { state: "detached", timeout: T });
  await B.page.goto(`${BASE}/cla`);
  await B.page.waitForSelector(tid("clan-create"), { timeout: T });
  await A.page.click(tid("clan-disband"));
  await A.page.click(tid("clan-disband-confirm"));
  await A.page.waitForSelector(tid("clan-create"), { timeout: T });
  assert(sql(`SELECT count(*) FROM "Clan" WHERE tag = '${TAG}';`) === "0", "clã apagado");
  ok("A remove B (B volta a ver a tela de criar clã) e desfaz o clã (com confirmação)");

  assert(errors.length === 0, "erros de página", errors);
  ok("nenhum erro de JavaScript");
  console.log(`\nE2E clãs e perfil: ${step} etapas OK`);
} catch (e) {
  console.error("✘ FALHOU:", e.message);
  if (SHOTS) for (const [i, P] of players.entries()) await P.page.screenshot({ path: `${SHOTS}/fail-${i}.png` }).catch(() => {});
  for (const P of players) console.error(P.name, P.page.url(), "\n  " + P.page.__log.slice(-15).join("\n  "));
  if (errors.length) console.error("Erros de página:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
