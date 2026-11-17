// E2E da Fase 8 (parte 4): verificação em duas etapas com navegador real.
// O script faz o papel do app autenticador (calcula o TOTP a partir da chave mostrada na tela).
// Requer: API :4000 e cliente :5173 (pnpm dev). Playwright global.
// Uso: node scripts/e2e-mfa.mjs [--shots dir]
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { totp } from "./lib/totp.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(`${execSync("npm root -g").toString().trim()}/playwright`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.E2E_BASE ?? "http://localhost:5173";
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const dbUrl = (process.env.DATABASE_URL ?? readFileSync(`${root}/.env`, "utf8").match(/^DATABASE_URL=(.*)$/m)[1]).replace(/^"|"$/g, "").replace(/\?.*$/, "");
const sql = (q) => execSync(`psql "${dbUrl}" -At -v ON_ERROR_STOP=1`, { input: q, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();

let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);
const assert = (c, msg) => {
  if (!c) throw new Error(msg);
};
const T = 20000;
const PASS = "SenhaForte123";
const tid = (id) => `[data-testid="${id}"]`;
const shot = async (p, name) => SHOTS && (await p.waitForTimeout(900), p.screenshot({ path: `${SHOTS}/${name}.png` }));

const browser = await chromium.launch();
const errors = [];
async function ctxPage(tag) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(() => localStorage.setItem("vanta.settings", JSON.stringify({ quality: "low", uiVolume: 0, masterVolume: 0, maxFps: 30 })));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  return { ctx, page };
}
async function loginPassword(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="identifier"]', email);
  await page.fill('input[name="password"]', PASS);
  await page.click('button[type="submit"]');
}

try {
  const { page } = await ctxPage("mod");
  const id = Date.now().toString(36).slice(-6);
  const name = `MF_${id}`;
  const email = `mf_${id}@teste.vanta`;
  await page.goto(`${BASE}/cadastro`);
  await page.fill('input[name="username"]', name);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASS);
  await page.fill('input[name="birthDate"]', "2000-01-01");
  await page.check('input[name="acceptTerms"]');
  await page.click('button[type="submit"]');
  await page.waitForURL("**/menu", { timeout: T });
  const userId = sql(`SELECT id FROM "User" WHERE username = '${name}'`);
  // Como o comando create-admin: cargo novo e tokens antigos invalidados.
  sql(`UPDATE "User" SET role = 'MODERATOR', "tokenVersion" = "tokenVersion" + 1 WHERE id = '${userId}'`);
  await page.reload();
  await page.waitForURL("**/menu", { timeout: T });
  ok("conta real promovida a moderador");

  await page.goto(`${BASE}/admin`);
  await page.waitForSelector(tid("admin-denied"), { timeout: T });
  const denied = (await page.textContent(tid("admin-denied"))).trim();
  assert(/duas etapas/.test(denied), `mensagem do painel: ${denied}`);
  await shot(page, "mfa-1-painel-recusado");
  ok(`painel recusado sem a verificação ("${denied.slice(0, 60)}…")`);

  await page.click(tid("admin-setup-mfa"));
  await page.waitForURL("**/seguranca", { timeout: T });
  await page.waitForSelector(tid("sec-required"), { timeout: T });
  await page.click(tid("sec-start"));
  await page.fill(tid("sec-password"), "SenhaErrada99");
  await page.click(tid("sec-continue"));
  await page.waitForSelector('.alert.error:has-text("Senha incorreta")', { timeout: T });
  await page.fill(tid("sec-password"), PASS);
  await page.click(tid("sec-continue"));
  await page.waitForSelector(tid("sec-qr"), { timeout: T });
  const qrOk = await page.$eval(tid("sec-qr"), (img) => img.complete && img.naturalWidth > 0);
  assert(qrOk, "QR code não carregou");
  const secret = (await page.textContent(tid("sec-secret"))).replace(/\s/g, "");
  assert(/^[A-Z2-7]{32}$/.test(secret), `chave inválida: ${secret}`);
  assert(!sql(`SELECT "totpPendingEnc" FROM "User" WHERE id = '${userId}'`).includes(secret), "segredo pendente em texto no banco");
  await shot(page, "mfa-2-qr-code");
  ok("senha conferida de novo; QR code e chave na tela (no banco, só cifrada)");

  await page.fill(tid("sec-code"), totp(secret, -4));
  await page.click(tid("sec-confirm"));
  await page.waitForSelector('.alert.error:has-text("Código incorreto")', { timeout: T });
  await page.fill(tid("sec-code"), totp(secret));
  await page.click(tid("sec-confirm"));
  await page.waitForSelector(tid("sec-codes"), { timeout: T });
  const codes = await page.$$eval(tid("sec-code-item"), (els) => els.map((e) => e.textContent.trim()));
  assert(codes.length === 10 && codes.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c)), `códigos: ${codes}`);
  await shot(page, "mfa-3-codigos");
  await page.click(tid("sec-codes-done"));
  await page.waitForSelector(`${tid("sec-state")}:has-text("Ligada")`, { timeout: T });
  const enc = sql(`SELECT "totpSecretEnc" FROM "User" WHERE id = '${userId}'`);
  assert(enc.startsWith("v1.") && !enc.includes(secret), "segredo deveria estar cifrado");
  ok("código errado recusado; código certo liga a verificação e mostra 10 códigos de recuperação uma vez");

  await page.goto(`${BASE}/admin`);
  await page.waitForSelector(tid("admin-role"), { timeout: T });
  ok("mesma sessão (já com a segunda etapa) abre o painel");

  // Novo navegador: senha → código do app.
  const b = await ctxPage("login");
  await loginPassword(b.page, email);
  await b.page.waitForSelector(tid("mfa-form"), { timeout: T });
  assert(!b.page.url().includes("/menu"), "não deveria entrar só com a senha");
  await shot(b.page, "mfa-4-login-codigo");
  await b.page.fill(tid("mfa-code"), "000000");
  await b.page.click(tid("mfa-submit"));
  await b.page.waitForSelector('.alert.error:has-text("Código incorreto")', { timeout: T });
  await b.page.fill(tid("mfa-code"), totp(secret, 1));
  await b.page.click(tid("mfa-submit"));
  await b.page.waitForURL("**/menu", { timeout: T });
  await b.page.goto(`${BASE}/admin`);
  await b.page.waitForSelector(tid("admin-role"), { timeout: T });
  ok("login em outro navegador: só a senha não entra; código errado recusado; código do app entra e abre o painel");

  // Sem o celular: código de recuperação.
  const c = await ctxPage("recovery");
  await loginPassword(c.page, email);
  await c.page.waitForSelector(tid("mfa-form"), { timeout: T });
  await c.page.click(tid("mfa-toggle"));
  await c.page.fill(tid("mfa-code"), codes[0]);
  await c.page.click(tid("mfa-submit"));
  await c.page.waitForURL("**/menu", { timeout: T });
  await c.page.goto(`${BASE}/seguranca`);
  await c.page.waitForSelector(`${tid("sec-left")}:has-text("9")`, { timeout: T });
  ok("código de recuperação entra (sobram 9)");

  const d = await ctxPage("reuse");
  await loginPassword(d.page, email);
  await d.page.waitForSelector(tid("mfa-form"), { timeout: T });
  await d.page.click(tid("mfa-toggle"));
  await d.page.fill(tid("mfa-code"), codes[0]);
  await d.page.click(tid("mfa-submit"));
  await d.page.waitForSelector('.alert.error:has-text("Código incorreto")', { timeout: T });
  ok("o mesmo código de recuperação não entra de novo");

  // Desligar: senha + código; o painel volta a recusar.
  await c.page.click(tid("sec-disable"));
  await c.page.fill(tid("sec-password"), PASS);
  await c.page.fill(tid("sec-code"), codes[1]);
  await c.page.click(tid("sec-disable-confirm"));
  await c.page.waitForSelector(`${tid("sec-state")}:has-text("Desligada")`, { timeout: T });
  await c.page.goto(`${BASE}/admin`);
  await c.page.waitForSelector(tid("admin-setup-mfa"), { timeout: T });
  // As outras sessões foram encerradas.
  await b.page.goto(`${BASE}/menu`);
  await b.page.waitForURL("**/login", { timeout: T });
  ok("desligar pede senha e código, encerra as outras sessões e o painel volta a exigir a verificação");

  const events = sql(`SELECT type FROM "SecurityEvent" WHERE "userId" = '${userId}' ORDER BY "createdAt"`).split("\n");
  for (const e of ["MFA_ENABLED", "LOGIN_PASSWORD_OK_MFA_PENDING", "MFA_CODE_FAILED", "LOGIN_SUCCESS_MFA", "MFA_RECOVERY_USED", "MFA_DISABLED"]) assert(events.includes(e), `evento ${e} faltando: ${events}`);
  ok("eventos de segurança gravados (ligar, senha ok, código errado, login com código, recuperação, desligar)");

  assert(errors.length === 0, `erros de script na página: ${errors.join(" | ")}`);
  console.log(`\nE2E da verificação em duas etapas: ${step}/${step} passos ok`);
  await browser.close();
} catch (e) {
  console.error(`✗ ${e.message}`);
  for (const [i, ctx] of browser.contexts().entries()) for (const p of ctx.pages()) await p.screenshot({ path: `${SHOTS ?? "/tmp/claude-0"}/mfa-fail-${i}.png` }).catch(() => {});
  await browser.close();
  process.exit(1);
}
