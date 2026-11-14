// E2E da Fase 3: dois navegadores reais (sessões separadas) entram na fila 1v1,
// jogam no servidor autoritativo, um elimina o outro, o placar sincroniza, um recarrega
// a página (reconexão) e depois abandona (vitória por W.O. registrada).
// Requer: API :4000, servidor de jogo :4100 e cliente :5173 (pnpm dev). Playwright global.
// Uso: node scripts/e2e-multiplayer.mjs [--shots dir]
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
const fail = (msg, extra) => {
  throw new Error(`${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
};
const assert = (c, msg, extra) => c || fail(msg, extra);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];

async function newPlayer(tag) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await ctx.addInitScript(() => localStorage.setItem("vanta.settings", JSON.stringify({ quality: "low", uiVolume: 0, masterVolume: 0, maxFps: 30 })));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  const id = `${tag}${Date.now().toString(36).slice(-5)}`;
  await page.goto(`${BASE}/cadastro`);
  await page.fill('input[name="username"]', `MP_${id}`);
  await page.fill('input[name="email"]', `mp_${id}@teste.vanta`);
  await page.fill('input[name="password"]', "SenhaForte123");
  await page.fill('input[name="birthDate"]', "2000-01-01");
  await page.check('input[name="acceptTerms"]');
  await page.click('button[type="submit"]');
  await page.waitForURL("**/menu", { timeout: 30000 });
  return { page, ctx, name: `MP_${id}` };
}

const st = (p) => p.evaluate(() => window.__vantaMatch?.debugState() ?? null);
const shot = async (p, name) => SHOTS && p.screenshot({ path: `${SHOTS}/${name}.png` });

/** Anda até um ponto segurando W e re-mirando na direção do alvo. */
async function walkTo(p, target, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  await p.keyboard.down("KeyW");
  try {
    while (Date.now() < deadline) {
      const s = await st(p);
      const d = Math.hypot(target.x - s.pos.x, target.z - s.pos.z);
      if (d < 0.6) return s;
      await p.evaluate((t) => window.__vantaMatch.debugAimAt({ x: t.x, y: 1.62, z: t.z }), { x: target.x, z: target.z });
      await sleep(d < 2 ? 60 : 150);
    }
    fail("não chegou ao destino", { target, pos: (await st(p)).pos });
  } finally {
    await p.keyboard.up("KeyW");
  }
}

try {
  const A = await newPlayer("a");
  const B = await newPlayer("b");
  ok("dois jogadores reais cadastrados em sessões separadas");

  for (const P of [A, B]) {
    await P.page.goto(`${BASE}/jogar`);
    await P.page.waitForSelector('[data-testid="net-status"]:has-text("Conectado")', { timeout: 30000 });
    await P.page.click('[data-testid="mode-1v1"]');
  }
  ok("ambos conectados ao servidor de jogo (WebSocket autenticado)");

  await A.page.click('[data-testid="find-match"]');
  await A.page.waitForSelector('[data-testid="queue-status"]:has-text("1 de 2")', { timeout: 10000 });
  await shot(A.page, "01-fila");
  ok("A está na fila: 1 de 2 jogadores (sem bots preenchendo)");

  await B.page.click('[data-testid="find-match"]');
  await Promise.all([A.page.waitForURL("**/partida", { timeout: 15000 }), B.page.waitForURL("**/partida", { timeout: 15000 })]);
  ok("fila completou e os dois entraram na mesma partida");

  for (const P of [A, B]) {
    await P.page.waitForSelector('[data-testid="enter-match"]', { timeout: 90000 });
    await P.page.click('[data-testid="enter-match"]');
  }
  const waitPhase = async (p, phase, ms = 60000) => {
    await p.waitForFunction((ph) => window.__vantaMatch?.debugState().phase === ph, phase, { timeout: ms, polling: 200 });
  };
  await waitPhase(A.page, "live");
  await waitPhase(B.page, "live");
  let sa = await st(A.page);
  let sb = await st(B.page);
  assert(sa.others.length === 1 && sb.others.length === 1, "cada um deveria ver um adversário", { sa: sa.others, sb: sb.others });
  const seenB = sa.others[0].pos;
  assert(Math.hypot(seenB.x - sb.pos.x, seenB.z - sb.pos.z) < 1.5, "A deveria ver B onde B realmente está", { seenB, real: sb.pos });
  ok("round ao vivo: cada cliente vê o outro na posição sincronizada pelo servidor");
  await shot(A.page, "02-round-ao-vivo");

  // Ambos andam até um ponto com linha de visão (calculado sobre a geometria do mapa).
  await Promise.all([walkTo(A.page, { x: 4, z: -14 }), walkTo(B.page, { x: -4, z: 18 })]);
  await sleep(600);
  sa = await st(A.page);
  sb = await st(B.page);
  assert(sa.predictedVsServer !== null && sa.predictedVsServer < 0.6, "predição de A divergiu do servidor", sa);
  const seen = sa.others[0].pos;
  assert(Math.hypot(seen.x - sb.pos.x, seen.z - sb.pos.z) < 1.2, "posição interpolada de B divergiu", { seen, real: sb.pos });
  ok(`movimento com predição: A andou ${Math.hypot(sa.pos.x - 5, sa.pos.z + 24).toFixed(1)} m, erro predição × servidor ${sa.predictedVsServer.toFixed(3)} m`);
  await shot(B.page, "03-b-ve-a");

  // A atira em B mirando onde VÊ B (interpolado) — o servidor compensa a latência.
  const deadline = Date.now() + 45000;
  await A.page.mouse.down({ button: "right" });
  while (Date.now() < deadline) {
    sa = await st(A.page);
    const target = sa.others[0];
    const kills = Object.values(sa.kd).reduce((n, k) => n + k[0], 0);
    if (kills > 0 || sa.phase !== "live" || !target.alive) break;
    await A.page.evaluate((t) => window.__vantaMatch.debugAimAt({ x: t.x, y: t.y + 1.45, z: t.z }), target.pos);
    await A.page.mouse.down();
    await sleep(140);
    await A.page.mouse.up();
    await sleep(160);
    if ((await st(A.page)).ammo === 0) {
      await A.page.keyboard.press("KeyR");
      await sleep(2500);
    }
  }
  await A.page.mouse.up({ button: "right" });
  await shot(A.page, "04-eliminacao");
  await B.page.waitForFunction(() => Object.values(window.__vantaMatch.debugState().kd).some((k) => k[1] === 1), null, { timeout: 10000 });
  sa = await st(A.page);
  sb = await st(B.page);
  const aId = Object.keys(sa.kd).find((id) => sa.kd[id][0] === 1);
  assert(aId, "A deveria ter 1 abate no placar", sa.kd);
  const kill = sb.killLog.at(-1);
  assert(kill && kill.killer === A.name && kill.victim === B.name, "B deveria receber o evento de eliminação (A → B)", sb.killLog);
  ok(`eliminação decidida pelo servidor: B caiu, evento de eliminação (${kill.weapon}${kill.head ? ", headshot" : ""}) e abates sincronizados nos dois clientes`);

  await A.page.waitForFunction(() => window.__vantaMatch.debugState().score.join() !== "0,0", null, { timeout: 10000 });
  sa = await st(A.page);
  sb = await st(B.page);
  assert(sa.score.join() === sb.score.join(), "placar diverge entre clientes", { a: sa.score, b: sb.score });
  ok(`round encerrado por eliminação, placar ${sa.score.join(" × ")} igual nos dois clientes`);
  await shot(B.page, "05-round-perdido");

  // Reconexão: B recarrega a página no meio da partida.
  await B.page.reload();
  await B.page.waitForURL("**/partida", { timeout: 20000 });
  await B.page.waitForFunction(() => !!window.__vantaMatch && window.__vantaMatch.debugState().phase !== null, null, { timeout: 90000, polling: 250 });
  sb = await st(B.page);
  assert(sb.others.length === 1, "B reconectado deveria ver A", sb);
  assert(sb.score.join() === sa.score.join(), "placar após reconexão", { sb: sb.score, sa: sa.score });
  ok("reconexão: B recarregou a página e voltou para a mesma partida com o placar intacto");

  // Abandono: B sai pelo menu e confirma; A vence por W.O.
  await B.page.waitForSelector('[data-testid="match-menu"]', { timeout: 20000 });
  await B.page.getByRole("button", { name: "Abandonar partida" }).click();
  await B.page.click('[data-testid="confirm-leave"]');
  await B.page.waitForURL("**/menu", { timeout: 10000 });
  await A.page.waitForSelector('[data-testid="match-result"]', { timeout: 15000 });
  const result = await A.page.textContent('[data-testid="match-result"]');
  assert(result.includes("Vitória"), "A deveria vencer por W.O.", result);
  await shot(A.page, "06-resultado");
  ok("abandono: B saiu, A recebeu Vitória (W.O.) com estatísticas da partida");

  assert(errors.length === 0, "erros de página", errors);
  ok("nenhum erro de página nos dois navegadores");
  console.log(`\nE2E multiplayer: ${step}/${step} etapas OK`);
} catch (e) {
  console.error("✘ falha:", e.message, errors);
  for (const [i, ctx] of browser.contexts().entries()) for (const p of ctx.pages()) await p.screenshot({ path: `/tmp/claude-0/mp-fail-${i}.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
