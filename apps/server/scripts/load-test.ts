/**
 * Teste de carga do servidor de jogo (Fase 8, parte 2).
 *
 * Abre N conexões WebSocket de TESTE, cada uma com uma conta "carga_NNNN" criada só para isso,
 * entra na fila casual e joga com comandos aleatórios (anda, gira, atira) no mesmo ritmo do
 * cliente real (60 comandos/s em lotes, ping a cada segundo). Mede no lado do cliente a
 * latência (ping/pong), o intervalo entre snapshots e o tráfego; e lê o /metrics do servidor
 * para o tempo de tick, CPU e memória.
 *
 * Não são jogadores: as contas ficam marcadas pelo prefixo e o script só roda num banco cujo
 * nome contém "load" ou "carga" (as partidas ficam gravadas nele). Nunca em produção real.
 *
 * Uso (na raiz):
 *   DATABASE_URL=postgresql://.../vanta_load pnpm --filter @vanta/server load-test -- --players 120 --duration 90
 * Opções: --players N  --mode 1v1|2v2|3v3  --duration s  --game ws://host:4100/game
 *         --metrics http://host:4100/metrics  --ramp s  --out arquivo.json
 */
import { writeFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createSigner } from "fast-jwt";
import WebSocket from "ws";
import { createPrismaClient } from "@vanta/db";
import { BTN, GAME_PROTOCOL_VERSION, INTERP_DELAY_TICKS, type QueueMode, type ServerMessage, type WireCommand } from "@vanta/shared";

// ───────────── opções ─────────────
const argv = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
};
const PLAYERS = Number(arg("players", "60"));
const MODE = arg("mode", "3v3") as QueueMode;
const DURATION_S = Number(arg("duration", "90"));
const RAMP_S = Number(arg("ramp", "10"));
const GAME_URL = arg("game", "ws://127.0.0.1:4100/game");
const METRICS_URL = arg("metrics", GAME_URL.replace(/^ws/, "http").replace(/\/game$/, "/metrics"));
const OUT = arg("out", "");
const METRICS_TOKEN = process.env.METRICS_TOKEN ?? "";
const SECRET = process.env.JWT_ACCESS_SECRET ?? "";

if (!["1v1", "2v2", "3v3"].includes(MODE) || !(PLAYERS > 0) || !(DURATION_S > 0)) {
  console.error("Opções inválidas. Veja o cabeçalho do script.");
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  console.error("Recusado: NODE_ENV=production. Rode contra um banco descartável de teste de carga.");
  process.exit(1);
}
const dbName = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
  } catch {
    return "";
  }
})();
if (!/load|carga/i.test(dbName)) {
  console.error(`Recusado: o banco "${dbName}" não parece ser de teste de carga (o nome precisa conter "load" ou "carga").`);
  console.error("As contas carga_* e as partidas ficam gravadas no banco. Crie um banco separado (veja docs/LOAD_TEST.md).");
  process.exit(1);
}
if (SECRET.length < 32) {
  console.error("JWT_ACCESS_SECRET ausente: precisa ser o mesmo do servidor de jogo.");
  process.exit(1);
}

// ───────────── estatística ─────────────
function pct(sorted: number[], p: number) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "—");

// ───────────── contas de teste ─────────────
const prisma = createPrismaClient();
const weapons = await prisma.weapon.findMany({ where: { isActive: true }, select: { code: true, category: true } });
const primary = weapons.find((w) => w.category === "ASSAULT_RIFLE") ?? weapons[0];
const pistol = weapons.find((w) => w.category === "PISTOL");
if (!primary) throw new Error("Nenhuma arma ativa no banco: rode o seed antes.");
const loadout = [primary.code, ...(pistol && pistol.code !== primary.code ? [pistol.code] : [])];
const defaultCharacter = await prisma.character.findFirst({ where: { isDefault: true, isActive: true } });

const accounts: Array<{ id: string; username: string; tv: number }> = [];
for (let i = 1; i <= PLAYERS; i++) {
  const username = `carga_${String(i).padStart(4, "0")}`;
  const u = await prisma.user.upsert({
    where: { usernameLower: username },
    update: { status: "ACTIVE" },
    create: {
      username,
      usernameLower: username,
      email: `${username}@carga.invalid`,
      // Hash impossível: a conta não aceita login por senha; só o token assinado por este script.
      passwordHash: "!conta-de-teste-de-carga",
      birthDate: new Date("1990-01-01T00:00:00Z"),
      termsAcceptedAt: new Date(),
      emailVerifiedAt: new Date(),
      profile: { create: { displayName: username, mainCharacterId: defaultCharacter?.id } },
      wallet: { create: {} },
    },
    select: { id: true, username: true, tokenVersion: true },
  });
  accounts.push({ id: u.id, username: u.username, tv: u.tokenVersion });
}
await prisma.$disconnect();
const sign = createSigner({ key: SECRET, algorithm: "HS256", expiresIn: (DURATION_S + RAMP_S + 600) * 1000 });

// ───────────── clientes ─────────────
const TICK_MS = 1000 / 60;
const MAX_PENDING = 12;
const totals = { connected: 0, welcomed: 0, matches: new Set<string>(), errors: new Map<string, number>(), closes: new Map<string, number>(), bytesIn: 0, msgsIn: 0, cmdsSent: 0 };
const rtts: number[] = [];
const snapGaps: number[] = [];
let measuring = false;

class LoadClient {
  ws: WebSocket;
  seq = 0;
  acked = 0;
  inMatch = false;
  live = false;
  lastSnapAt = 0;
  serverTick = 0;
  sendClock = 0;
  outbox: WireCommand[] = [];
  buttons = 0;
  yaw = Math.random() * Math.PI * 2;
  turn = 0;
  pingN = 0;
  pings = new Map<number, number>();
  closed = false;
  welcomed = false;

  constructor(private account: (typeof accounts)[number]) {
    this.ws = new WebSocket(GAME_URL);
    this.ws.on("open", () => {
      totals.connected++;
      this.send({ t: "hello", token: sign({ sub: account.id, role: "PLAYER", tv: account.tv }), v: GAME_PROTOCOL_VERSION });
    });
    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("close", (code, reason) => {
      this.closed = true;
      if (code !== 1000 && code !== 1005) bump(totals.closes, `${code} ${reason.toString() || ""}`.trim());
    });
    this.ws.on("error", (e) => bump(totals.errors, `socket: ${e.message}`));
  }

  send(o: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  onMessage(raw: string) {
    totals.msgsIn++;
    totals.bytesIn += Buffer.byteLength(raw);
    const m = JSON.parse(raw) as ServerMessage;
    switch (m.t) {
      case "welcome":
        totals.welcomed++;
        this.welcomed = true;
        // Conta que ficou numa partida de uma execução anterior: o servidor a devolve para lá.
        if (!m.inMatch) this.send({ t: "queue", mode: MODE, loadout });
        return;
      case "match":
        totals.matches.add(m.info.matchId);
        this.inMatch = true;
        this.seq = this.acked = m.info.lastSeq;
        this.serverTick = m.info.tick;
        this.sendClock = performance.now();
        this.send({ t: "ready" });
        return;
      case "snap": {
        const now = performance.now();
        if (this.lastSnapAt && measuring) snapGaps.push(now - this.lastSnapAt);
        this.lastSnapAt = now;
        this.serverTick = m.tick;
        this.acked = m.you.seq;
        this.live = m.phase === "live";
        if (m.phase === "ended" && this.inMatch) {
          this.inMatch = false;
          this.lastSnapAt = 0;
          setTimeout(() => this.send({ t: "queue", mode: MODE, loadout }), 2000 + Math.random() * 2000);
        }
        return;
      }
      case "pong": {
        const at = this.pings.get(m.n);
        if (at !== undefined) {
          this.pings.delete(m.n);
          if (measuring) rtts.push(performance.now() - at);
        }
        return;
      }
      case "error":
        bump(totals.errors, m.code);
        return;
    }
  }

  /** Gera os comandos devidos desde a última chamada (60/s), respeitando o limite sem confirmação. */
  produce(now: number) {
    if (!this.inMatch) return;
    if (Math.random() < 0.02) this.pickButtons();
    while (now - this.sendClock >= TICK_MS) {
      this.sendClock += TICK_MS;
      if (this.seq - this.acked >= MAX_PENDING) continue; // espera o servidor, como o cliente real
      this.yaw += this.turn;
      const yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
      const fire = this.live && this.buttons & BTN.fire ? BTN.fire : 0;
      this.outbox.push([++this.seq, (this.buttons & ~BTN.fire) | fire, Math.round(yaw * 1e5) / 1e5, 0, Math.max(0, this.serverTick - INTERP_DELAY_TICKS), 0]);
    }
    if (now - this.sendClock > 250) this.sendClock = now; // o gerador atrasou: não despeja uma rajada
  }

  pickButtons() {
    const r = Math.random;
    this.buttons = (r() < 0.6 ? BTN.fwd : r() < 0.3 ? BTN.back : 0) | (r() < 0.25 ? BTN.left : r() < 0.33 ? BTN.right : 0) | (r() < 0.3 ? BTN.sprint : 0) | (r() < 0.05 ? BTN.jump : 0) | (r() < 0.35 ? BTN.fire : 0);
    this.turn = (r() - 0.5) * 0.06;
  }

  flush() {
    if (!this.outbox.length) return;
    // No máximo 30 por mensagem (limite do protocolo).
    while (this.outbox.length) {
      const c = this.outbox.splice(0, 30);
      totals.cmdsSent += c.length;
      this.send({ t: "cmd", c });
    }
  }

  ping() {
    if (!this.welcomed) return; // como o cliente real: só depois do welcome
    const n = ++this.pingN;
    this.pings.set(n, performance.now());
    if (this.pings.size > 10) this.pings.delete(this.pings.keys().next().value!);
    this.send({ t: "ping", n });
  }

  close() {
    this.ws.close(1000);
  }
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// ───────────── métricas do servidor ─────────────
interface Sample {
  at: number;
  values: Map<string, number>;
}
async function scrape(): Promise<Sample | null> {
  if (!METRICS_TOKEN) return null;
  try {
    const res = await fetch(METRICS_URL, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    if (!res.ok) return null;
    const values = new Map<string, number>();
    for (const line of (await res.text()).split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const sp = line.lastIndexOf(" ");
      values.set(line.slice(0, sp).replace(/,?service="game"/, "").replace("{}", ""), Number(line.slice(sp + 1)));
    }
    return { at: performance.now(), values };
  } catch {
    return null;
  }
}
const get = (s: Sample | null, k: string) => s?.values.get(k) ?? NaN;
/** Percentil de um histograma do Prometheus entre duas coletas (limite superior do balde). */
function histPct(a: Sample, b: Sample, name: string, p: number) {
  const buckets: Array<[number, number]> = [];
  for (const [k, v] of b.values) {
    const m = k.match(new RegExp(`^${name}_bucket\\{le="([^"]+)"\\}$`));
    if (m) buckets.push([m[1] === "+Inf" ? Infinity : Number(m[1]), v - (a.values.get(k) ?? 0)]);
  }
  buckets.sort((x, y) => x[0] - y[0]);
  const total = buckets.at(-1)?.[1] ?? 0;
  if (!total) return NaN;
  for (const [le, n] of buckets) if (n >= total * (p / 100)) return le;
  return Infinity;
}

// ───────────── execução ─────────────
const genLag = monitorEventLoopDelay({ resolution: 10 });
genLag.enable();
console.info(`[carga] ${PLAYERS} clientes de teste, fila casual ${MODE}, ${DURATION_S}s medidos após ${RAMP_S}s de entrada gradual`);
console.info(`[carga] servidor: ${GAME_URL}${METRICS_TOKEN ? "" : " (sem METRICS_TOKEN: só métricas do lado do cliente)"}`);

const clients: LoadClient[] = [];
const startAt = performance.now();
for (let i = 0; i < accounts.length; i++) {
  setTimeout(() => clients.push(new LoadClient(accounts[i]!)), (RAMP_S * 1000 * i) / accounts.length);
}
const produceTimer = setInterval(() => {
  const now = performance.now();
  for (const c of clients) {
    c.produce(now);
    c.flush();
  }
}, 33);
const pingTimer = setInterval(() => clients.forEach((c) => c.ping()), 1000);

await new Promise((r) => setTimeout(r, RAMP_S * 1000 + 3000));
const inMatchAtStart = clients.filter((c) => c.inMatch).length;
const s0 = await scrape();
const before = { bytesIn: totals.bytesIn, msgsIn: totals.msgsIn, cmds: totals.cmdsSent };
genLag.reset();
measuring = true;
const progress = setInterval(() => {
  const inMatch = clients.filter((c) => c.inMatch).length;
  console.info(`[carga] ${Math.round((performance.now() - startAt) / 1000)}s: ${clients.filter((c) => !c.closed).length} conectados, ${inMatch} em partida, ${totals.matches.size} partidas, ${rtts.length} pings`);
}, 10_000);
await new Promise((r) => setTimeout(r, DURATION_S * 1000));
measuring = false;
const s1 = await scrape();
const elapsed = (s1?.at ?? performance.now()) - (s0?.at ?? performance.now() - DURATION_S * 1000);
clearInterval(progress);
clearInterval(produceTimer);
clearInterval(pingTimer);
const inMatchAtEnd = clients.filter((c) => c.inMatch).length;
const openAtEnd = clients.filter((c) => !c.closed).length;
clients.forEach((c) => c.close());

rtts.sort((a, b) => a - b);
snapGaps.sort((a, b) => a - b);
const secs = elapsed / 1000;
const server =
  s0 && s1
    ? {
        tickP50ms: histPct(s0, s1, "vanta_game_tick_duration_seconds", 50) * 1000,
        tickP99ms: histPct(s0, s1, "vanta_game_tick_duration_seconds", 99) * 1000,
        tickAvgMs: ((get(s1, "vanta_game_tick_duration_seconds_sum") - get(s0, "vanta_game_tick_duration_seconds_sum")) / (get(s1, "vanta_game_tick_duration_seconds_count") - get(s0, "vanta_game_tick_duration_seconds_count"))) * 1000,
        ticksPerSec: (get(s1, "vanta_game_tick_duration_seconds_count") - get(s0, "vanta_game_tick_duration_seconds_count")) / secs,
        catchupTicks: (get(s1, 'vanta_game_tick_catchup_total{kind="catchup"}') || 0) - (get(s0, 'vanta_game_tick_catchup_total{kind="catchup"}') || 0),
        stalls: (get(s1, 'vanta_game_tick_catchup_total{kind="stall"}') || 0) - (get(s0, 'vanta_game_tick_catchup_total{kind="stall"}') || 0),
        cpuPct: ((get(s1, "vanta_process_cpu_seconds_total") - get(s0, "vanta_process_cpu_seconds_total")) / secs) * 100,
        rssMB: get(s1, "vanta_process_resident_memory_bytes") / 1048576,
        heapMB: get(s1, "vanta_nodejs_heap_size_used_bytes") / 1048576,
        eventLoopP99ms: get(s1, 'vanta_nodejs_eventloop_lag_p99_seconds') * 1000,
        outMbps: ((get(s1, "vanta_game_bytes_out_total") - get(s0, "vanta_game_bytes_out_total")) * 8) / secs / 1e6,
        matchesActive: ["1v1", "2v2", "3v3"].reduce((n, m) => n + (get(s1, `vanta_game_matches_active{mode="${m}"}`) || 0), 0),
        rejected: [...s1.values].filter(([k]) => k.startsWith("vanta_game_rejected_total")).map(([k, v]) => `${k.match(/reason="([^"]+)"/)?.[1]}=${v - (s0.values.get(k) ?? 0)}`),
      }
    : null;
const report = {
  players: PLAYERS,
  mode: MODE,
  durationS: Math.round(secs),
  connected: totals.welcomed,
  inMatchAtStart,
  inMatchAtEnd,
  openAtEnd,
  matches: totals.matches.size,
  client: {
    rttP50ms: pct(rtts, 50),
    rttP95ms: pct(rtts, 95),
    rttP99ms: pct(rtts, 99),
    rttSamples: rtts.length,
    snapGapP50ms: pct(snapGaps, 50),
    snapGapP99ms: pct(snapGaps, 99),
    snapsPerSec: snapGaps.length / secs,
    inKBpsPerPlayer: (totals.bytesIn - before.bytesIn) / secs / 1024 / Math.max(1, inMatchAtEnd),
    cmdsPerSec: (totals.cmdsSent - before.cmds) / secs,
    generatorLagP99ms: genLag.percentile(99) / 1e6,
  },
  server,
  errors: Object.fromEntries(totals.errors),
  closes: Object.fromEntries(totals.closes),
};

console.info("\n──────── resultado ────────");
console.info(`Clientes identificados: ${report.connected}/${PLAYERS} · em partida no início/fim da medição: ${inMatchAtStart}/${inMatchAtEnd} · partidas: ${report.matches}`);
console.info(`Ping (cliente): p50 ${fmt(report.client.rttP50ms)} ms · p95 ${fmt(report.client.rttP95ms)} ms · p99 ${fmt(report.client.rttP99ms)} ms (${rtts.length} amostras)`);
console.info(`Intervalo entre snapshots: p50 ${fmt(report.client.snapGapP50ms)} ms · p99 ${fmt(report.client.snapGapP99ms)} ms (esperado 33,3)`);
console.info(`Tráfego recebido por jogador em partida: ${fmt(report.client.inKBpsPerPlayer)} KB/s · comandos enviados: ${fmt(report.client.cmdsPerSec, 0)}/s`);
console.info(`Atraso do próprio gerador de carga (p99): ${fmt(report.client.generatorLagP99ms)} ms${report.client.generatorLagP99ms > 50 ? "  ← o gerador está sobrecarregado; os números do cliente pioram por causa dele" : ""}`);
if (server) {
  console.info(`Tick do servidor: média ${fmt(server.tickAvgMs, 2)} ms · p50 ≤ ${fmt(server.tickP50ms, 2)} ms · p99 ≤ ${fmt(server.tickP99ms, 2)} ms (orçamento 16,7) · ${fmt(server.ticksPerSec)} ticks/s`);
  console.info(`Ticks recuperados com atraso: ${server.catchupTicks} · travadas > 250 ms: ${server.stalls}`);
  console.info(`CPU do processo de jogo: ${fmt(server.cpuPct)}% de um núcleo · memória ${fmt(server.rssMB, 0)} MB (heap ${fmt(server.heapMB, 0)} MB) · event loop p99 ${fmt(server.eventLoopP99ms)} ms`);
  console.info(`Saída do servidor: ${fmt(server.outMbps, 2)} Mbit/s · recusas: ${server.rejected.join(", ") || "nenhuma"}`);
}
if (totals.errors.size) console.info(`Erros recebidos: ${JSON.stringify(report.errors)}`);
if (totals.closes.size) console.info(`Conexões fechadas pelo servidor: ${JSON.stringify(report.closes)}`);
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
process.exit(0);
