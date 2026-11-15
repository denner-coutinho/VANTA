// E2E da Fase 7 (parte 1): três navegadores reais.
// A adiciona B; B aceita; presença ao vivo; grupo (convite, chat, fila do grupo, só o líder procura);
// A e C jogam um 1v1, conversam pelo chat da partida, A denuncia C e manda pedido; C bloqueia A.
// Requer: API :4000, servidor de jogo :4100 e cliente :5173 (pnpm dev). Playwright global.
// Uso: node scripts/e2e-social.mjs [--shots dir]
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
  const C = await newPlayer("c");
  players.push(A, B, C);
  ok("três jogadores reais cadastrados em sessões separadas");

  // ── Pedido de amizade ──
  await A.page.click(tid("open-friends"));
  await A.page.click(tid("friends-tab-add"));
  await A.page.fill(tid("add-friend-input"), B.name);
  await A.page.click(tid("add-friend-submit"));
  await A.page.waitForSelector(`.toast:has-text("Pedido enviado")`, { timeout: T });
  // B recebe o aviso em tempo real (sem recarregar) e aceita.
  await B.page.waitForSelector(`.toast:has-text("${A.name} quer ser seu amigo")`, { timeout: T });
  await B.page.click(tid("open-friends"));
  await B.page.click(tid("friends-tab-requests"));
  await shot(B.page, "38-pedido-amizade");
  await B.page.click(tid(`accept-${A.name}`));
  await B.page.click(tid("friends-tab-friends"));
  await B.page.waitForSelector(`${tid(`friend-${A.name}`)}[data-presence="online"]`, { timeout: T });
  await A.page.click(tid("friends-tab-friends"));
  await A.page.waitForSelector(`${tid(`friend-${B.name}`)}[data-presence="online"]`, { timeout: T });
  ok("A envia pedido, B recebe na hora, aceita e os dois se veem online");

  // ── Grupo ──
  await A.page.click(tid(`invite-${B.name}`));
  await B.page.keyboard.press("Escape").catch(() => {});
  await B.page.mouse.click(10, 10); // fecha o painel
  await B.page.waitForSelector(tid("party-invite"), { timeout: T });
  await shot(B.page, "39-convite-grupo");
  await B.page.click(tid("party-invite-accept"));
  await A.page.mouse.click(10, 10);
  for (const P of [A, B]) {
    await P.page.waitForSelector(tid(`party-member-${A.name}`), { timeout: T });
    await P.page.waitForSelector(tid(`party-member-${B.name}`), { timeout: T });
  }
  assert((await A.page.textContent(tid("friends-online-count"))) === "1", "A deveria ver 1 amigo online");
  ok("convite de grupo chega para B, B entra e os dois veem o grupo com líder");

  await B.page.fill(tid("party-chat-input"), "bora jogar?");
  await B.page.press(tid("party-chat-input"), "Enter");
  await A.page.waitForSelector(`${tid("party-chat")} :text("bora jogar?")`, { timeout: T });
  await shot(A.page, "40-grupo-menu");
  ok("chat do grupo: mensagem de B aparece para A");

  // B (não é líder) não pode procurar partida; A procura com o grupo e os dois entram na fila.
  await B.page.goto(`${BASE}/jogar`);
  await B.page.waitForSelector(`${tid("net-status")}:has-text("Conectado")`, { timeout: T });
  await B.page.waitForSelector(`${tid("group-block")}:has-text("Só o líder")`, { timeout: T });
  assert(await B.page.isDisabled(tid("find-match")), "membro do grupo não deveria poder procurar partida");
  await A.page.goto(`${BASE}/jogar`);
  await A.page.waitForSelector(`${tid("net-status")}:has-text("Conectado")`, { timeout: T });
  await A.page.click(tid("mode-1v1"));
  await A.page.waitForSelector(`${tid("group-block")}:has-text("2 pessoas")`);
  await A.page.click(tid("mode-2v2"));
  await A.page.click(tid("find-match"));
  await A.page.waitForSelector(`${tid("queue-status")}:has-text("2 de 4")`, { timeout: T });
  await B.page.waitForSelector(`${tid("queue-status")}:has-text("2 de 4")`, { timeout: T });
  await shot(A.page, "41-fila-grupo");
  await B.page.click(tid("cancel-queue"));
  await A.page.waitForSelector(tid("find-match"), { timeout: T });
  ok("grupo na fila: só o líder procura, o grupo entra junto (2 de 4) e qualquer um cancela para todos");

  await A.page.click(tid("party-leave"));
  await B.page.waitForSelector(tid("party-widget"), { state: "detached", timeout: T });
  await A.page.waitForSelector(tid("party-widget"), { state: "detached", timeout: T });
  ok("A sai do grupo e o grupo é desfeito para os dois");

  // ── Partida 1v1 A × C com chat ──
  await C.page.goto(`${BASE}/jogar`);
  await C.page.waitForSelector(`${tid("net-status")}:has-text("Conectado")`, { timeout: T });
  await C.page.click(tid("mode-1v1"));
  await A.page.click(tid("mode-1v1"));
  await A.page.click(tid("find-match"));
  await A.page.waitForSelector(`${tid("queue-status")}:has-text("1 de 2")`, { timeout: T });
  await C.page.click(tid("find-match"));
  await Promise.all([A.page.waitForURL("**/partida", { timeout: T }), C.page.waitForURL("**/partida", { timeout: T })]);
  for (const P of [A, C]) await P.page.waitForSelector(tid("enter-match"), { timeout: 90000 });
  for (const P of [A, C]) await P.page.evaluate(() => { window.__msgs = []; window.__vantaSocket.on((m) => m.t !== "snap" && m.t !== "pong" && window.__msgs.push(m)); });
  await A.page.click(tid("enter-match"));
  await A.page.waitForSelector(tid("match-menu"), { state: "detached", timeout: T }).catch(() => {});
  await A.page.keyboard.press("Enter");
  await A.page.waitForSelector(tid("match-chat-input"), { timeout: T });
  await A.page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "match-chat-input", null, { timeout: T });
  await A.page.keyboard.type("boa sorte");
  await shot(A.page, "42-chat-partida");
  await A.page.keyboard.press("Enter");
  try {
    await C.page.waitForSelector(`${tid("match-chat")} :text("boa sorte")`, { timeout: 15000 });
  } catch (e) {
    console.error("A msgs", JSON.stringify(await A.page.evaluate(() => window.__msgs)).slice(0, 2000));
    console.error("C msgs", JSON.stringify(await C.page.evaluate(() => window.__msgs)).slice(0, 2000));
    throw e;
  }
  ok("chat da partida: A digita (Enter abre, Enter envia) e C recebe");

  await C.page.getByRole("button", { name: "Abandonar partida" }).click();
  await C.page.click(tid("confirm-leave"));
  await C.page.waitForURL("**/menu", { timeout: T });
  await A.page.waitForSelector(tid("match-result"), { timeout: T });
  await A.page.click(tid(`sb-report-${C.name}`));
  await A.page.click(tid("report-TOXIC_CHAT"));
  await A.page.fill(`${tid("report-dialog")} textarea`, "teste automatizado");
  await shot(A.page, "43-denuncia");
  await A.page.click(tid("report-submit"));
  await A.page.waitForSelector(`.toast:has-text("Denúncia enviada")`, { timeout: T });
  const report = sql(`SELECT r.reason || '|' || (r."matchId" IS NOT NULL) || '|' || r.status FROM "Report" r JOIN "User" a ON a.id = r."reporterId" JOIN "User" c ON c.id = r."reportedId" WHERE a.username = '${A.name}' AND c.username = '${C.name}';`);
  assert(report === "TOXIC_CHAT|true|OPEN", "denúncia deveria estar no banco ligada à partida", report);
  const chatLog = sql(`SELECT e.data->>'text' FROM "MatchEvent" e JOIN "User" a ON a.id = e."actorId" WHERE e.type = 'chat' AND a.username = '${A.name}';`);
  assert(chatLog === "boa sorte", "mensagem da partida deveria estar no registro para a moderação", chatLog);
  ok("A denuncia C pelo resultado da partida; a denúncia e o chat ficam gravados para a moderação");

  await A.page.click(tid(`sb-add-${C.name}`));
  await A.page.waitForSelector(`.toast:has-text("Pedido enviado")`, { timeout: T });
  await C.page.click(tid("open-friends"));
  await C.page.click(tid("friends-tab-recent"));
  await C.page.waitForSelector(tid(`recent-${A.name}`), { timeout: T });
  await shot(C.page, "44-recentes");
  await C.page.click(tid("friends-tab-requests"));
  await C.page.waitForSelector(tid(`request-${A.name}`), { timeout: T });
  await C.page.click(`${tid(`request-${A.name}`)} button:has-text("Bloquear")`);
  await C.page.waitForSelector(`.toast:has-text("Jogador bloqueado")`, { timeout: T });
  ok("C vê A nos jogadores recentes, recebe o pedido e bloqueia");

  // Bloqueado: A não consegue mandar outro pedido (resposta igual a conta inexistente).
  await A.page.goto(`${BASE}/menu`);
  await A.page.click(tid("open-friends"));
  await A.page.click(tid("friends-tab-add"));
  await A.page.fill(tid("add-friend-input"), C.name);
  await A.page.click(tid("add-friend-submit"));
  await A.page.waitForSelector(`.toast:has-text("Jogador não encontrado")`, { timeout: T });
  ok("depois do bloqueio, A não consegue mandar outro pedido para C");

  assert(errors.length === 0, "erros de página", errors);
  ok("nenhum erro de JavaScript nas três sessões");
  console.log(`\nE2E social: ${step} etapas OK`);
} catch (e) {
  console.error("✘ FALHOU:", e.message);
  if (SHOTS) for (const [i, P] of players.entries()) await P.page.screenshot({ path: `${SHOTS}/fail-${i}.png` }).catch(() => {});
  for (const P of players) console.error(P.name, P.page.url(), "\n  " + P.page.__log.slice(-25).join("\n  "));
  if (errors.length) console.error("Erros de página:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
