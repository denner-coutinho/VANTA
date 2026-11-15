// E2E da Fase 2: joga o modo treinamento num Chromium real (WebGL) e verifica
// movimento, tiro com hitbox, eliminação, recarga, troca de arma, pausa e arsenal.
// Requer: API em :4000 e cliente em :5173 (pnpm dev). Playwright global.
// Uso: node scripts/e2e-training.mjs [--shots dir]
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(`${execSync("npm root -g").toString().trim()}/playwright`);
const BASE = process.env.E2E_BASE ?? "http://localhost:5173";
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);
function assert(cond, msg, extra) {
  if (!cond) {
    console.error(`✘ ${msg}`, extra ?? "");
    process.exit(1);
  }
}

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => localStorage.setItem("vanta.settings", JSON.stringify({ quality: "low", uiVolume: 0, masterVolume: 0 })));
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

try {
  const id = Date.now().toString(36).slice(-6);
  await page.goto(`${BASE}/cadastro`);
  await page.fill('input[name="username"]', `E2E_${id}`);
  await page.fill('input[name="email"]', `e2e_${id}@teste.vanta`);
  await page.fill('input[name="password"]', "SenhaForte123");
  await page.fill('input[name="birthDate"]', "2000-01-01");
  await page.check('input[name="acceptTerms"]');
  await page.click('button[type="submit"]');
  await page.waitForURL("**/menu", { timeout: 30000 });
  ok("conta criada e menu aberto");

  await page.goto(`${BASE}/treinamento`);
  await page.waitForSelector('[data-testid="start-training"]:not([disabled])', { timeout: 60000 });
  await page.click('[data-testid="start-training"]');
  await page.waitForSelector('[data-testid="hud-health"]', { timeout: 60000 });
  await page.waitForTimeout(1200);
  const st = () => page.evaluate(() => window.__vantaTraining.debugState());
  let s = await st();
  assert(!s.paused, "jogo deveria estar rodando após Iniciar", s);
  assert(s.health === 100 && s.ammo === 30, "estado inicial inesperado", s);
  ok("treinamento iniciado (pointer lock, HUD, vida 100, 30 balas)");
  await shot("01-start");

  // Desliga o drone para que o teste seja determinístico.
  await page.evaluate(() => window.__vantaTraining.setDroneEnabled(false));

  // Segura W até andar 1,5 m (no máximo 8 s). Com o renderizador por software o quadro pode passar de 100 ms,
  // e o jogo limita cada quadro a 0,1 s de simulação: o tempo real até 1,5 m varia com a máquina.
  const z0 = s.pos.z;
  const x0 = s.pos.x;
  const t0 = Date.now();
  await page.keyboard.down("KeyW");
  while (Date.now() - t0 < 8000 && (await st()).pos.z - z0 < 1.5) await page.waitForTimeout(150);
  await page.keyboard.up("KeyW");
  s = await st();
  assert(s.pos.z - z0 > 1.5, "W deveria mover o jogador para frente (+z na direção yaw π)", { z0, z: s.pos.z });
  assert(Math.abs(s.pos.x - x0) < 0.3, "W não deveria desviar para o lado", { x0, x: s.pos.x });
  ok(`movimento: avançou ${(s.pos.z - z0).toFixed(2)} m para frente em ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // Atira no alvo à frente até eliminá-lo (rajadas curtas re-mirando: o recuo desloca a mira).
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await page.evaluate(() => window.__vantaTraining.debugAimAt({ x: 5, y: 1.2, z: -13 }));
    await page.mouse.down();
    await page.waitForTimeout(250);
    await page.mouse.up();
    await page.waitForTimeout(150);
    s = await st();
    if (s.stats.kills >= 1) break;
  }
  assert(s.stats.kills >= 1, "deveria eliminar o alvo de treino", s.stats);
  assert(s.stats.hits > 0 && s.stats.damage >= 100, "dano registrado incoerente", s.stats);
  const hudKills = await page.textContent('[data-testid="hud-kills"]');
  assert(Number(hudKills) === s.stats.kills, "HUD de eliminações não bate com o estado", { hudKills });
  ok(`tiro com hitbox: ${s.stats.shots} disparos, ${s.stats.hits} acertos, ${s.stats.headshots} na cabeça, ${s.stats.damage} de dano, alvo eliminado`);
  await shot("02-kill");

  const ammoBefore = s.ammo;
  assert(ammoBefore < 30, "munição deveria ter diminuído", s);
  await page.keyboard.press("KeyR");
  await page.waitForTimeout(400);
  await shot("03-reload");
  await page.waitForFunction(() => window.__vantaTraining.debugState().ammo === 30, null, { timeout: 15000 });
  ok(`recarga: ${ammoBefore} → 30`);

  for (const [key, slot] of [["Digit2", 1], ["Digit3", 2], ["Digit1", 0]]) {
    await page.keyboard.press(key);
    await page.waitForFunction((sl) => window.__vantaTraining.debugState().slot === sl, slot, { timeout: 10000 });
  }
  ok("troca de arma pelas teclas 1/2/3");

  await page.evaluate(() => document.exitPointerLock());
  await page.waitForSelector('[data-testid="pause-menu"]', { timeout: 10000 });
  s = await st();
  assert(s.paused, "simulação deveria pausar ao sair do pointer lock", s);
  const simA = s.simTimeMs;
  await page.waitForTimeout(800);
  assert((await st()).simTimeMs === simA, "simulação não deveria avançar pausada");
  ok("pausa congela a simulação");
  await shot("04-pause");

  await page.getByRole("button", { name: "Trocar arsenal" }).click();
  await page.waitForSelector('[data-testid="loadout"]');
  await page.locator(".loadout-col").nth(0).getByRole("button", { name: /SG-12|Escopeta|Brasa/ }).first().click().catch(async () => {
    // Fallback: escolhe qualquer arma livre no slot 1.
    await page.locator(".loadout-col").nth(0).locator("button.wp:not(.on):not([disabled])").first().click();
  });
  const chosen = await page.locator(".loadout-col").nth(0).locator("button.wp.on strong").textContent();
  await shot("05-loadout");
  await page.getByRole("button", { name: "Confirmar e jogar" }).click();
  await page.waitForFunction(() => !window.__vantaTraining.debugState().paused, null, { timeout: 10000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("vanta.trainingLoadout") ?? "[]"));
  assert(Array.isArray(saved) && saved.length === 3, "arsenal deveria ser salvo", saved);
  const hudName = await page.locator(".hud-weapon").textContent().catch(() => "");
  ok(`arsenal trocado (slot 1: ${chosen?.trim()}) e jogo retomado`);
  if (hudName && chosen && !hudName.toUpperCase().includes(chosen.trim().toUpperCase())) console.warn("  aviso: HUD não mostra a arma escolhida ainda:", hudName);

  assert(errors.length === 0, "erros de página", errors);
  ok("nenhum erro de página");
  console.log(`\nE2E treinamento: ${step}/${step} etapas OK`);
} catch (e) {
  await shot("zz-failure");
  console.error("✘ falha:", e.message, errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
