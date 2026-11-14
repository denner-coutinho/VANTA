// E2E da Fase 4: dois navegadores reais jogam 5 partidas 1v1 seguidas no servidor autoritativo,
// uma em cada mapa da rotação. Em cada partida:
//   • cada jogador usa um operador diferente (os 8 aparecem ao longo do teste, escolhidos no menu);
//   • os dois andam (correndo e andando) por caminhos calculados sobre a geometria real do mapa
//     (MapAnalyzer, mesma física do jogo) até um ponto com linha de visão;
//   • o "movedor" agacha, pula, atira e recarrega; o "atirador" o elimina;
//   • o atirador confirma que viu o modelo certo e todas as animações (idle, walk, run, crouch,
//     jump, shoot, reload, die) no avatar do adversário, alimentadas pelo snapshot do servidor;
//   • o movedor abandona e o atirador recebe a vitória (W.O.).
// Requer: API :4000, servidor de jogo :4100 (rotação padrão dos 5 mapas) e cliente :5173.
// Uso: node scripts/e2e-maps.mjs [--shots dir]
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(`${execSync("npm root -g").toString().trim()}/playwright`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { MAP_REGISTRY, MapAnalyzer } = await import(pathToFileURL(`${root}/packages/shared/dist/index.js`).href);
const BASE = process.env.E2E_BASE ?? "http://localhost:5173";
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const CODES = ["RAVEN", "GHOST", "NOVA", "TITAN", "ZERO", "VIPER", "ECHO", "ORION"];
const MATCHES = Number(process.env.E2E_MATCHES ?? 5);

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
  await page.fill('input[name="username"]', `MAP_${id}`);
  await page.fill('input[name="email"]', `map_${id}@teste.vanta`);
  await page.fill('input[name="password"]', "SenhaForte123");
  await page.fill('input[name="birthDate"]', "2000-01-01");
  await page.check('input[name="acceptTerms"]');
  await page.click('button[type="submit"]');
  await page.waitForURL("**/menu", { timeout: 30000 });
  return { page, ctx, tag, name: `MAP_${id}` };
}

const st = (p) => p.evaluate(() => window.__vantaMatch?.debugState() ?? null);
const shot = async (p, name) => SHOTS && p.screenshot({ path: `${SHOTS}/${name}.png` });

/** Escolhe o operador no menu (setas ‹ ›) e espera o modelo 3D correspondente na cena. */
async function pickCharacter(P, code) {
  await P.page.waitForSelector(".operator-card h2", { timeout: 15000 }).catch(async () => {
    await P.page.reload(); // a lista de operadores vem da API; tenta de novo uma vez
    await P.page.waitForSelector(".operator-card h2", { timeout: 15000 });
  });
  for (let i = 0; i < 9; i++) {
    const cur = (await P.page.textContent(".operator-card h2"))?.trim();
    if (cur === code) break;
    await P.page.click('button[aria-label="Próximo operador"]');
    await sleep(250);
  }
  assert((await P.page.textContent(".operator-card h2"))?.trim() === code, `não conseguiu escolher ${code}`);
  await P.page.waitForFunction((c) => document.querySelector("[data-character]")?.getAttribute("data-character") === c, code, { timeout: 10000 });
  await sleep(600); // POST /me/character
}

/** Anda pelos pontos do caminho segurando W (e Shift se `sprint`), re-mirando a cada passo. */
async function walkPath(p, points, { sprint = false, timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  await p.keyboard.down("KeyW");
  if (sprint) await p.keyboard.down("ShiftLeft");
  try {
    for (const [i, target] of points.entries()) {
      const near = i === points.length - 1 ? 0.35 : 0.7;
      for (;;) {
        if (Date.now() > deadline) fail("não chegou ao destino", { target, pos: (await st(p)).pos });
        const s = await st(p);
        if (s.phase !== "live") fail("round terminou durante a caminhada", { phase: s.phase });
        const d = Math.hypot(target.x - s.pos.x, target.z - s.pos.z);
        if (d < near) break;
        await p.evaluate((t) => window.__vantaMatch.debugAimAt({ x: t.x, y: t.y + 1.62, z: t.z }), target);
        await sleep(d < 2 ? 50 : 120);
      }
    }
  } finally {
    if (sprint) await p.keyboard.up("ShiftLeft");
    await p.keyboard.up("KeyW");
  }
}

const mirror = (pts) => pts.map((p) => ({ x: -p.x, y: p.y, z: -p.z }));

try {
  const A = await newPlayer("a");
  const B = await newPlayer("b");
  ok("dois jogadores reais cadastrados em sessões separadas");

  const mapsPlayed = [];
  const charactersSeen = new Set();
  for (let m = 0; m < MATCHES; m++) {
    // Alterna os papéis para que os dois lados exercitem as duas funções.
    const [shooter, mover] = m % 2 === 0 ? [A, B] : [B, A];
    const codeS = CODES[(2 * m) % 8];
    const codeM = CODES[(2 * m + 1) % 8];
    await pickCharacter(shooter, codeS);
    await pickCharacter(mover, codeM);
    if (m === 0) await shot(mover.page, "menu-operador");

    for (const P of [shooter, mover]) {
      await P.page.goto(`${BASE}/jogar`);
      await P.page.waitForSelector('[data-testid="net-status"]:has-text("Conectado")', { timeout: 30000 });
      await P.page.click('[data-testid="mode-1v1"]');
    }
    await shooter.page.click('[data-testid="find-match"]');
    await shooter.page.waitForSelector('[data-testid="queue-status"]:has-text("1 de 2")', { timeout: 10000 });
    await mover.page.click('[data-testid="find-match"]');
    await Promise.all([shooter.page.waitForURL("**/partida", { timeout: 15000 }), mover.page.waitForURL("**/partida", { timeout: 15000 })]);
    for (const P of [shooter, mover]) {
      await P.page.waitForSelector('[data-testid="enter-match"]', { timeout: 90000 });
      await P.page.click('[data-testid="enter-match"]');
    }
    for (const P of [shooter, mover]) await P.page.waitForFunction(() => window.__vantaMatch?.debugState().phase === "live", null, { timeout: 60000, polling: 200 });

    let ss = await st(shooter.page);
    let sm = await st(mover.page);
    const mapCode = ss.map;
    assert(MAP_REGISTRY[mapCode], "mapa desconhecido", ss.map);
    assert(sm.map === mapCode, "os dois clientes deveriam estar no mesmo mapa", { a: ss.map, b: sm.map });
    assert(ss.others[0].character === codeM && sm.others[0].character === codeS, "cada um deveria ver o operador escolhido pelo outro", { s: ss.others[0].character, m: sm.others[0].character, codeS, codeM });
    charactersSeen.add(codeS).add(codeM);
    mapsPlayed.push(mapCode);

    // Registro contínuo das animações que o atirador vê no avatar do adversário.
    await shooter.page.evaluate(() => {
      window.__animSeen = new Set();
      window.__animTimer = setInterval(() => {
        const o = window.__vantaMatch?.debugState().others[0];
        if (!o) return;
        window.__animSeen.add(o.anim);
        if (o.overlays.reloading) window.__animSeen.add("reload");
        if (o.overlays.shooting) window.__animSeen.add("shoot");
      }, 40);
    });

    // Caminhos calculados sobre a geometria do mapa (BFS validado pela física real do jogo).
    const map = MAP_REGISTRY[mapCode];
    const an = new MapAnalyzer(map);
    const nodes = an.explore(map.spawns.A[0]);
    const cp = an.contactPoint(nodes);
    assert(cp, "mapa sem ponto de contato", mapCode);
    const pathA = MapAnalyzer.path(nodes, cp.key);
    const pathB = mirror(MapAnalyzer.path(nodes, cp.keyB));
    const pathOf = (team) => (team === 0 ? pathA : pathB);
    const mPath = pathOf(sm.team);
    const half = Math.max(1, Math.floor(mPath.length / 2));
    await Promise.all([
      walkPath(shooter.page, pathOf(ss.team)),
      (async () => {
        await walkPath(mover.page, mPath.slice(0, half), { sprint: true });
        await walkPath(mover.page, mPath.slice(half));
      })(),
    ]);
    await sleep(500);
    ss = await st(shooter.page);
    sm = await st(mover.page);
    assert(an.lineOfSight(ss.pos, sm.pos), "deveriam ter linha de visão no ponto de contato", { s: ss.pos, m: sm.pos });
    assert(ss.predictedVsServer !== null && ss.predictedVsServer < 0.6, "predição divergiu do servidor", ss.predictedVsServer);

    // Movedor: agacha, pula, atira para o alto e recarrega.
    await mover.page.keyboard.down("KeyC");
    await sleep(900);
    await mover.page.keyboard.up("KeyC");
    await sleep(500);
    await mover.page.keyboard.press("Space");
    await sleep(900);
    await mover.page.evaluate((p) => window.__vantaMatch.debugAimAt({ x: p.x, y: p.y + 40, z: p.z }), ss.pos);
    const ammoBefore = (await st(mover.page)).ammo;
    for (let i = 0; i < 3; i++) {
      await mover.page.mouse.down();
      await sleep(250); // > 2 quadros a ~10 FPS (renderização por software)
      await mover.page.mouse.up();
      await sleep(220);
    }
    const afterShots = await st(mover.page);
    assert(afterShots.ammo < ammoBefore, "os disparos do movedor deveriam gastar munição", { ammoBefore, after: afterShots.ammo });
    await mover.page.keyboard.press("KeyR");
    await sleep(1200);
    // Capturas: cada um olhando para o outro (operador do adversário no mapa).
    ss = await st(shooter.page);
    sm = await st(mover.page);
    await shooter.page.evaluate((t) => window.__vantaMatch.debugAimAt({ x: t.x, y: t.y + 1.2, z: t.z }), ss.others[0].pos);
    await mover.page.evaluate((t) => window.__vantaMatch.debugAimAt({ x: t.x, y: t.y + 1.2, z: t.z }), sm.others[0].pos);
    await sleep(500);
    await shot(shooter.page, `mapa-${m + 1}-${mapCode.toLowerCase()}`);
    await shot(mover.page, `mapa-${m + 1}-${mapCode.toLowerCase()}-b`);

    // Atirador elimina o movedor mirando onde o vê (interpolado); o servidor decide o acerto.
    const deadline = Date.now() + 45000;
    await shooter.page.mouse.down({ button: "right" });
    while (Date.now() < deadline) {
      ss = await st(shooter.page);
      const target = ss.others[0];
      const kills = Object.values(ss.kd).reduce((n, k) => n + k[0], 0);
      if (kills > 0 || ss.phase !== "live" || !target.alive) break;
      await shooter.page.evaluate((t) => window.__vantaMatch.debugAimAt({ x: t.x, y: t.y + 1.3, z: t.z }), target.pos);
      await shooter.page.mouse.down();
      await sleep(140);
      await shooter.page.mouse.up();
      await sleep(160);
      if ((await st(shooter.page)).ammo === 0) {
        await shooter.page.keyboard.press("KeyR");
        await sleep(2500);
      }
    }
    await shooter.page.mouse.up({ button: "right" });
    await sleep(1500); // deixa a animação de queda rodar
    ss = await st(shooter.page);
    assert(Object.values(ss.kd).some((k) => k[0] === 1), "o atirador deveria ter eliminado o movedor", ss.kd);
    const seen = await shooter.page.evaluate(() => {
      clearInterval(window.__animTimer);
      return [...window.__animSeen];
    });
    const need = ["idle", "walk", "run", "crouch", "jump", "shoot", "reload", "die"];
    const missing = need.filter((a) => !seen.includes(a));
    assert(missing.length === 0, "animações não observadas no adversário", { missing, seen });
    if (m === 0) await shot(shooter.page, "queda");

    // Encerra: movedor abandona, atirador vence por W.O. e volta ao menu.
    // Sair do pointer lock (equivale ao Esc do jogador) abre o menu da partida.
    await mover.page.evaluate(() => document.exitPointerLock());
    await mover.page.waitForSelector('[data-testid="match-menu"]', { timeout: 20000 });
    await mover.page.getByRole("button", { name: "Abandonar partida" }).click();
    await mover.page.click('[data-testid="confirm-leave"]');
    await mover.page.waitForURL("**/menu", { timeout: 10000 });
    await shooter.page.waitForSelector('[data-testid="match-result"]', { timeout: 15000 });
    const result = await shooter.page.textContent('[data-testid="match-result"]');
    assert(result.includes("Vitória"), "o atirador deveria vencer por W.O.", result);
    const label = await shooter.page.textContent(".result-head .label");
    assert(label.includes(map.name), "o resultado deveria mostrar o nome do mapa", label);
    await shooter.page.getByRole("button", { name: "Menu" }).click();
    await shooter.page.waitForURL("**/menu", { timeout: 10000 });
    ok(`partida ${m + 1} em ${map.name}: ${codeS} × ${codeM}, caminhos de ${pathOf(0).length} e ${pathOf(1).length} nós até contato a ${cp.range.toFixed(0)} m, eliminação, animações vistas: ${need.join(", ")}`);
  }

  const distinct = new Set(mapsPlayed);
  assert(distinct.size === Math.min(MATCHES, 5), "a rotação deveria passar por mapas diferentes a cada partida", mapsPlayed);
  ok(`rotação de mapas: ${mapsPlayed.join(" → ")}`);
  if (MATCHES >= 4) assert(charactersSeen.size === 8, "os 8 operadores deveriam aparecer", [...charactersSeen]);
  ok(`operadores usados em partida: ${[...charactersSeen].join(", ")}`);

  assert(errors.length === 0, "erros de página", errors);
  ok("nenhum erro de página nos dois navegadores");
  console.log(`\nE2E mapas: ${step}/${step} etapas OK`);
} catch (e) {
  console.error("✘ falha:", e.message, errors);
  for (const [i, ctx] of browser.contexts().entries()) for (const p of ctx.pages()) await p.screenshot({ path: `/tmp/claude-0/maps-fail-${i}.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
