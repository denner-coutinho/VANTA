// E2E da Fase 6: economia de ponta a ponta em navegadores reais.
//  1. Conta nova: saldo 0, loja lista as skins, compra bloqueada por saldo.
//  2. Saldo inicial por AJUSTE ADMINISTRATIVO (rota real, auditada). A conta de admin é promovida pelo
//     comando de servidor `create-admin`. Não há compra de VC simulada.
//  3. Compra de skin de operador e de arma, saldo na tela igual ao do banco, equipar, menu 3D com a skin.
//  4. Inventário, desequipar, servidor recusa compra repetida e preço adulterado.
//  5. Aba VANTA COINS: sem chaves da Stripe o servidor informa pagamentos desativados e nada é simulado.
//  6. Partida 1v1 real: o adversário recebe a skin do operador e a sua arma usa a skin equipada.
// Requer: API :4000, servidor de jogo :4100, cliente :5173. Playwright global.
// Uso: node scripts/e2e-economy.mjs [--shots dir]
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
if (/prod/i.test(dbUrl) || process.env.NODE_ENV === "production") throw new Error("e2e-economy usa fixtures: nunca rode contra produção.");
const sql = (q) => execSync(`psql "${dbUrl}" -At -v ON_ERROR_STOP=1`, { input: q }).toString().trim();

let step = 0;
const ok = (msg) => console.log(`✔ ${++step}. ${msg}`);
const fail = (msg, extra) => {
  throw new Error(`${msg}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`);
};
const assert = (c, msg, extra) => c || fail(msg, extra);
const num = (s) => Number(String(s).replace(/\D/g, ""));

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];

async function newPlayer(tag) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => localStorage.setItem("vanta.settings", JSON.stringify({ quality: "low", uiVolume: 0, masterVolume: 0, maxFps: 30 })));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  const id = `${tag}${Date.now().toString(36).slice(-5)}`;
  await page.goto(`${BASE}/cadastro`);
  await page.fill('input[name="username"]', `EC_${id}`);
  await page.fill('input[name="email"]', `ec_${id}@teste.vanta`);
  await page.fill('input[name="password"]', "SenhaForte123");
  await page.fill('input[name="birthDate"]', "2000-01-01");
  await page.check('input[name="acceptTerms"]');
  await page.click('button[type="submit"]');
  await page.waitForURL("**/menu", { timeout: 30000 });
  return { page, ctx, name: `EC_${id}` };
}
const shot = async (p, name) => {
  if (!SHOTS) return;
  await p.waitForTimeout(900);
  await p.evaluate(() => document.querySelector(".play-screen")?.scrollTo(0, 0));
  await p.screenshot({ path: `${SHOTS}/${name}.png` });
};
const text = (p, id) => p.textContent(`[data-testid="${id}"]`);
const dbBalance = (username) => Number(sql(`SELECT coalesce(w."balance",0) FROM "User" u LEFT JOIN "Wallet" w ON w."userId"=u."id" WHERE u."username"='${username}';`) || 0);
/** Chamada autenticada feita pelo próprio navegador (token renovado pelo cookie httpOnly). */
const apiCall = (p, method, url, body) =>
  p.evaluate(async ({ method, url, body }) => {
    const t = await (await fetch("/api/auth/refresh", { method: "POST", credentials: "include", headers: { "X-Vanta-Client": "web" } })).json();
    const r = await fetch(`/api${url}`, { method, credentials: "include", headers: { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { method, url, body });

try {
  const A = await newPlayer("a");
  const ADM = await newPlayer("adm");
  ok("conta de jogador e conta de administrador cadastradas");

  // ── 1. Loja sem saldo ──
  assert(num(await text(A.page, "wallet-balance")) === 0, "conta nova deveria ter 0 VC");
  await A.page.click('[data-testid="nav-store"]');
  await A.page.waitForURL("**/loja");
  await A.page.waitForSelector('[data-testid="item-grid"] .item-card');
  const weaponCards = await A.page.$$eval('[data-testid="item-grid"] .item-card', (els) => els.length);
  await A.page.click('[data-testid="store-tab-operators"]');
  await A.page.waitForSelector('[data-testid="item-CS_RAVEN_NOTURNO"]');
  const opCards = await A.page.$$eval('[data-testid="item-grid"] .item-card', (els) => els.length);
  await A.page.click('[data-testid="item-CS_RAVEN_NOTURNO"]');
  await A.page.waitForSelector('[data-testid="cosmetic-preview"][data-ready="true"]', { timeout: 60000 });
  assert(await A.page.isDisabled('[data-testid="buy-item"]'), "compra deveria estar bloqueada sem saldo");
  ok(`loja: ${weaponCards} skins de arma e ${opCards} de operador, prévia 3D carregada, compra bloqueada com saldo 0`);

  // ── 2. Saldo por ajuste administrativo (rota real, auditada) ──
  // Promove a conta pelo mesmo comando de servidor que o README indica (não existe rota HTTP para isso).
  const admEmail = sql(`SELECT "email" FROM "User" WHERE "username"='${ADM.name}';`);
  execSync(`pnpm --silent --filter @vanta/server create-admin ${admEmail} ADMIN`, { cwd: root, stdio: "pipe" });
  assert(sql(`SELECT "role" FROM "User" WHERE "username"='${ADM.name}';`) === "ADMIN", "create-admin deveria promover a conta");
  // A promoção invalida os tokens de acesso emitidos antes (tokenVersion); a página renova pelo refresh.
  await ADM.page.reload();
  await ADM.page.waitForURL("**/menu", { timeout: 30000 });
  // Admin só usa rotas da equipe com a verificação em duas etapas.
  await enableMfaUi(ADM.page, BASE, "SenhaForte123");
  const aId = sql(`SELECT "id" FROM "User" WHERE "username"='${A.name}';`);
  const asPlayer = await apiCall(A.page, "POST", "/admin/wallet/adjust", { userId: aId, amount: 5000, reason: "teste e2e", requestId: crypto.randomUUID() });
  assert(asPlayer.status === 403, "jogador comum não pode ajustar saldo", asPlayer);
  const adj = await apiCall(ADM.page, "POST", "/admin/wallet/adjust", { userId: aId, amount: 3000, reason: "saldo inicial do teste e2e", requestId: crypto.randomUUID() });
  assert(adj.status === 200 && adj.body.balance === 3000, "ajuste do admin", adj);
  assert(sql(`SELECT count(*) FROM "AdminAuditLog" WHERE "action"='wallet.adjust' AND "targetId"='${aId}';`) === "1", "ajuste deveria ficar auditado");
  ok("saldo inicial de 3.000 VC por ajuste administrativo auditado (jogador comum recebe 403)");

  // ── 3. Compras ──
  await A.page.reload();
  await A.page.click('[data-testid="store-tab-operators"]');
  await A.page.click('[data-testid="item-CS_RAVEN_NOTURNO"]');
  await A.page.waitForSelector('[data-testid="store-balance"]:has-text("3.000")');
  await A.page.click('[data-testid="buy-item"]');
  await A.page.waitForSelector('[data-testid="confirm-purchase"]');
  await shot(A.page, "32-loja-confirmar");
  await A.page.click('[data-testid="confirm-buy"]');
  await A.page.waitForSelector('[data-testid="equip-item"]', { timeout: 15000 });
  const raven = Number(sql(`SELECT "priceVc" FROM "StoreItem" WHERE "code"='CS_RAVEN_NOTURNO';`));
  const afterOp = num(await text(A.page, "store-balance"));
  assert(afterOp === 3000 - raven && dbBalance(A.name) === afterOp, "saldo após comprar skin de operador", { afterOp, db: dbBalance(A.name), raven });
  await A.page.click('[data-testid="equip-item"]');
  await A.page.waitForSelector('[data-testid="equip-item"]:has-text("Desequipar")');
  await A.page.waitForSelector('[data-testid="cosmetic-preview"][data-ready="true"]', { timeout: 60000 });
  await shot(A.page, "33-loja-operador");

  await A.page.click('[data-testid="store-tab-weapons"]');
  await A.page.click('[data-testid="item-WS_VK7_CIRCUITO"]');
  await A.page.waitForSelector('[data-testid="cosmetic-preview"][data-ready="true"]', { timeout: 60000 });
  await A.page.click('[data-testid="buy-item"]');
  await A.page.click('[data-testid="confirm-buy"]');
  await A.page.waitForSelector('[data-testid="equip-item"]', { timeout: 15000 });
  await A.page.click('[data-testid="equip-item"]');
  await A.page.waitForSelector('[data-testid="equip-item"]:has-text("Desequipar")');
  const vk = Number(sql(`SELECT "priceVc" FROM "StoreItem" WHERE "code"='WS_VK7_CIRCUITO';`));
  const afterW = num(await text(A.page, "store-balance"));
  assert(afterW === 3000 - raven - vk && dbBalance(A.name) === afterW, "saldo após comprar skin de arma", { afterW, db: dbBalance(A.name) });
  const ledger = Number(sql(`SELECT coalesce(sum(t."amount"),0) FROM "WalletTransaction" t JOIN "User" u ON u."id"=t."walletUserId" WHERE u."username"='${A.name}';`));
  assert(ledger === afterW, "razão contábil deveria somar o saldo", { ledger, afterW });
  await shot(A.page, "34-loja-arma");
  ok(`compras: operador (${raven} VC) e arma (${vk} VC) debitados; tela = banco = soma do razão (${afterW} VC); itens equipados`);

  // Servidor recusa compra repetida e ignora preço enviado pelo cliente.
  const vkId = sql(`SELECT "id" FROM "StoreItem" WHERE "code"='WS_VK7_CIRCUITO';`);
  const again = await apiCall(A.page, "POST", "/store/purchase", { itemId: vkId });
  assert(again.status === 409 && again.body.error.code === "ALREADY_OWNED", "compra repetida", again);
  const cheapId = sql(`SELECT "id" FROM "StoreItem" WHERE "code"='WS_DX50_GELO';`);
  const cheapPrice = Number(sql(`SELECT "priceVc" FROM "StoreItem" WHERE "code"='WS_DX50_GELO';`));
  const forged = await apiCall(A.page, "POST", "/store/purchase", { itemId: cheapId, priceVc: 1, balance: 999999 });
  assert(forged.status === 200 && forged.body.balance === afterW - cheapPrice, "preço vem do banco", forged);
  ok(`servidor recusa compra repetida (409) e cobra o preço do banco mesmo com preço/saldo adulterados (${cheapPrice} VC)`);

  // ── Menu 3D com a skin ──
  await A.page.goto(`${BASE}/menu`);
  const glow = JSON.parse(sql(`SELECT "material"::text FROM "CharacterSkin" WHERE "code"='CS_RAVEN_NOTURNO';`)).glow;
  await A.page.waitForSelector(`.menu-scene[data-skin="${glow}"]`, { state: "attached", timeout: 90000 });
  await A.page.waitForSelector('.menu-scene[data-ready="true"]', { state: "attached", timeout: 90000 });
  assert(num(await text(A.page, "wallet-balance")) === afterW - cheapPrice, "saldo no menu");
  await shot(A.page, "35-menu-skin");
  ok("menu principal: operador renderizado com a skin equipada e saldo atualizado");

  // ── 4. Inventário ──
  await A.page.click('[data-testid="nav-inventory"]');
  await A.page.waitForURL("**/inventario");
  await A.page.waitForSelector('[data-testid="inv-item-CS_RAVEN_NOTURNO"]');
  const inv = await A.page.$$eval('.item-card', (els) => els.map((e) => e.textContent));
  assert(inv.length === 3, "inventário deveria ter 3 itens", inv);
  assert(inv.filter((t) => t.includes("Equipado")).length === 2, "duas skins equipadas", inv);
  await A.page.click('[data-testid="inv-item-WS_DX50_GELO"]');
  await A.page.click('[data-testid="inv-equip"]');
  await A.page.waitForSelector('[data-testid="inv-equip"]:has-text("Desequipar")');
  await A.page.click('[data-testid="inv-equip"]');
  await A.page.waitForSelector('[data-testid="inv-equip"]:has-text("Equipar")');
  await A.page.waitForSelector('[data-testid="cosmetic-preview"][data-ready="true"]', { timeout: 60000 });
  await shot(A.page, "36-inventario");
  ok("inventário: 3 itens possuídos, equipar e desequipar refletidos pelo servidor");

  // ── 5. VANTA COINS sem Stripe configurada ──
  await A.page.goto(`${BASE}/loja?aba=vc`);
  await A.page.waitForSelector('[data-testid="pkg-VC_500"]');
  const disabled = await A.page.$('[data-testid="payments-disabled"]');
  const hist = await text(A.page, "wallet-history");
  assert(hist.includes("Ajuste") && hist.includes("Compra: RAVEN"), "histórico da carteira", hist);
  if (disabled) {
    assert(await A.page.isDisabled('[data-testid="pkg-VC_500"] button'), "botão de compra de VC deveria estar desativado");
    const r = await apiCall(A.page, "POST", "/payments/checkout", { packageId: sql(`SELECT "id" FROM "CoinPackage" WHERE "code"='VC_500';`), requestId: crypto.randomUUID() });
    assert(r.status === 503 && r.body.error.code === "PAYMENTS_DISABLED", "servidor deveria recusar checkout sem Stripe", r);
    ok("VANTA COINS: 5 pacotes listados; sem chaves da Stripe o servidor responde 503 e a tela avisa (nada simulado); histórico da carteira correto");
  } else {
    ok("VANTA COINS: Stripe configurada neste servidor; pacotes ativos (o pagamento real não é feito pelo E2E)");
  }
  await shot(A.page, "37-loja-vc");

  // ── 6. Partida real: skins chegam ao adversário e à arma em 1ª pessoa ──
  const B = await newPlayer("b");
  for (const P of [A, B]) {
    await P.page.goto(`${BASE}/jogar`);
    await P.page.waitForSelector('[data-testid="net-status"]:has-text("Conectado")', { timeout: 30000 });
    await P.page.click('[data-testid="queue-casual"]');
    await P.page.click('[data-testid="mode-1v1"]');
  }
  await A.page.click('[data-testid="find-match"]');
  await A.page.waitForSelector('[data-testid="queue-status"]', { timeout: 10000 });
  await B.page.click('[data-testid="find-match"]');
  await Promise.all([A.page.waitForURL("**/partida", { timeout: 20000 }), B.page.waitForURL("**/partida", { timeout: 20000 })]);
  for (const P of [A, B]) await P.page.waitForFunction(() => !!window.__vantaMatch?.debugState, null, { timeout: 90000, polling: 250 });
  const sa = await A.page.evaluate(() => window.__vantaMatch.debugState().cosmetics);
  const sb = await B.page.evaluate(() => window.__vantaMatch.debugState().cosmetics);
  assert(sa.myWeapons.includes("VK7_LAMINA"), "arma de A deveria usar a skin equipada", sa);
  assert(sb.remotes[A.name] === glow, "B deveria ver A com a skin do operador", sb);
  assert(sa.remotes[B.name] === null, "B sem skin");
  ok("partida 1v1 real: B recebe a skin do operador de A e a VK-7 de A usa a skin equipada");
  await B.page.waitForSelector('[data-testid="match-menu"]', { timeout: 20000 });
  await B.page.getByRole("button", { name: "Abandonar partida" }).click();
  await B.page.click('[data-testid="confirm-leave"]');
  await A.page.waitForSelector('[data-testid="match-result"]', { timeout: 20000 });

  assert(errors.length === 0, "erros de página", errors);
  ok("nenhum erro de página");
  console.log(`\nE2E economia: ${step}/${step} etapas OK`);
} catch (e) {
  console.error("✘ falha:", e.message, errors);
  for (const [i, ctx] of browser.contexts().entries()) for (const p of ctx.pages()) await p.screenshot({ path: `/tmp/claude-0/ec-fail-${i}.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
