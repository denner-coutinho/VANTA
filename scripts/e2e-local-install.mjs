// E2E da instalação local de teste (installer/vanta.sh ou o instalador do Windows).
// Roda contra o build de produção que o instalador sobe: sem ganchos de depuração do modo dev.
// Confere: cadastro, sessão que sobrevive à recarga em http (inclusive pelo IP da rede local),
// temporada ranqueada ativa, fila 1v1 entre dois jogadores reais e a partida abrindo nos dois.
// Uso: E2E_BASE=http://localhost:8080 [E2E_LAN=http://192.168.0.10:8080] node scripts/e2e-local-install.mjs [--shots dir]
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`); }
const { chromium } = playwright;
const BASE = process.env.E2E_BASE ?? "http://localhost:8080";
const LAN = process.env.E2E_LAN || BASE;
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);
const shot = async (p, name) => SHOTS && p.screenshot({ path: `${SHOTS}/${name}.png` });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];

async function newPlayer(tag, base) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await ctx.addInitScript(() => localStorage.setItem("vanta.settings", JSON.stringify({ quality: "low", uiVolume: 0, masterVolume: 0, maxFps: 30 })));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  const id = `${tag}${Date.now().toString(36).slice(-5)}`;
  await page.goto(`${base}/cadastro`);
  await page.fill('input[name="username"]', `LI_${id}`);
  await page.fill('input[name="email"]', `li_${id}@teste.vanta`);
  await page.fill('input[name="password"]', "SenhaForte123");
  await page.fill('input[name="birthDate"]', "2000-01-01");
  await page.check('input[name="acceptTerms"]');
  await page.click('button[type="submit"]');
  await page.waitForURL("**/menu", { timeout: 30000 });
  return { page, ctx, base };
}

let failed = false;
try {
  const A = await newPlayer("a", LAN);
  const B = await newPlayer("b", BASE);
  ok(`dois jogadores cadastrados (A por ${LAN}, B por ${BASE})`);

  await A.page.reload();
  await A.page.waitForURL("**/menu", { timeout: 30000 });
  await A.page.waitForSelector('[data-testid="conn-status"][data-state="online"]', { timeout: 30000 });
  ok("A recarregou a página e continuou logado (cookie de sessão funciona em http)");

  await B.page.goto(`${BASE}/ranqueado`);
  // Seletor em vez de waitForFunction: a CSP do build de produção (script-src 'self') barra o eval
  // que algumas versões do Playwright usam para avaliar funções na página.
  await B.page.waitForSelector('[data-testid="season-name"]:not(:empty)', { timeout: 20000 });
  const season = await B.page.textContent('[data-testid="season-name"]');
  if (!season || !season.includes("Ignição")) throw new Error(`temporada não está ativa: "${season}"`);
  ok(`ranqueado com temporada ativa: ${season.trim()}`);

  for (const P of [A, B]) {
    await P.page.goto(`${P.base}/jogar`);
    await P.page.waitForSelector('[data-testid="net-status"]:has-text("Conectado")', { timeout: 30000 });
    await P.page.click('[data-testid="mode-1v1"]');
  }
  ok("os dois conectados ao servidor de jogo");

  await A.page.click('[data-testid="find-match"]');
  await A.page.waitForSelector('[data-testid="queue-status"]:has-text("1 de 2")', { timeout: 10000 });
  await B.page.click('[data-testid="find-match"]');
  await Promise.all([A.page.waitForURL("**/partida", { timeout: 20000 }), B.page.waitForURL("**/partida", { timeout: 20000 })]);
  ok("fila 1v1 juntou os dois jogadores reais na mesma partida");

  for (const P of [A, B]) {
    await P.page.waitForSelector('[data-testid="enter-match"]', { timeout: 90000 });
    await P.page.click('[data-testid="enter-match"]');
  }
  for (const P of [A, B]) await P.page.waitForSelector('[data-testid="hud-health"]', { timeout: 90000 });
  const hp = await A.page.textContent('[data-testid="hud-health"]');
  if (hp?.trim() !== "100") throw new Error(`vida inicial inesperada: ${hp}`);
  await B.page.waitForTimeout(3000);
  await shot(B.page, "partida");
  ok("partida aberta nos dois navegadores, HUD com 100 de vida");

  if (errors.length) throw new Error(`erros de página: ${errors.join(" | ")}`);
  console.log("\nINSTALAÇÃO LOCAL OK");
} catch (e) {
  failed = true;
  console.error(`✘ falha: ${e.message}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
