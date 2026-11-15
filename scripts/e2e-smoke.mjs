/**
 * Teste ponta a ponta (navegador real) do fluxo da Fase 1:
 * boot → login → cadastro (com erros de validação) → menu 3D → perfil → logout → login → recuperação de senha.
 * Pré-requisito: API e cliente rodando (pnpm dev). Uso: node scripts/e2e-smoke.mjs [baseUrl] [pastaScreenshots]
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

// Usa o Playwright do projeto ou, se não houver, o instalado globalmente (npm i -g playwright && npx playwright install chromium).
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require(`${execSync("npm root -g").toString().trim()}/playwright`); }
const { chromium } = pw;

const BASE = process.argv[2] ?? "http://localhost:5173";
const SHOTS = process.argv[3] ?? "docs/screenshots";
const id = Date.now().toString(36).slice(-6);
const user = { username: `Recruta_${id}`, email: `recruta_${id}@teste.vanta`, password: "SenhaForte123" };
const errors = [];

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
// O navegador de CI renderiza WebGL por software (SwiftShader): usa qualidade "medium" para o teste não levar minutos.
await page.addInitScript(() => localStorage.setItem("vanta.settings", JSON.stringify({ quality: "medium", uiVolume: 0 })));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && errors.push(`console: ${m.text()}`));

const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log("ok");
};

try {
  await step("tela de boot carrega e mostra 'Pressione qualquer tecla'", async () => {
    await page.goto(BASE);
    await page.getByText("Pressione qualquer tecla").waitFor();
    await page.waitForSelector(".boot-press.on");
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${SHOTS}/01-boot.png` });
    await page.keyboard.press("Enter");
    await page.waitForURL("**/login");
  });

  await step("login recusa credenciais inválidas", async () => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHOTS}/02-login.png` });
    await page.fill('input[name="identifier"]', `ninguem_${id}@teste.vanta`);
    await page.fill('input[name="password"]', "SenhaErrada123");
    await page.click('button[type="submit"]');
    await page.getByText("E-mail, nome de jogador ou senha incorretos.").waitFor();
  });

  await step("cadastro valida campos no cliente", async () => {
    await page.click('a[href="/cadastro"]');
    await page.waitForURL("**/cadastro");
    await page.fill('input[name="username"]', "a");
    await page.fill('input[name="password"]', "123");
    await page.click('button[type="submit"]');
    await page.getByText("pelo menos 3 caracteres").waitFor();
    await page.getByText("pelo menos 10 caracteres").waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/03-cadastro-validacao.png` });
  });

  await step("cadastro cria conta real e entra no menu", async () => {
    await page.fill('input[name="username"]', user.username);
    await page.fill('input[name="email"]', user.email);
    await page.fill('input[name="password"]', user.password);
    await page.fill('input[name="birthDate"]', "2001-03-15");
    await page.check('input[name="acceptTerms"]');
    await page.click('button[type="submit"]');
    await page.waitForURL("**/menu");
    await page.waitForSelector('.menu-scene[data-ready="true"]', { timeout: 90000, state: "attached" });
    await page.getByText("RAVEN").first().waitFor();
    if ((await page.textContent('[data-testid="wallet-balance"]'))?.trim() !== "0") throw new Error("saldo inicial deveria ser 0");
    if ((await page.textContent('[data-testid="player-level"]'))?.trim() !== "1") throw new Error("nível inicial deveria ser 1");
    await page.waitForTimeout(2500);
    await page.mouse.move(1100, 300);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/04-menu.png` });
  });

  await step("troca de operador persiste no servidor", async () => {
    await page.click('button[aria-label="Próximo operador"]');
    await page.getByRole("heading", { name: "GHOST" }).waitFor();
    await page.click('button[aria-label="Próximo operador"]');
    await page.getByRole("heading", { name: "NOVA" }).waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/05-menu-nova.png` });
    await page.reload();
    await page.waitForSelector('.menu-scene[data-ready="true"]', { timeout: 90000, state: "attached" });
    await page.getByRole("heading", { name: "NOVA" }).waitFor();
  });

  await step("botão de modo ainda não liberado avisa a fase (sem fingir)", async () => {
    await page.click('[data-testid="nav-rooms"]');
    await page.getByText("Fase 7 do roadmap").waitFor();
  });

  await step("perfil mostra dados reais e verificação pendente", async () => {
    await page.click('[data-testid="nav-profile"]');
    await page.getByRole("dialog", { name: "Perfil" }).waitFor();
    await page.getByText(user.email).waitFor();
    await page.getByText("Pendente").waitFor();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/06-perfil.png` });
    await page.click('button[aria-label="Fechar"]');
  });

  await step("logout e novo login por nome de jogador (sessão sobrevive a reload)", async () => {
    await page.click('button[aria-label="Sair"]');
    await page.waitForURL("**/login");
    await page.fill('input[name="identifier"]', user.username);
    await page.fill('input[name="password"]', user.password);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/menu");
    await page.goto(`${BASE}/`);
    await page.waitForSelector(".boot-press.on");
    await page.keyboard.press("Space");
    await page.waitForURL("**/menu");
  });

  await step("recuperação de senha responde sem revelar se o e-mail existe", async () => {
    await page.click('button[aria-label="Sair"]');
    await page.waitForURL("**/login");
    await page.click('a[href="/recuperar-senha"]');
    await page.fill('input[name="email"]', user.email);
    await page.click('button[type="submit"]');
    await page.getByText("Se existir uma conta com este e-mail").waitFor();
    await page.screenshot({ path: `${SHOTS}/07-recuperacao.png` });
  });

  await step("layout responsivo do cadastro em celular", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/cadastro`);
    await page.waitForSelector(".auth-card");
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${SHOTS}/08-cadastro-celular.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error("rolagem horizontal no celular");
  });

  if (errors.length) throw new Error(`Erros no navegador:\n${errors.join("\n")}`);
  console.log("\nE2E Fase 1: todos os passos passaram.");
} catch (e) {
  await page.screenshot({ path: `${SHOTS}/falha.png` }).catch(() => {});
  console.error("\nFALHOU:", e.message, errors.length ? `\n${errors.join("\n")}` : "");
  process.exitCode = 1;
} finally {
  await browser.close();
}
