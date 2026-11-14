import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID, randomInt } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createVerifier } from "fast-jwt";
import type { PrismaClient } from "@vanta/db";
import {
  GAME_PROTOCOL_VERSION,
  MAP_REGISTRY,
  MODES,
  SERVER_TICK_RATE,
  clientMessageSchema,
  decodeCommand,
  weaponStatsFromRow,
  type QueueMode,
  type ServerMessage,
  type WeaponStats,
} from "@vanta/shared";
import { Match, type MatchResult, type MatchSeat } from "./match.js";

export interface GameServerOptions {
  prisma: PrismaClient;
  jwtSecret: string;
  allowedOrigins: string[];
  /** Mapa usado nas partidas (Fase 4 adiciona rotação de mapas). */
  mapCode?: string;
  log?: Pick<Console, "info" | "warn" | "error">;
  /** Em testes, o loop é avançado manualmente. */
  autoTick?: boolean;
  /** Intervalo de revalidação da conta (banimento com efeito imediato). */
  recheckMs?: number;
}

interface Client {
  ws: WebSocket;
  userId: string | null;
  username: string;
  tokenVersion: number;
  color: string;
  characterId: string | null;
  match: Match | null;
  queuedMode: QueueMode | null;
  msgWindowStart: number;
  msgCount: number;
  helloTimer: NodeJS.Timeout | null;
}

interface QueueEntry {
  client: Client;
  loadout: WeaponStats[];
  since: number;
}

const MAX_MSGS_PER_SEC = 150;
const HELLO_TIMEOUT_MS = 5000;

/**
 * Servidor de jogo: WebSocket autenticado com o mesmo JWT de acesso da API,
 * fila por modo (só jogadores reais; sem bots), partidas autoritativas e persistência do resultado.
 */
export class GameServer {
  private http: Server;
  private wss: WebSocketServer;
  private verify: (token: string) => Record<string, unknown>;
  private clients = new Map<string, Client>();
  private queues: Record<QueueMode, QueueEntry[]> = { "1v1": [], "2v2": [], "3v3": [] };
  readonly matches = new Map<string, Match>();
  private weapons = new Map<string, WeaponStats>();
  private timer: NodeJS.Timeout | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  private log: Pick<Console, "info" | "warn" | "error">;
  private mapCode: string;
  /** Promessas de persistência pendentes (testes aguardam). */
  readonly pendingSaves = new Set<Promise<unknown>>();

  constructor(private opts: GameServerOptions) {
    this.log = opts.log ?? console;
    this.mapCode = opts.mapCode ?? "NEON_DISTRICT";
    this.verify = createVerifier({ key: opts.jwtSecret, algorithms: ["HS256"] }) as unknown as (t: string) => Record<string, unknown>;
    this.http = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, matches: this.matches.size, online: this.clients.size }));
        return;
      }
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({
      server: this.http,
      path: "/game",
      maxPayload: 16 * 1024,
      verifyClient: (info: { origin: string; req: IncomingMessage }) => {
        // Bloqueia sites de terceiros (Cross-Site WebSocket Hijacking). Clientes sem Origin (testes, apps nativos) passam pela autenticação.
        return !info.origin || opts.allowedOrigins.includes(info.origin);
      },
    });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  async start(port: number, host = "0.0.0.0"): Promise<number> {
    await this.loadWeapons();
    await new Promise<void>((resolve) => this.http.listen(port, host, resolve));
    if (this.opts.autoTick !== false) this.startLoop();
    this.recheckTimer = setInterval(() => void this.recheckAccounts(), this.opts.recheckMs ?? 30_000);
    const addr = this.http.address();
    return typeof addr === "object" && addr ? addr.port : port;
  }

  async loadWeapons() {
    const rows = await this.opts.prisma.weapon.findMany({ where: { isActive: true } });
    this.weapons = new Map(rows.map((r) => [r.code, weaponStatsFromRow(r as unknown as Record<string, unknown>)]));
  }

  /** Loop de 60 Hz com correção de deriva (setInterval sozinho atrasa). */
  private startLoop() {
    const stepMs = 1000 / SERVER_TICK_RATE;
    let next = performance.now();
    const loop = () => {
      const now = performance.now();
      let steps = 0;
      while (now >= next && steps < 5) {
        this.stepAll();
        next += stepMs;
        steps++;
      }
      if (now - next > 250) next = now; // servidor travou: não tenta recuperar segundos inteiros
      this.timer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    this.timer = setTimeout(loop, stepMs);
  }

  /** Avança todas as partidas um tick (exposto para testes). */
  stepAll() {
    for (const m of this.matches.values()) m.step();
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    for (const c of this.clients.values()) c.ws.close(1001, "shutdown");
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.http.close(() => r()));
    await Promise.allSettled([...this.pendingSaves]);
  }

  private send(c: Client, msg: ServerMessage) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private onConnection(ws: WebSocket) {
    const client: Client = { ws, userId: null, username: "", tokenVersion: 0, color: "#287BFF", characterId: null, match: null, queuedMode: null, msgWindowStart: Date.now(), msgCount: 0, helloTimer: null };
    client.helloTimer = setTimeout(() => ws.close(4001, "hello timeout"), HELLO_TIMEOUT_MS);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(4002, "binary not supported");
      const now = Date.now();
      if (now - client.msgWindowStart > 1000) {
        client.msgWindowStart = now;
        client.msgCount = 0;
      }
      if (++client.msgCount > MAX_MSGS_PER_SEC) return ws.close(4008, "rate limit");
      let parsed;
      try {
        parsed = clientMessageSchema.safeParse(JSON.parse(data.toString()));
      } catch {
        return ws.close(4002, "invalid json");
      }
      if (!parsed.success) {
        this.send(client, { t: "error", code: "BAD_MESSAGE", message: "Mensagem inválida." });
        return;
      }
      void this.onMessage(client, parsed.data).catch((e) => {
        this.log.error("[game] erro ao processar mensagem", e);
        this.send(client, { t: "error", code: "INTERNAL", message: "Erro interno." });
      });
    });
    ws.on("close", () => this.onClose(client));
    ws.on("error", () => ws.terminate());
  }

  private async onMessage(c: Client, msg: import("@vanta/shared").ClientMessage) {
    if (msg.t === "hello") return this.onHello(c, msg.token, msg.v);
    if (!c.userId) return c.ws.close(4001, "unauthenticated");

    switch (msg.t) {
      case "ping":
        this.send(c, { t: "pong", n: msg.n, tick: c.match?.tick ?? 0 });
        return;
      case "queue":
        return this.enqueue(c, msg.mode, msg.loadout);
      case "cancel_queue":
        this.dequeue(c);
        this.send(c, { t: "queue", state: "idle" });
        return;
      case "ready":
        c.match?.setReady(c.userId);
        return;
      case "leave_match":
        if (c.match) {
          c.match.forfeit(c.userId);
          c.match = null;
          this.send(c, { t: "left_match" });
        }
        return;
      case "cmd": {
        if (!c.match) return;
        const err = c.match.submitCommands(c.userId, msg.c.map(decodeCommand));
        if (err) {
          if (c.match.shouldKick(c.userId)) {
            this.log.warn(`[game] ${c.username} desconectado por violações de protocolo`);
            c.ws.close(4009, "protocol violations");
            return;
          }
          if (err === "sequence") {
            // Ressincroniza: o cliente recebe o último seq aceito e continua dele.
            this.send(c, { t: "error", code: "RESYNC", message: "Sequência de comandos fora de ordem." });
            c.match.attach(c.userId, this.connFor(c));
          }
        }
        return;
      }
    }
  }

  private connFor(c: Client) {
    return { send: (m: ServerMessage) => this.send(c, m) };
  }

  private async onHello(c: Client, token: string, v: number) {
    if (c.userId) return;
    if (v !== GAME_PROTOCOL_VERSION) {
      this.send(c, { t: "error", code: "VERSION", message: "Versão do jogo desatualizada. Recarregue a página.", fatal: true });
      return c.ws.close(4003, "version");
    }
    let payload: Record<string, unknown>;
    try {
      payload = this.verify(token);
    } catch {
      this.send(c, { t: "error", code: "UNAUTHORIZED", message: "Sessão expirada.", fatal: true });
      return c.ws.close(4001, "unauthorized");
    }
    const user = await this.opts.prisma.user.findUnique({
      where: { id: String(payload.sub) },
      select: { id: true, username: true, status: true, tokenVersion: true, profile: { select: { mainCharacter: { select: { id: true, primaryColor: true } } } } },
    });
    if (!user || user.status !== "ACTIVE" || user.tokenVersion !== payload.tv) {
      this.send(c, { t: "error", code: "UNAUTHORIZED", message: "Sessão expirada ou conta indisponível.", fatal: true });
      return c.ws.close(4001, "unauthorized");
    }
    if (c.helloTimer) clearTimeout(c.helloTimer);
    c.userId = user.id;
    c.username = user.username;
    c.tokenVersion = user.tokenVersion;
    c.color = user.profile?.mainCharacter?.primaryColor ?? "#287BFF";
    c.characterId = user.profile?.mainCharacter?.id ?? null;

    // Uma conexão por conta: a nova substitui a antiga (ex.: recarregou a página).
    const old = this.clients.get(user.id);
    if (old && old !== c) {
      this.dequeue(old);
      old.userId = null;
      old.ws.close(4004, "replaced");
    }
    this.clients.set(user.id, c);

    const match = [...this.matches.values()].find((m) => !m.isEnded && m.player(user.id) && !m.player(user.id)!.abandoned);
    this.send(c, { t: "welcome", userId: user.id, username: user.username, inMatch: !!match });
    if (match) {
      c.match = match;
      match.attach(user.id, this.connFor(c));
    }
  }

  private enqueue(c: Client, mode: QueueMode, codes: string[]) {
    if (c.match && !c.match.isEnded) {
      this.send(c, { t: "error", code: "IN_MATCH", message: "Você já está em uma partida." });
      return;
    }
    const unique = [...new Set(codes)];
    const loadout = unique.map((code) => this.weapons.get(code)).filter((w): w is WeaponStats => !!w);
    if (loadout.length !== codes.length) {
      this.send(c, { t: "error", code: "BAD_LOADOUT", message: "Arsenal inválido." });
      return;
    }
    this.dequeue(c);
    c.queuedMode = mode;
    this.queues[mode].push({ client: c, loadout, since: Date.now() });
    this.tryMatch(mode);
    this.broadcastQueue(mode);
  }

  private dequeue(c: Client) {
    if (!c.queuedMode) return;
    const mode = c.queuedMode;
    this.queues[mode] = this.queues[mode].filter((e) => e.client !== c);
    c.queuedMode = null;
    this.broadcastQueue(mode);
  }

  private broadcastQueue(mode: QueueMode) {
    const q = this.queues[mode];
    const needed = MODES[mode].teamSize * 2;
    for (const e of q) this.send(e.client, { t: "queue", state: "searching", mode, inQueue: q.length, needed, since: e.since });
  }

  private tryMatch(mode: QueueMode) {
    const size = MODES[mode].teamSize * 2;
    const q = this.queues[mode];
    while (q.length >= size) {
      const group = q.splice(0, size);
      // Fase 3: ordem de chegada. A Fase 5 balanceia os times por MMR (Glicko-2).
      const seats = group.map<MatchSeat>((e) => ({ userId: e.client.userId!, username: e.client.username, color: e.client.color, characterId: e.client.characterId, loadout: e.loadout }));
      const half = size / 2;
      const map = MAP_REGISTRY[this.mapCode]!;
      const match = new Match({
        id: randomUUID(),
        mode,
        mapCode: this.mapCode,
        map,
        teams: [seats.slice(0, half), seats.slice(half)],
        seed: randomInt(1, 2 ** 31),
        onEnd: (r) => this.onMatchEnd(match, r),
      });
      this.matches.set(match.id, match);
      for (const e of group) {
        e.client.queuedMode = null;
        e.client.match = match;
        match.attach(e.client.userId!, this.connFor(e.client));
      }
      this.log.info(`[game] partida ${match.id} (${mode}) criada: ${seats.map((s) => s.username).join(", ")}`);
    }
  }

  private onClose(c: Client) {
    if (c.helloTimer) clearTimeout(c.helloTimer);
    if (!c.userId) return;
    this.dequeue(c);
    if (c.match) c.match.detach(c.userId);
    if (this.clients.get(c.userId) === c) this.clients.delete(c.userId);
  }

  private onMatchEnd(match: Match, r: MatchResult) {
    for (const c of this.clients.values()) if (c.match === match) c.match = null;
    const p = this.persist(r)
      .catch((e) => this.log.error(`[game] falha ao salvar partida ${r.matchId}`, e))
      .finally(() => this.pendingSaves.delete(p));
    this.pendingSaves.add(p);
    setTimeout(() => this.matches.delete(match.id), 15_000).unref();
  }

  /** Grava a partida e atualiza as estatísticas agregadas dos perfis numa transação. */
  async persist(r: MatchResult) {
    const db = this.opts.prisma;
    const map = await db.gameMap.findUnique({ where: { code: r.mapCode }, select: { id: true } });
    if (!map) throw new Error(`Mapa ${r.mapCode} não existe no banco`);
    const resultFor = (team: 0 | 1, abandoned: boolean) => (abandoned ? "ABANDONED" : r.winner === null ? "DRAW" : r.winner === team ? "WIN" : "LOSS");
    await db.$transaction(async (tx) => {
      await tx.match.create({
        data: {
          id: r.matchId,
          mode: MODES[r.mode].db,
          type: "CASUAL",
          status: "FINISHED",
          mapId: map.id,
          roundsToWin: r.roundsToWin,
          scoreTeamA: r.score[0],
          scoreTeamB: r.score[1],
          winnerTeam: r.winner,
          mvpUserId: r.players.find((p) => p.mvp)?.id ?? null,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          players: {
            create: r.players.map((p) => ({
              userId: p.id,
              team: p.team,
              characterId: p.characterId,
              result: resultFor(p.team, p.abandoned),
              kills: p.kills,
              deaths: p.deaths,
              assists: p.assists,
              headshots: p.headshots,
              damageDealt: p.damage,
              shotsFired: p.shots,
              shotsHit: p.hits,
              score: p.kills * 100 + p.assists * 40 + p.headshots * 20,
              isMvp: p.mvp,
              abandoned: p.abandoned,
            })),
          },
          events: { create: r.events.map((e) => ({ tick: e.tick, round: e.round, type: e.type, actorId: e.actorId ?? null, targetId: e.targetId ?? null, data: e.data })) },
        },
      });
      for (const p of r.players) {
        const res = resultFor(p.team, p.abandoned);
        await tx.userProfile.update({
          where: { userId: p.id },
          data: {
            matchesPlayed: { increment: 1 },
            wins: { increment: res === "WIN" ? 1 : 0 },
            losses: { increment: res === "LOSS" || res === "ABANDONED" ? 1 : 0 },
            kills: { increment: p.kills },
            deaths: { increment: p.deaths },
            assists: { increment: p.assists },
            headshots: { increment: p.headshots },
            shotsFired: { increment: p.shots },
            shotsHit: { increment: p.hits },
            mvpCount: { increment: p.mvp ? 1 : 0 },
          },
        });
      }
    });
  }

  /** Banimento/suspensão/troca de senha derrubam a conexão de jogo em até `recheckMs`. */
  private async recheckAccounts() {
    const ids = [...this.clients.keys()];
    if (!ids.length) return;
    const users = await this.opts.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, tokenVersion: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    // Só os ids consultados: conexões que chegaram durante a consulta não podem ser derrubadas por engano.
    for (const id of ids) {
      const c = this.clients.get(id);
      if (!c) continue;
      const u = byId.get(id);
      if (!u || u.status !== "ACTIVE" || u.tokenVersion !== c.tokenVersion) {
        if (c.match) c.match.forfeit(id);
        this.send(c, { t: "error", code: "UNAUTHORIZED", message: "Sessão encerrada.", fatal: true });
        c.ws.close(4001, "account");
      }
    }
  }
}
