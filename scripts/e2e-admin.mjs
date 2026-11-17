// E2E da Fase 7 (parte 5): painel administrativo (moderador e superadmin) e teclas remapeáveis, com navegadores reais.
// Requer: API :4000, servidor de jogo :4100 e cliente :5173 (pnpm dev). Playwright global.
// Os cargos de moderador e superadmin são dados direto no banco (como faz o comando create-admin); a denúncia
// de partida também é criada no banco, porque o envio de denúncia já é coberto pelo E2E social.
// Uso: node scripts/e2e-admin.mjs [--shots dir]
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { enableMfaUi } from "./lib/mfa-ui.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(`${execSync("npm root -g").toString().trim()}/playwright`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.E2E_BASE ?? "http://localhost:5173";
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const dbUrl = (process.env.DATABASE_URL ?? readFileSync(`${root}/.env`, "utf8").match(/^DATABASE_URL=(.*)$/m)[1]).replace(/^"|"$/g, "").replace(/\?.*$/, "");
const sql = (q) => execSync(`psql "${dbUrl}" -At -v ON_ERROR_STOP=1`, { input: q, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const esc = (s) => s.replace(/'/g, "''");

let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);
const fail = (msg, extra) => {
  throw new Error(`${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
};
const assert = (c, msg, extra) => c || fail(msg, extra);
const T = 30000;

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];
const PASS = "SenhaForte123";

async function newContext(tag) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem("vanta.settings", JSON.stringify({ quality: "low", uiVolume: 0, masterVolume: 0, maxFps: 30 })));
  const page = await ctx.newPage();
  // 401/403 de quem foi suspenso (ou de quem tenta abrir o painel sem cargo) são esperados: só erros de script contam.
  page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  return { ctx, page };
}
async function newPlayer(tag) {
  const { ctx, page } = await newContext(tag);
  const id = `${tag}${Date.now().toString(36).slice(-5)}`;
  await page.goto(`${BASE}/cadastro`);
  await page.fill('input[name="username"]', `AD_${id}`);
  await page.fill('input[name="email"]', `ad_${id}@teste.vanta`);
  await page.fill('input[name="password"]', PASS);
  await page.fill('input[name="birthDate"]', "2000-01-01");
  await page.check('input[name="acceptTerms"]');
  await page.click('button[type="submit"]');
  await page.waitForURL("**/menu", { timeout: T });
  const name = `AD_${id}`;
  const userId = sql(`SELECT id FROM "User" WHERE username = '${esc(name)}'`);
  return { page, ctx, name, email: `ad_${id}@teste.vanta`, userId };
}
async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="identifier"]', email);
  await page.fill('input[name="password"]', PASS);
  await page.click('button[type="submit"]');
}
// Espera a animação de entrada dos painéis (0,6 s) antes de fotografar.
const shot = async (p, name) => SHOTS && (await p.waitForTimeout(900), p.screenshot({ path: `${SHOTS}/${name}.png` }));
const tid = (id) => `[data-testid="${id}"]`;
const actions = (actorId) => sql(`SELECT action FROM "AdminAuditLog" WHERE "actorId" = '${actorId}' ORDER BY "createdAt"`).split("\n").filter(Boolean);

try {
  const P = await newPlayer("p");
  const M = await newPlayer("m");
  const S = await newPlayer("s");
  sql(`UPDATE "User" SET role = 'MODERATOR' WHERE id = '${M.userId}'; UPDATE "User" SET role = 'SUPERADMIN' WHERE id = '${S.userId}';`);
  // Cargo da equipe só usa o painel com a verificação em duas etapas (coberta a fundo pelo e2e-mfa).
  await enableMfaUi(M.page, BASE, PASS, T);
  await enableMfaUi(S.page, BASE, PASS, T);
  await M.page.goto(`${BASE}/menu`);
  ok("três contas reais: jogador, moderador e superadmin (equipe com verificação em duas etapas)");

  // 1. Jogador comum não vê nem abre o painel.
  assert((await P.page.locator(tid("open-admin")).count()) === 0, "jogador não deveria ver o botão do painel");
  await P.page.goto(`${BASE}/admin`);
  await P.page.waitForSelector(tid("admin-denied"), { timeout: T });
  ok(`jogador comum: sem botão e /admin recusado ("${(await P.page.textContent(tid("admin-denied"))).trim()}")`);

  // 2. Denúncia de partida com chat gravado.
  const matchId = sql(`SELECT id FROM "Match" WHERE status = 'FINISHED' ORDER BY "endedAt" DESC LIMIT 1`);
  assert(matchId, "precisa de uma partida terminada no banco de desenvolvimento (rode outro E2E antes)");
  sql(`INSERT INTO "MatchPlayer" (id, "matchId", "userId", team) VALUES ('mp_${P.userId}', '${matchId}', '${P.userId}', 1), ('mp_${S.userId}', '${matchId}', '${S.userId}', 0) ON CONFLICT DO NOTHING;
       INSERT INTO "MatchEvent" ("matchId", tick, round, type, "actorId", data) VALUES ('${matchId}', 999999, 3, 'chat', '${P.userId}', '{"channel":"all","text":"mensagem ofensiva gravada pelo servidor"}');
       INSERT INTO "Report" (id, "reporterId", "reportedId", "matchId", reason, description) VALUES ('rep_${P.userId}', '${S.userId}', '${P.userId}', '${matchId}', 'TOXIC_CHAT', 'ofendeu no chat de todos');`);

  // 3. Moderador abre o painel.
  await M.page.reload();
  await M.page.waitForSelector(tid("open-admin"), { timeout: T });
  await M.page.click(tid("open-admin"));
  await M.page.waitForSelector(tid("admin-stat-reports"), { timeout: T });
  assert((await M.page.textContent(tid("admin-role"))).includes("Moderador"), "cargo no topo");
  const pending = Number((await M.page.textContent(tid("admin-stat-reports"))).replace(/\D/g, ""));
  assert(pending >= 1, "visão geral deveria contar a denúncia pendente", { pending });
  await shot(M.page, "61-admin-geral");
  ok(`moderador entra no painel: ${pending} denúncia(s) pendente(s) na visão geral`);

  // 4. Trata a denúncia com a prova do chat e aplica silêncio.
  await M.page.click(tid("admin-tab-reports"));
  await M.page.click(tid(`report-open-${P.name}`));
  await M.page.waitForSelector(tid("report-chat"), { timeout: T });
  assert((await M.page.textContent(tid("report-chat"))).includes("mensagem ofensiva gravada pelo servidor"), "prova do chat");
  await M.page.fill(tid("report-resolution"), "Ofensa confirmada no chat da partida.");
  await M.page.check(tid("report-punish"));
  // O moderador só recebe as punições e prazos que pode aplicar.
  const types = await M.page.locator(`${tid("punish-type")} option`).evaluateAll((os) => os.map((o) => o.value));
  assert(JSON.stringify(types) === JSON.stringify(["CHAT_MUTE", "SUSPENSION"]), "moderador só silencia e suspende", types);
  await M.page.selectOption(tid("punish-type"), "SUSPENSION");
  const hours = await M.page.locator(`${tid("punish-hours")} option`).evaluateAll((os) => os.map((o) => Number(o.value)));
  assert(Math.max(...hours) === 72, "suspensão do moderador até 72 h", hours);
  await M.page.selectOption(tid("punish-type"), "CHAT_MUTE");
  await M.page.selectOption(tid("punish-hours"), "24");
  await M.page.fill(tid("punish-reason"), "Ofensas no chat de todos");
  await shot(M.page, "62-admin-denuncia");
  await M.page.click(tid("report-action"));
  await M.page.waitForSelector(tid("reports-table"), { timeout: T }).catch(() => M.page.waitForSelector(tid("reports-empty"), { timeout: T }));
  const ban = sql(`SELECT type || '|' || round(extract(epoch from ("endsAt" - "startsAt"))/3600) || '|' || "issuedById" FROM "Ban" WHERE "userId" = '${P.userId}'`);
  assert(ban === `CHAT_MUTE|24|${M.userId}`, "silêncio de 24 h aplicado pelo moderador", ban);
  assert(sql(`SELECT status || '|' || "handledById" FROM "Report" WHERE id = 'rep_${P.userId}'`) === `ACTION_TAKEN|${M.userId}`, "denúncia fechada");
  ok("moderador viu o chat gravado, fechou a denúncia e silenciou por 24 h (opções limitadas ao cargo)");

  // 5. Moderador vê o e-mail mascarado.
  await M.page.click(tid("admin-tab-users"));
  await M.page.fill(tid("users-search"), P.name);
  await M.page.click(tid("users-search-btn"));
  await M.page.click(tid(`user-open-${P.name}`));
  await M.page.waitForSelector(tid("user-email"), { timeout: T });
  const masked = await M.page.textContent(tid("user-email"));
  assert(/^ad\*\*\*@teste\.vanta$/.test(masked), "e-mail mascarado para moderador", masked);
  ok(`ficha do jogador para o moderador: e-mail mascarado (${masked})`);

  // 6. Superadmin suspende: a sessão do jogador cai na hora.
  await S.page.reload();
  await S.page.goto(`${BASE}/admin?aba=users&jogador=${P.userId}`);
  await S.page.waitForSelector(tid("user-email"), { timeout: T });
  assert((await S.page.textContent(tid("user-email"))) === P.email, "superadmin vê o e-mail completo");
  await P.page.goto(`${BASE}/menu`);
  await P.page.waitForSelector(tid("open-friends"), { timeout: T });
  await S.page.selectOption(tid("punish-type"), "SUSPENSION");
  await S.page.selectOption(tid("punish-hours"), "168");
  await S.page.fill(tid("punish-reason"), "Reincidência em ofensas");
  const t0 = Date.now();
  await S.page.click(tid("punish-apply"));
  await S.page.waitForSelector(tid("ban-SUSPENSION"), { timeout: T });
  assert((await S.page.textContent(tid("user-status"))).includes("Suspensa"), "conta suspensa na ficha");
  await P.page.waitForURL("**/login", { timeout: 40000 });
  ok(`superadmin suspendeu por 7 dias: o jogador saiu do jogo em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await login(P.page, P.email);
  await P.page.waitForSelector("text=/suspensa até/", { timeout: T });
  ok(`login recusado com o motivo: "${(await P.page.locator("text=/suspensa até/").first().textContent()).trim().slice(0, 90)}…"`);

  // 7. Revoga a suspensão.
  await S.page.click(tid("ban-revoke-SUSPENSION"));
  await S.page.fill(tid("revoke-reason"), "Revisão: punição do moderador já basta");
  await S.page.click(tid("revoke-confirm"));
  await S.page.waitForFunction(() => document.querySelector('[data-testid="user-status"]')?.textContent?.includes("Ativa"), null, { timeout: T });
  await login(P.page, P.email);
  await P.page.waitForURL("**/menu", { timeout: T });
  ok("revogação com motivo: a conta volta e o jogador entra de novo");

  // 8. Cargo: superadmin promove o jogador a moderador.
  await S.page.selectOption(tid("role-select"), "MODERATOR");
  await S.page.fill(tid("role-reason"), "Entrou para a equipe de moderação");
  await S.page.click(tid("role-save"));
  await S.page.waitForFunction(() => document.querySelector('[data-testid="user-name"]')?.textContent?.includes("Moderador"), null, { timeout: T });
  assert(sql(`SELECT role FROM "User" WHERE id = '${P.userId}'`) === "MODERATOR", "cargo gravado");
  sql(`UPDATE "User" SET role = 'PLAYER', "tokenVersion" = "tokenVersion" WHERE id = '${P.userId}'`); // volta a jogador para o resto do teste
  ok("superadmin mudou o cargo (o moderador não tem essa opção)");

  // 9. Auditoria.
  await S.page.click(tid("admin-tab-audit"));
  await S.page.waitForSelector(tid("audit-table"), { timeout: T });
  for (const a of ["audit-ban.create", "audit-report.resolve", "audit-ban.revoke", "audit-role.set", "audit-user.view"]) await S.page.waitForSelector(tid(a), { timeout: T });
  await shot(S.page, "63-admin-auditoria");
  const modActions = actions(M.userId);
  assert(JSON.stringify(modActions.sort()) === JSON.stringify(["ban.create", "report.resolve"]), "ações do moderador", modActions);
  await M.page.click(tid("admin-tab-audit"));
  await M.page.waitForSelector(tid("audit-table"), { timeout: T });
  const modRows = await M.page.locator(`${tid("audit-table")} tbody tr`).count();
  assert(modRows === 2, "moderador vê só as 2 ações dele", { modRows });
  let blocked = false;
  try { sql(`DELETE FROM "AdminAuditLog" WHERE "actorId" = '${M.userId}'`); } catch { blocked = true; }
  assert(blocked && actions(M.userId).length === 2, "o banco recusa apagar o registro");
  ok(`auditoria: superadmin vê tudo (${actions(S.userId).length} ações dele), moderador só as 2 dele; o banco recusa DELETE`);

  // 10. Teclas remapeáveis.
  await P.page.waitForSelector(tid("open-friends"), { timeout: T });
  await P.page.getByRole("button", { name: /Configurações/ }).first().click();
  await P.page.waitForSelector(tid("keybinds"), { timeout: T });
  await P.page.click(tid("bind-jump-0"));
  await P.page.keyboard.press("KeyR");
  const notice = await P.page.textContent(tid("keybind-notice"));
  assert(/R saiu de "Recarregar"/.test(notice), "aviso de tecla tirada de outra ação", notice);
  await P.page.click(tid("keybinds-reset"));
  await P.page.click(tid("bind-forward-0"));
  await P.page.keyboard.press("KeyI");
  assert((await P.page.textContent(tid("bind-forward-0"))).trim() === "I", "frente agora é I");
  await P.page.click(tid("bind-aim-1"));
  await P.page.keyboard.press("Escape");
  assert((await P.page.textContent(tid("bind-aim-1"))).trim() === "—", "Esc cancela sem gravar");
  await shot(P.page, "64-teclas");
  await P.page.waitForTimeout(1500); // envio para a conta (com atraso de 0,8 s)
  const saved = JSON.parse(sql(`SELECT settings::text FROM "UserProfile" WHERE "userId" = '${P.userId}'`));
  assert(JSON.stringify(saved.keybinds?.forward) === JSON.stringify(["KeyI", "ArrowUp"]) && JSON.stringify(saved.keybinds?.jump) === JSON.stringify(["Space"]), "teclas salvas na conta", saved.keybinds);
  ok("teclas: troca com aviso de conflito, Esc cancela, restaurar padrão, frente = I salva na conta");
  await P.page.getByRole("button", { name: "Concluir" }).click();

  // 11. A tecla nova move o personagem no treino; a antiga não.
  await P.page.goto(`${BASE}/treinamento`);
  await P.page.waitForSelector('[data-testid="start-training"]:not([disabled])', { timeout: 60000 });
  await P.page.click('[data-testid="start-training"]');
  await P.page.waitForSelector('[data-testid="hud-health"]', { timeout: 60000 });
  await P.page.waitForTimeout(1200);
  await P.page.evaluate(() => window.__vantaTraining.setDroneEnabled(false));
  const st = () => P.page.evaluate(() => window.__vantaTraining.debugState());
  const z0 = (await st()).pos.z;
  await P.page.keyboard.down("KeyW");
  await P.page.waitForTimeout(1500);
  await P.page.keyboard.up("KeyW");
  const z1 = (await st()).pos.z;
  assert(Math.abs(z1 - z0) < 0.05, "W não deveria mais andar", { z0, z1 });
  const t1 = Date.now();
  await P.page.keyboard.down("KeyI");
  while (Date.now() - t1 < 8000 && (await st()).pos.z - z1 < 1.5) await P.page.waitForTimeout(150);
  await P.page.keyboard.up("KeyI");
  const z2 = (await st()).pos.z;
  assert(z2 - z1 > 1.5, "I deveria andar para frente", { z1, z2 });
  ok(`no treino, W não anda mais e I avança ${(z2 - z1).toFixed(2)} m`);

  // 12. Outro computador: as teclas vêm da conta.
  const other = await newContext("p2");
  await login(other.page, P.email);
  await other.page.waitForURL("**/menu", { timeout: T });
  const local = await other.page.evaluate(() => JSON.parse(localStorage.getItem("vanta.settings") ?? "{}").keybinds?.forward);
  assert(JSON.stringify(local) === JSON.stringify(["KeyI", "ArrowUp"]), "teclas da conta chegam num navegador novo", local);
  await other.ctx.close();
  ok("num navegador novo, ao entrar, as teclas da conta são aplicadas");

  assert(errors.length === 0, "erros de página", errors);
  ok("nenhum erro de página");
  console.log(`\nE2E painel administrativo e teclas: ${step}/${step} etapas OK`);
} catch (e) {
  console.error("✘ falha:", e.message, errors);
  for (const [i, ctx] of browser.contexts().entries()) for (const p of ctx.pages()) await p.screenshot({ path: `${SHOTS ?? "/tmp"}/admin-fail-${i}.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
