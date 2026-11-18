// E2E da Fase 7 (parte 2): salas personalizadas e espectador com três navegadores reais.
// A cria sala com senha; C acha na lista, erra e acerta a senha e vai assistir; A convida B (amigo, sem senha);
// chat e regras; partida real com C assistindo com atraso; volta ao lobby; remover e encerrar.
// Requer: API :4000, servidor de jogo :4100 e cliente :5173 (pnpm dev). Playwright global.
// Uso: node scripts/e2e-rooms.mjs [--shots dir]
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


async function befriend(X, Y) {
  await X.page.click(tid("open-friends"));
  await X.page.click(tid("friends-tab-add"));
  await X.page.fill(tid("add-friend-input"), Y.name);
  await X.page.click(tid("add-friend-submit"));
  await Y.page.waitForSelector(`.toast:has-text("${X.name} quer ser seu amigo")`, { timeout: T });
  await Y.page.click(tid("open-friends"));
  await Y.page.click(tid("friends-tab-requests"));
  await Y.page.click(tid(`accept-${X.name}`));
  await Y.page.mouse.click(10, 10);
  await X.page.mouse.click(10, 10);
}
const roomRow = (code) => sql(`SELECT r.status || '|' || r."isPrivate" || '|' || (r."passwordHash" LIKE '$argon2id$%') || '|' || r."roundsToWin" FROM "Room" r WHERE r.code = '${code}';`);

const players = [];
try {
  const A = await newPlayer("a");
  const B = await newPlayer("b");
  const C = await newPlayer("c");
  players.push(A, B, C);
  await befriend(A, B);
  ok("três jogadores reais; A e B são amigos");

  // ── A cria uma sala pública com senha ──
  await A.page.click(tid("nav-rooms"));
  await A.page.waitForURL("**/salas", { timeout: T });
  await A.page.click(tid("room-create-open"));
  await A.page.fill(tid("room-name"), "Sala E2E");
  await A.page.selectOption(tid("room-mode"), "1v1");
  await A.page.selectOption(tid("room-map"), "FROST_BASE");
  await A.page.fill(tid("room-rounds"), "2");
  await A.page.fill(tid("room-round-time"), "60");
  await A.page.click(tid("room-weapon-SNIPER")); // tira as armas de precisão
  await A.page.fill(tid("room-password"), "senha123");
  await shot(A.page, "45-criar-sala");
  await A.page.click(tid("room-settings-submit"));
  await A.page.waitForURL("**/sala", { timeout: T });
  const code = (await A.page.textContent(`${tid("room-code")} strong`)).trim();
  assert(/^[A-Z2-9]{6}$/.test(code), "código da sala inválido", code);
  await A.page.waitForSelector(`${tid("room-team-0")} ${tid(`room-member-${A.name}`)}`, { timeout: T });
  assert(roomRow(code) === "OPEN|false|true|2", "sala deveria estar gravada (pública, senha com hash, 2 rounds)", roomRow(code));
  ok(`A cria a sala ${code} (1v1, Frost Base, 2 rounds, 60 s, sem armas de precisão, com senha) e vira o dono`);

  // ── C acha a sala na lista pública, erra a senha e entra ──
  await C.page.click(tid("nav-rooms"));
  await C.page.waitForSelector(tid(`room-row-${code}`), { timeout: T });
  const rowText = await C.page.textContent(tid(`room-row-${code}`));
  assert(rowText.includes("Sala E2E") && rowText.includes("senha") && rowText.includes("1/2") && rowText.includes(A.name), "linha da sala na lista", rowText);
  await C.page.waitForTimeout(900);
  await shot(C.page, "46-lista-salas");
  await C.page.click(tid(`room-join-${code}`));
  await C.page.waitForSelector(tid("room-password-dialog"), { timeout: T });
  await C.page.fill(tid("room-password-input"), "errada1");
  await C.page.click(tid("room-password-submit"));
  await C.page.waitForSelector(`${tid("room-password-dialog")} :text("Senha incorreta")`, { timeout: T });
  await C.page.fill(tid("room-password-input"), "senha123");
  await C.page.click(tid("room-password-submit"));
  await C.page.waitForURL("**/sala", { timeout: T });
  await C.page.waitForSelector(`${tid("room-team-1")} ${tid(`room-member-${C.name}`)}`, { timeout: T });
  await C.page.click(tid("room-join-spec"));
  await A.page.waitForSelector(`${tid("room-spectators")} ${tid(`room-member-${C.name}`)}`, { timeout: T });
  ok("C acha a sala na lista pública, erra a senha (recusada), entra com a certa e vai para espectadores");

  // ── A convida B (amigo): o convite dispensa a senha ──
  await A.page.click(tid("room-invite-open"));
  await A.page.click(tid(`room-invite-${B.name}`));
  await A.page.click(`${tid("room-invite-dialog")} button:has-text("Fechar")`);
  await B.page.waitForSelector(tid("room-invite"), { timeout: T });
  await shot(B.page, "47-convite-sala");
  await B.page.click(tid("room-invite-accept"));
  await B.page.waitForURL("**/sala", { timeout: T });
  await A.page.waitForSelector(`${tid("room-team-1")} ${tid(`room-member-${B.name}`)}`, { timeout: T });
  ok("A convida B pela lista de amigos; B aceita o convite e entra sem digitar a senha (Time B)");

  // ── Chat da sala e regras ──
  await B.page.fill(tid("room-chat-input"), "pronto!");
  await B.page.press(tid("room-chat-input"), "Enter");
  for (const P of [A, C]) await P.page.waitForSelector(`${tid("room-chat")} :text("pronto!")`, { timeout: T });
  await A.page.click(tid("room-edit"));
  await A.page.check(tid("room-hs"));
  await A.page.click(tid("room-settings-submit"));
  for (const P of [B, C]) await P.page.waitForSelector(`${tid("room-rules")} :text("Só headshot")`, { timeout: T });
  await A.page.click(tid("room-lock"));
  await C.page.waitForSelector(`.room-header :text("trancada")`, { timeout: T });
  await A.page.click(tid("room-lock"));
  await C.page.waitForSelector(`.room-header :text("trancada")`, { state: "detached", timeout: T });
  assert(!(await B.page.isVisible(tid("room-start"))), "só o dono vê o botão de começar");
  await A.page.waitForTimeout(400);
  await shot(A.page, "48-lobby-sala");
  ok("chat da sala chega para todos; o dono liga \"só headshot\", tranca e destranca a entrada");

  // ── Começa: A e B jogam, C assiste com atraso ──
  await A.page.click(tid("room-start"));
  await Promise.all([A.page.waitForURL("**/partida", { timeout: T }), B.page.waitForURL("**/partida", { timeout: T }), C.page.waitForURL("**/assistir", { timeout: T })]);
  await C.page.waitForSelector(`${tid("spec-delay")}:has-text("atraso de 3 s")`, { timeout: T });
  await C.page.waitForFunction(() => (window.__vantaSpec?.debugState().frames ?? 0) > 10, null, { timeout: 60000 });
  const spec = await C.page.evaluate(() => window.__vantaSpec.debugState());
  assert(spec.players.length === 2 && spec.players.every((p) => p.pos.y > -50), "espectador deveria ver os dois jogadores no mapa", spec);
  await A.page.waitForSelector(`${tid("spectators-count")}:has-text("1 assistindo")`, { timeout: 90000 });
  await B.page.waitForSelector(`.match-clock :text("só headshot")`, { timeout: T });
  const loadouts = await A.page.evaluate(() => window.__vantaSocket.match.players.map((p) => p.loadout));
  assert(loadouts.every((l) => !l.includes("LR1_HORIZONTE")), "arma de precisão não deveria estar no arsenal", loadouts);
  await C.page.click(tid(`spec-follow-${B.name}`));
  await C.page.waitForTimeout(1500);
  await shot(C.page, "49-espectador");
  await shot(A.page, "50-partida-sala");
  ok("partida da sala no servidor real: A e B jogam com as regras da sala; C assiste com 3 s de atraso e os jogadores veem \"1 assistindo\"");

  // ── B abandona; todos voltam para o lobby ──
  await B.page.getByRole("button", { name: "Abandonar partida" }).click();
  await B.page.click(tid("confirm-leave"));
  await B.page.waitForURL("**/sala", { timeout: T });
  await A.page.waitForSelector(tid("back-to-room"), { timeout: T });
  await C.page.waitForSelector(tid("spec-result"), { timeout: T });
  await shot(C.page, "51-espectador-resultado");
  await A.page.click(tid("back-to-room"));
  await C.page.click(tid("spec-back"));
  for (const P of [A, C]) await P.page.waitForURL("**/sala", { timeout: T });
  await A.page.waitForSelector(tid("room-start"), { timeout: T });
  const saved = sql(`SELECT m.type || '|' || (m."roomId" IS NOT NULL) || '|' || m."roundsToWin" FROM "Match" m JOIN "Room" r ON r.id = m."roomId" WHERE r.code = '${code}';`);
  assert(saved === "CUSTOM|true|2", "partida deveria ser gravada como CUSTOM ligada à sala", saved);
  const prof = sql(`SELECT p."matchesPlayed" FROM "UserProfile" p JOIN "User" u ON u.id = p."userId" WHERE u.username = '${A.name}';`);
  assert(prof === "0", "partida de sala não conta nas estatísticas do perfil", prof);
  ok("B sai (abandono), todos voltam ao lobby; a partida fica gravada como CUSTOM e não conta no perfil");

  // ── Dono remove C (não volta) e encerra a sala ──
  await A.page.click(tid(`room-kick-${C.name}`));
  await C.page.waitForURL("**/salas", { timeout: T });
  await C.page.waitForSelector(`.toast:has-text("removeu você")`, { timeout: T });
  await C.page.fill(tid("room-code-input"), code);
  await C.page.click(tid("room-code-join"));
  await C.page.waitForSelector(tid("room-password-dialog"), { timeout: T });
  await C.page.fill(tid("room-password-input"), "senha123");
  await C.page.click(tid("room-password-submit"));
  await C.page.waitForSelector(`.toast:has-text("removido desta sala")`, { timeout: T });
  await A.page.click(tid("room-close"));
  await B.page.waitForURL("**/salas", { timeout: T });
  await B.page.waitForSelector(`.toast:has-text("encerrou a sala")`, { timeout: T });
  assert(roomRow(code).startsWith("CLOSED|"), "sala deveria estar encerrada no banco", roomRow(code));
  ok("o dono remove C (que não consegue voltar nem com código e senha) e encerra a sala");

  assert(errors.length === 0, "erros de página", errors);
  ok("nenhum erro de JavaScript nas três sessões");
  console.log(`\nE2E salas: ${step} etapas OK`);
} catch (e) {
  console.error("✘ FALHOU:", e.message);
  if (SHOTS) for (const [i, P] of players.entries()) await P.page.screenshot({ path: `${SHOTS}/fail-${i}.png` }).catch(() => {});
  for (const P of players) console.error(P.name, P.page.url(), "\n  " + P.page.__log.slice(-25).join("\n  "));
  if (errors.length) console.error("Erros de página:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
