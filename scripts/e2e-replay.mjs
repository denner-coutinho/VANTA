// E2E da Fase 7 (parte 4): dois navegadores reais jogam uma 1v1; A elimina B de verdade.
// B vê a kill cam (só A e ele, até o abate); no fim, a apresentação do MVP; A abre o replay
// gravado pelo servidor e usa pausa, busca, velocidade e câmera.
// Requer: API :4000, servidor de jogo :4100 e cliente :5173 (pnpm dev). Playwright global.
// Uso: node scripts/e2e-replay.mjs [--shots dir]
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
async function walkTo(p, target, timeoutMs = 30000, near = 0.6) {
  const deadline = Date.now() + timeoutMs;
  await p.keyboard.down("KeyW");
  try {
    while (Date.now() < deadline) {
      const s = await st(p);
      const d = Math.hypot(target.x - s.pos.x, target.z - s.pos.z);
      if (d < near) return s;
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

  // Ambos andam até um ponto com linha de visão, por caminhos calculados sobre a geometria do mapa
  // da partida (o mapa vem da rotação do servidor).
  const map = MAP_REGISTRY[sa.map];
  const an = new MapAnalyzer(map);
  const nodes = an.explore(map.spawns.A[0]);
  const cp = an.contactPoint(nodes);
  const pathFor = (team) => (team === 0 ? MapAnalyzer.path(nodes, cp.key) : MapAnalyzer.path(nodes, cp.keyB).map((p) => ({ x: -p.x, y: p.y, z: -p.z })));
  const startA = { ...sa.pos };
  const walkPath = async (p, pts) => { for (const [i, pt] of pts.entries()) await walkTo(p, pt, 30000, i === pts.length - 1 ? 0.35 : 0.6); };
  await Promise.all([walkPath(A.page, pathFor(sa.team)), walkPath(B.page, pathFor(sb.team))]);
  await sleep(600);
  sa = await st(A.page);
  sb = await st(B.page);
  assert(sa.predictedVsServer !== null && sa.predictedVsServer < 0.6, "predição de A divergiu do servidor", sa);
  const seen = sa.others[0].pos;
  assert(Math.hypot(seen.x - sb.pos.x, seen.z - sb.pos.z) < 1.2, "posição interpolada de B divergiu", { seen, real: sb.pos });
  ok(`movimento com predição: A andou ${Math.hypot(sa.pos.x - startA.x, sa.pos.z - startA.z).toFixed(1)} m em ${map.name}, erro predição × servidor ${sa.predictedVsServer.toFixed(3)} m`);
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
  // A kill cam de B começa logo: já fica esperando por ela (e tira a captura no meio dela).
  const kcSeen = B.page.waitForSelector('[data-testid="killcam"]', { timeout: 15000 }).then(async () => {
    const text = await B.page.textContent('[data-testid="killcam"]');
    await sleep(900);
    await shot(B.page, "58-killcam");
    return text;
  });
  await B.page.waitForFunction(() => Object.values(window.__vantaMatch.debugState().kd).some((k) => k[1] === 1), null, { timeout: 10000 });
  sa = await st(A.page);
  sb = await st(B.page);
  const aId = Object.keys(sa.kd).find((id) => sa.kd[id][0] === 1);
  assert(aId, "A deveria ter 1 abate no placar", sa.kd);
  const kill = sb.killLog.at(-1);
  assert(kill && kill.killer === A.name && kill.victim === B.name, "B deveria receber o evento de eliminação (A → B)", sb.killLog);
  ok(`eliminação decidida pelo servidor: B caiu, evento de eliminação (${kill.weapon}${kill.head ? ", headshot" : ""}) e abates sincronizados nos dois clientes`);


  // Kill cam: B (eliminado) recebe só A e ele mesmo, e a kill cam toca depois da queda.
  await B.page.waitForFunction(() => window.__vantaMatch.debugState().killcam?.frames > 10, null, { timeout: 10000, polling: 100 });
  sb = await st(B.page);
  const ids = [...sb.killcam.players].sort();
  const aRealId = Object.keys(sb.kd).find((id) => sb.kd[id][0] === 1);
  const bId = Object.keys(sb.kd).find((id) => sb.kd[id][1] === 1);
  assert(ids.length === 2 && ids.includes(aRealId) && ids.includes(bId), "kill cam só com o abatedor e a vítima", { ids, aRealId, bId });
  const kcText = await kcSeen;
  assert(kcText.includes(A.name), "kill cam mostra quem eliminou", kcText);
  ok(`kill cam: B vê os últimos segundos de ${A.name} (${sb.killcam.frames} quadros, só os dois jogadores)`);
  await B.page.waitForFunction(() => !window.__vantaMatch.debugState().killcam?.active, null, { timeout: 10000, polling: 200 });
  ok("a kill cam termina sozinha e volta para a tela de eliminado");

  // B recarrega (sai do modo de mira) e abandona pelo menu da partida.
  await B.page.reload();
  await B.page.waitForFunction(() => !!window.__vantaMatch && window.__vantaMatch.debugState().phase !== null, null, { timeout: 90000, polling: 250 });
  await B.page.waitForSelector('[data-testid="match-menu"]', { timeout: 20000 });
  await B.page.getByRole("button", { name: "Abandonar partida" }).click();
  await B.page.click('[data-testid="confirm-leave"]');
  await B.page.waitForURL("**/menu", { timeout: 10000 });
  await A.page.waitForSelector('[data-testid="match-result"]', { timeout: 15000 });
  await A.page.waitForSelector('[data-testid="mvp-show"]', { timeout: 10000 });
  const mvpName = await A.page.textContent('[data-testid="mvp-name"]');
  assert(mvpName.includes(A.name), "A (1 abate) deveria ser o MVP", mvpName);
  await A.page.waitForSelector('[data-testid="mvp-stage"][data-ready="true"]', { timeout: 15000 });
  await sleep(1500);
  await shot(A.page, "59-mvp");
  ok("fim da partida: apresentação do MVP com o operador animado e os números dele");

  await A.page.click('[data-testid="watch-replay"]');
  await A.page.waitForURL("**/replay/**", { timeout: 10000 });
  await A.page.waitForSelector('[data-testid="replay-bar"]', { timeout: 30000 });
  await A.page.waitForFunction(() => !!window.__vantaReplay?.playbackState(), null, { timeout: 30000 });
  const info = await A.page.evaluate(() => {
    const r = window.__vantaReplay;
    const frames = r.frames;
    const kill = frames.find((f) => f.ev.some((e) => e.k === "kill"));
    return { start: r.startTick, end: r.endTick, n: frames.length, players: frames[0].players.length, killTick: kill?.tick ?? null, matchId: location.pathname.split("/").pop() };
  });
  assert(info.n > 100 && info.players === 2 && info.killTick, "replay com quadros dos dois jogadores e o abate", info);
  const secs = ((info.end - info.start) / 60).toFixed(0);
  ok(`replay baixado e descompactado: ${info.n} quadros (${secs} s), 2 jogadores, com o abate gravado`);

  await A.page.click('[data-testid="replay-play"]');
  const t1 = (await A.page.evaluate(() => window.__vantaReplay.playbackState())).tick;
  await sleep(800);
  const t2 = (await A.page.evaluate(() => window.__vantaReplay.playbackState())).tick;
  assert(t1 === t2, "pausado o relógio não anda", { t1, t2 });
  await A.page.evaluate((k) => window.__vantaReplay.seek(k - 150), info.killTick);
  await A.page.click('[data-testid="replay-speed-2"]');
  await A.page.click('[data-testid="replay-play"]');
  await A.page.waitForSelector(`.feed-row:has-text("${A.name}")`, { timeout: 15000 });
  const t3 = (await A.page.evaluate(() => window.__vantaReplay.playbackState())).tick;
  assert(t3 > info.killTick - 10, "o replay andou até o abate", { t3, kill: info.killTick });
  await A.page.click('[data-testid="replay-free"]');
  await sleep(300);
  await A.page.click(`[data-testid="replay-follow-${A.name}"]`);
  await sleep(1200);
  await shot(A.page, "60-replay");
  ok("controles: pausa congela, busca leva para antes do abate, 2× reproduz e o killfeed do replay mostra a eliminação");

  const status = await B.page.evaluate(async (id) => {
    const token = await fetch("/api/auth/refresh", { method: "POST", credentials: "include", headers: { "X-Vanta-Client": "web" } }).then((r) => r.json()).then((j) => j.accessToken);
    return (await fetch(`/api/matches/${id}/replay`, { headers: { Authorization: `Bearer ${token}` } })).status;
  }, info.matchId);
  assert(status === 200, "B também jogou e pode baixar o replay", status);
  ok("quem jogou a partida (B, mesmo tendo abandonado) também baixa o replay");

  await A.page.click('[data-testid="replay-exit"]');
  await A.page.goto(`${BASE}/jogador/${A.name}`);
  await A.page.waitForSelector(`[data-testid="replay-link-${info.matchId}"]`, { timeout: 15000 });
  ok("o próprio perfil lista a partida com o link de replay");

  assert(errors.length === 0, "erros de página", errors);
  ok("nenhum erro de página nos dois navegadores");
  console.log(`\nE2E replay e kill cam: ${step}/${step} etapas OK`);
} catch (e) {
  console.error("✘ falha:", e.message, errors);
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) console.error("estado:", await p.evaluate(() => { const d = window.__vantaMatch?.debugState(); return d ? JSON.stringify({ kc: d.killcam, alive: d.alive, phase: d.phase }) : null; }).catch((e) => e.message));
  for (const [i, ctx] of browser.contexts().entries()) for (const p of ctx.pages()) await p.screenshot({ path: `${SHOTS ?? "/tmp"}/rp-fail-${i}.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
