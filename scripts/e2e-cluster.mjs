// E2E de vários nós de jogo pela pilha de produção (nginx + game + game2 + Redis).
// Uso: docker compose -p vantaprod -f docker-compose.prod.yml --env-file <env> --profile scale up -d --wait
//      node scripts/e2e-cluster.mjs [http://localhost:8080]
// Força um jogador em cada nó (?node=game1 e ?node=game2), entra na fila 1v1 e confere que o
// que estava no outro nó recebe o redirecionamento, reconecta pelo nginx em ?node= e entra na partida.
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const WebSocket = require("ws");

const BASE = (process.argv[2] ?? "http://localhost:8080").replace(/\/$/, "");
const WS = BASE.replace(/^http/, "ws") + "/game";
const PROTOCOL = 4;
let step = 0;
const ok = (msg) => console.log(`✓ ${++step}. ${msg}`);
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

async function register(tag) {
  const n = `${tag}${Date.now().toString(36).slice(-5)}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ username: n, email: `${n.toLowerCase()}@teste.vanta`, password: "SenhaForte123", birthDate: "2000-05-10", acceptTerms: true }),
  });
  if (!res.ok) fail(`cadastro ${res.status} ${await res.text()}`);
  const j = await res.json();
  return { id: j.user.id, token: j.accessToken };
}

function client(url, token) {
  const ws = new WebSocket(url, { headers: { origin: BASE } });
  const msgs = [];
  const waiters = [];
  ws.on("message", (d) => {
    msgs.push(JSON.parse(d.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", token, v: PROTOCOL })));
  const waitFor = async (t, pred = () => true, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const m = msgs.find((x) => x.t === t && pred(x));
      if (m) return m;
      if (Date.now() > end) throw new Error(`timeout esperando ${t}: ${JSON.stringify(msgs.map((x) => x.t))}`);
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  return { ws, msgs, waitFor, send: (o) => ws.send(JSON.stringify(o)) };
}

const health = await fetch(`${BASE}/healthz`);
if (!health.ok) fail("pilha fora do ar");
const weapons = await (await fetch(`${BASE}/api/content/weapons`)).json();
const rifle = (weapons.weapons ?? weapons).find((w) => w.category === "ASSAULT_RIFLE").code;
const [a, b] = [await register("NoA"), await register("NoB")];
ok("duas contas cadastradas pela API");

const ca = client(`${WS}?node=game1`, a.token);
const cb = client(`${WS}?node=game2`, b.token);
await ca.waitFor("welcome");
await cb.waitFor("welcome");
ok("um jogador conectado em cada nó pelo nginx (?node=game1 e ?node=game2)");

// B entra primeiro: no empate, a partida fica no nó de quem esperava há mais tempo (game2).
cb.send({ t: "queue", mode: "1v1", loadout: [rifle] });
await cb.waitFor("queue", (m) => m.state === "searching");
ca.send({ t: "queue", mode: "1v1", loadout: [rifle] });
const redirect = await ca.waitFor("redirect");
if (redirect.node !== "game2" || redirect.url) fail(`redirecionamento inesperado: ${JSON.stringify(redirect)}`);
await cb.waitFor("match");
ok("partida criada no game2; o jogador do game1 recebeu {t:'redirect', node:'game2'} (sem URL: o nginx resolve)");

ca.ws.close();
const ca2 = client(`${WS}?node=${redirect.node}`, a.token);
const welcome = await ca2.waitFor("welcome");
if (!welcome.inMatch) fail("chegou no game2 sem a partida");
const match = await ca2.waitFor("match");
if (![a.id, b.id].every((id) => match.info.players.some((p) => p.id === id))) fail("jogadores errados na partida");
ok("reconectou em /game?node=game2 e entrou na mesma partida");

// Conexão nova (sem ?node) vai para qualquer nó (o DNS do Docker distribui). Quem cair no game1 é
// mandado de volta para o game2; quem cair no game2 entra direto. Os dois caminhos precisam aparecer.
ca2.ws.close();
const seen = { redirect: 0, welcome: 0 };
for (let i = 0; i < 12 && !(seen.redirect && seen.welcome); i++) {
  const c = client(WS, a.token);
  const first = await Promise.race([c.waitFor("welcome").then(() => "welcome"), c.waitFor("redirect").then(() => "redirect")]);
  if (first === "redirect") {
    if ((await c.waitFor("redirect")).node !== "game2") fail("redirecionou para o nó errado");
    seen.redirect++;
  } else if ((await c.waitFor("welcome")).inMatch) seen.welcome++;
  else fail("caiu no game2 sem a partida");
  c.ws.close();
  await new Promise((r) => setTimeout(r, 200));
}
if (!seen.redirect || !seen.welcome) fail(`o nginx não distribuiu entre os nós: ${JSON.stringify(seen)}`);
ok(`conexões sem ?node foram distribuídas entre os nós e todas chegaram à partida (${seen.welcome} direto no game2, ${seen.redirect} redirecionadas do game1)`);

const metrics = await fetch(`${BASE}/game?node=evil.example.com`).catch(() => null);
ok(`?node com nome inválido não é encaminhado para fora (resposta ${metrics?.status ?? "recusada"})`);
cb.ws.close();
console.log(`\nE2E de vários nós: ${step}/${step} passos ok`);
process.exit(0);
