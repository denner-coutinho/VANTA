// E2E da Fase 5: dois pares de navegadores reais jogam ranqueadas 1v1 no servidor autoritativo.
//  Partida 1 (contas novas): A × B, B abandona → A vence por W.O. em classificação (patente oculta),
//    B recebe derrota por abandono e bloqueio da fila ranqueada.
//  Partida 2: C já classificado × D na última partida de classificação; D abandona →
//    C ganha PP (valor igual ao gravado no banco), D termina a classificação e a patente aparece;
//    ranking da temporada lista os dois.
// O andamento de classificação de C e D é preparado direto no banco de DESENVOLVIMENTO (fixture de teste,
// marcada abaixo): jogar 5 partidas completas por conta levaria mais de uma hora no renderizador por software.
// Todo o resto (fila, partida, pontos, patente, ranking) passa pelo fluxo real.
// Requer: API :4000, servidor de jogo :4100, cliente :5173, Temporada ativa (pnpm db:seed). Playwright global.
// Uso: node scripts/e2e-ranked.mjs [--shots dir]
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(`${execSync("npm root -g").toString().trim()}/playwright`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { MODES, RANKS, rankForPoints } = await import(pathToFileURL(`${root}/packages/shared/dist/index.js`).href);
const BASE = process.env.E2E_BASE ?? "http://localhost:5173";
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const dbUrl = (process.env.DATABASE_URL ?? readFileSync(`${root}/.env`, "utf8").match(/^DATABASE_URL=(.*)$/m)[1]).replace(/^"|"$/g, "").replace(/\?.*$/, "");
if (/prod/i.test(dbUrl) || process.env.NODE_ENV === "production") throw new Error("e2e-ranked usa fixtures: nunca rode contra produção.");
const sql = (q) => execSync(`psql "${dbUrl}" -At -v ON_ERROR_STOP=1`, { input: q }).toString().trim();

let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);
const fail = (msg, extra) => {
  throw new Error(`${msg}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`);
};
const assert = (c, msg, extra) => c || fail(msg, extra);

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];
const wire = { api: 0, ws: 0, ranked: 0, leaks: [] };

async function newPlayer(tag) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => localStorage.setItem("vanta.settings", JSON.stringify({ quality: "low", uiVolume: 0, masterVolume: 0, maxFps: 30 })));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  const inspect = (kind, body) => {
    wire[kind]++;
    if (body.includes('"ranked_result"')) wire.ranked++;
    if (/mmr|deviation|volatil/i.test(body)) wire.leaks.push(`${tag} ${kind}: ${body.slice(0, 200)}`);
  };
  page.on("response", (r) => { if (r.url().includes("/api/")) r.text().then((b) => inspect("api", b)).catch(() => {}); });
  page.on("websocket", (ws) => { if (ws.url().includes("/game")) ws.on("framereceived", (f) => inspect("ws", String(f.payload))); });
  const id = `${tag}${Date.now().toString(36).slice(-5)}`;
  await page.goto(`${BASE}/cadastro`);
  await page.fill('input[name="username"]', `RK_${id}`);
  await page.fill('input[name="email"]', `rk_${id}@teste.vanta`);
  await page.fill('input[name="password"]', "SenhaForte123");
  await page.fill('input[name="birthDate"]', "2000-01-01");
  await page.check('input[name="acceptTerms"]');
  await page.click('button[type="submit"]');
  await page.waitForURL("**/menu", { timeout: 30000 });
  return { page, ctx, name: `RK_${id}` };
}
const shot = async (p, name) => {
  if (!SHOTS) return;
  await p.waitForTimeout(900); // deixa a animação de entrada terminar
  await p.screenshot({ path: `${SHOTS}/${name}.png` });
};
const text = (p, id) => p.textContent(`[data-testid="${id}"]`);

/** FIXTURE DE TESTE (banco de desenvolvimento): define o andamento de classificação de uma conta de teste. */
function fixtureRating(username, { points, placementLeft, wins, losses }) {
  sql(`INSERT INTO "RankedRating" ("id","userId","seasonId","mode","points","peakPoints","wins","losses","placementLeft","updatedAt")
       SELECT 'e2e_' || md5(random()::text), u."id", s."id", '${MODES["1v1"].db}', ${points}, ${points}, ${wins}, ${losses}, ${placementLeft}, now()
       FROM "User" u, "RankedSeason" s WHERE u."username"='${username}' AND s."isActive" AND s."closedAt" IS NULL
       ON CONFLICT ("userId","seasonId","mode") DO UPDATE SET "points"=EXCLUDED."points","peakPoints"=EXCLUDED."peakPoints","wins"=EXCLUDED."wins","losses"=EXCLUDED."losses","placementLeft"=EXCLUDED."placementLeft";`);
}
const dbRating = (username) => {
  const [points, placementLeft, wins, losses, abandons] = sql(`SELECT r."points", r."placementLeft", r."wins", r."losses", r."abandons" FROM "RankedRating" r JOIN "User" u ON u."id"=r."userId" JOIN "RankedSeason" s ON s."id"=r."seasonId" WHERE u."username"='${username}' AND s."isActive" AND r."mode"='${MODES["1v1"].db}';`).split("|").map(Number);
  return { points, placementLeft, wins, losses, abandons };
};

async function queueRanked(P) {
  await P.page.goto(`${BASE}/jogar`);
  await P.page.waitForSelector('[data-testid="net-status"]:has-text("Conectado")', { timeout: 30000 });
  await P.page.click('[data-testid="mode-1v1"]');
  await P.page.click('[data-testid="queue-ranked"]');
  await P.page.waitForSelector('[data-testid="ranked-info"]');
}

/** Os dois entram na fila ranqueada, caem na mesma partida; `quitter` abandona e `winner` vê o resultado. */
async function playForfeit(winner, quitter) {
  await queueRanked(winner);
  await queueRanked(quitter);
  await winner.page.click('[data-testid="find-match"]');
  await winner.page.waitForSelector('[data-testid="queue-status"]:has-text("ranqueada")', { timeout: 10000 });
  await quitter.page.click('[data-testid="find-match"]');
  await Promise.all([winner.page.waitForURL("**/partida", { timeout: 20000 }), quitter.page.waitForURL("**/partida", { timeout: 20000 })]);
  for (const P of [winner, quitter]) await P.page.waitForSelector('[data-testid="enter-match"]', { timeout: 90000 });
  await quitter.page.getByRole("button", { name: "Abandonar partida" }).click();
  await quitter.page.click('[data-testid="confirm-leave"]');
  await quitter.page.waitForURL("**/menu", { timeout: 10000 });
  await winner.page.waitForSelector('[data-testid="match-result"]', { timeout: 20000 });
  assert((await text(winner.page, "match-result")).includes("Vitória"), "vencedor deveria ver Vitória");
  await winner.page.waitForSelector('[data-testid="ranked-result"]', { timeout: 15000 });
}

try {
  assert(sql(`SELECT count(*) FROM "RankedSeason" WHERE "isActive" AND "closedAt" IS NULL AND "startsAt" <= now() AND "endsAt" > now();`) === "1", "precisa de uma temporada ativa (pnpm db:seed)");
  const [A, B, C, D] = [await newPlayer("a"), await newPlayer("b"), await newPlayer("c"), await newPlayer("d")];
  ok("quatro contas reais cadastradas em sessões separadas");

  // ── Tela Ranqueado antes de jogar ──
  await A.page.click('[data-testid="nav-ranked"]');
  await A.page.waitForURL("**/ranqueado");
  await A.page.waitForSelector('[data-testid="ranked-placement"]');
  assert((await text(A.page, "ranked-placement")).includes("Faltam 5 de 5"), "conta nova deveria ter 5 partidas de classificação", await text(A.page, "ranked-placement"));
  assert((await text(A.page, "season-name")).includes("Temporada"), "nome da temporada");
  assert(!(await A.page.$('[data-testid="ranked-rank"]')), "patente não pode aparecer antes da classificação");
  await shot(A.page, "27-ranqueado-classificacao");
  ok(`tela Ranqueado: ${(await text(A.page, "season-name")).trim()}, conta nova em classificação (5 de 5), patente oculta`);

  // ── Partida 1: contas novas ──
  await playForfeit(A, B);
  const cardA = await text(A.page, "ranked-result");
  assert(cardA.includes("Em classificação") && cardA.includes("Faltam 4"), "A deveria seguir em classificação com 4 restantes", cardA);
  assert(!(await A.page.$('[data-testid="ranked-delta"]')), "PP não aparece durante a classificação");
  const ra = dbRating(A.name);
  const rb = dbRating(B.name);
  assert(ra.wins === 1 && ra.placementLeft === 4, "banco: A com 1 vitória e 4 de classificação", ra);
  assert(rb.losses === 1 && rb.abandons === 1 && rb.placementLeft === 4, "banco: B com derrota por abandono", rb);
  await shot(A.page, "28-resultado-classificacao");
  ok("ranqueada 1v1 real: B abandonou, A venceu por W.O.; servidor gravou vitória/derrota e a classificação andou (4 restantes)");

  // B: bloqueio de fila por abandono, vindo do servidor.
  await B.page.goto(`${BASE}/ranqueado`);
  await B.page.waitForSelector('[data-testid="ranked-cooldown"]', { timeout: 10000 });
  const histB = await text(B.page, "ranked-history");
  assert(histB.includes("Abandono"), "histórico de B deveria mostrar o abandono", histB);
  await queueRanked(B);
  await B.page.waitForSelector('[data-testid="ranked-cooldown"]');
  assert(await B.page.isDisabled('[data-testid="find-match"]'), "botão da fila ranqueada deveria estar bloqueado");
  await shot(B.page, "29-bloqueio-abandono");
  // O servidor recusa mesmo que o cliente force o envio.
  const refused = await B.page.evaluate(() => new Promise((res) => {
    const g = window.__vantaSocket;
    if (!g) return res("sem-socket");
    const off = g.on((m) => { if (m.t === "error") { off(); res(m.code); } });
    g.queue("1v1", ["VK7_LAMINA", "P9_FAISCA", "LR1_HORIZONTE"], true);
    setTimeout(() => res("timeout"), 5000);
  }));
  assert(refused === "RANKED_COOLDOWN", "servidor deveria recusar a fila com RANKED_COOLDOWN", refused);
  await B.page.click('[data-testid="queue-casual"]');
  assert(!(await B.page.isDisabled('[data-testid="find-match"]')), "fila casual segue liberada");
  ok("abandono: B com fila ranqueada bloqueada (tela e servidor recusam), histórico mostra Abandono, casual liberada");

  // ── Partida 2: C classificado × D na última de classificação (fixture de teste) ──
  fixtureRating(C.name, { points: 300, placementLeft: 0, wins: 3, losses: 2 });
  fixtureRating(D.name, { points: 0, placementLeft: 1, wins: 2, losses: 2 });
  await C.page.goto(`${BASE}/ranqueado`);
  await C.page.waitForSelector('[data-testid="ranked-rank"]');
  const rankBefore = (await text(C.page, "ranked-rank")).trim();
  assert(rankBefore === rankForPoints(300).name, "patente de C para 300 PP", rankBefore);
  await playForfeit(C, D);
  const rc = dbRating(C.name);
  const delta = rc.points - 300;
  assert(delta > 0, "C deveria ganhar PP", rc);
  const shown = (await text(C.page, "ranked-delta")).trim();
  assert(shown === `+${delta} PP`, "PP na tela deve ser o que o servidor gravou", { shown, delta });
  const cardC = await text(C.page, "ranked-result");
  assert(cardC.includes(rankForPoints(rc.points).name) && cardC.includes(`${rc.points} PP`), "cartão de C com patente e total", cardC);
  await shot(C.page, "30-resultado-pp");
  ok(`C (classificado) venceu: ${shown}, total ${rc.points} PP, igual ao gravado no banco`);

  const rd = dbRating(D.name);
  assert(rd.placementLeft === 0 && rd.abandons === 1, "D terminou a classificação com abandono", rd);
  await D.page.goto(`${BASE}/ranqueado`);
  await D.page.waitForSelector('[data-testid="ranked-rank"]', { timeout: 10000 });
  const rankD = (await text(D.page, "ranked-rank")).trim();
  assert(rankD === rankForPoints(rd.points).name, "patente revelada de D", { rankD, rd });
  ok(`D terminou a classificação: patente revelada (${rankD}, ${rd.points} PP)`);

  // ── Ranking da temporada ──
  await C.page.click('[data-testid="play-again"]');
  await C.page.goto(`${BASE}/ranqueado`);
  await C.page.waitForSelector('[data-testid="leaderboard"]');
  const board = await text(C.page, "leaderboard");
  assert(board.includes(C.name) && board.includes(D.name), "ranking deveria listar C e D", board);
  assert(!board.includes(A.name) && !board.includes(B.name), "ranking não lista quem ainda está em classificação");
  const pos = await text(C.page, "my-position");
  assert(/\d+º/.test(pos), "posição de C", pos);
  const histC = await text(C.page, "ranked-history");
  assert(histC.includes("Vitória") && histC.includes(`+${delta}`), "histórico de C com a vitória e os PP", histC);
  await shot(C.page, "31-ranqueado-ranking");
  ok(`ranking da temporada: C e D listados, A e B (em classificação) fora; ${pos.trim()}`);

  // ── Menu reflete a patente ──
  // Um menu 3D por vez: com renderização por software, quatro cenas simultâneas travam a aba por dezenas de segundos.
  await A.page.goto(`${BASE}/ranqueado`);
  await A.page.waitForSelector('[data-testid="ranked-placement"]');
  assert((await text(A.page, "ranked-placement")).includes("Faltam 4 de 5"), "A com 4 partidas de classificação restantes", await text(A.page, "ranked-placement"));
  await C.page.goto(`${BASE}/menu`);
  const menuRank = C.page.locator('[data-testid="menu-rank"]'); // o painel lateral some em telas de até 1280 px
  await menuRank.waitFor({ state: "attached", timeout: 90000 });
  assert((await menuRank.textContent({ timeout: 90000 })).includes(`${rc.points} PP`), "menu com os PP de C");
  assert((await C.page.textContent(".player-chip", { timeout: 90000 })).includes(rankForPoints(rc.points).name), "C com patente no cabeçalho");
  await C.page.goto(`${BASE}/ranqueado`);
  await A.page.goto(`${BASE}/menu`);
  await A.page.locator('[data-testid="menu-placement"]').waitFor({ state: "attached", timeout: 90000 });
  assert((await A.page.textContent(".player-chip", { timeout: 90000 })).includes("Sem patente"), "A sem patente no cabeçalho");
  ok("menu principal: C com patente e PP; A sem patente (em classificação, 4 de 5 restantes)");

  // MMR nunca sai do servidor: confere tudo o que os quatro navegadores receberam (API e WebSocket) no teste inteiro.
  assert(wire.api > 20 && wire.ws > 20 && wire.ranked >= 4, "deveria ter capturado respostas da API, mensagens do jogo e resultados ranqueados", { api: wire.api, ws: wire.ws, ranked: wire.ranked });
  assert(wire.leaks.length === 0, "nenhuma resposta ou mensagem pode conter MMR", wire.leaks.slice(0, 3));
  ok(`MMR oculto: ${wire.api} respostas da API e ${wire.ws} mensagens do servidor de jogo inspecionadas, nenhuma expõe o MMR`);

  assert(errors.length === 0, "erros de página", errors);
  ok("nenhum erro de página nos quatro navegadores");
  console.log(`\nE2E ranqueado: ${step}/${step} etapas OK`);
} catch (e) {
  console.error("✘ falha:", e.message, errors);
  for (const [i, ctx] of browser.contexts().entries()) for (const p of ctx.pages()) {
    console.error(i, await p.evaluate(() => [location.pathname, !!document.querySelector('[data-testid="menu-rank"]'), !!document.querySelector('[data-testid="menu-placement"]'), document.querySelector(".player-chip")?.textContent]).catch((e) => e.message));
    await p.screenshot({ path: `/tmp/claude-0/rk-fail-${i}.png` }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}
