import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID, randomInt } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createVerifier } from "fast-jwt";
import type { PrismaClient } from "@vanta/db";
import {
  GAME_PROTOCOL_VERSION,
  MAP_REGISTRY,
  MAP_ROTATION,
  MODES,
  SERVER_TICK_RATE,
  balanceTeams,
  clientMessageSchema,
  pickMatchGroup,
  decodeCommand,
  weaponStatsFromRow,
  type QueueMode,
  type ServerMessage,
  type WeaponStats,
  type MatchCosmetics,
  CHAT_RATE,
  DEFAULT_LOADOUT,
  packParties,
  sanitizeChat,
  type ChatChannel,
  type PresenceState,
  type SocialEvent,
  ROOM_INVITE_TTL_MS,
  makeRoomCode,
  normalizeRoomCode,
  roomMaxPlayers,
  type RoomSettings,
  type RoomTeam,
} from "@vanta/shared";
import { Match, type MatchResult, type MatchSeat } from "./match.js";
import { equippedCosmetics } from "../modules/economy/store.service.js";
import { applyRankedMatch, getActiveSeason, getOrCreateRating, rankedCooldownSeconds } from "./ranked.js";
import { PartyManager, type Party } from "./party.js";
import type { SocialBus } from "../modules/social/bus.js";
import { RoomManager, type Room, type RoomError } from "./rooms.js";
import { PasswordHasher } from "../lib/password.js";
import { applyMatchProgression } from "../modules/progression/progression.service.js";
import { applyClanResults } from "../modules/clans/clans.service.js";
import { saveReplay } from "../modules/matches/replay.js";
import { createRegistry, gameMetrics, metricsAuthorized, type GameMetrics } from "../lib/metrics.js";
import type { RoomListItem } from "@vanta/shared";
import { LocalCluster, type Cluster, type ClusterMessage, type MatchSpec, type Ticket, type TicketEntry } from "./cluster.js";
import type { Registry } from "prom-client";

export interface GameServerOptions {
  prisma: PrismaClient;
  jwtSecret: string;
  allowedOrigins: string[];
  /** Mapas da rotação (padrão: os 5). */
  maps?: string[];
  log?: Pick<Console, "info" | "warn" | "error">;
  /** Em testes, o loop é avançado manualmente. */
  autoTick?: boolean;
  /** Intervalo de revalidação da conta (banimento com efeito imediato). */
  recheckMs?: number;
  /** Eventos sociais vindos da API (pedidos de amizade, bloqueios...). */
  bus?: SocialBus;
  /** Tempo que um membro desconectado continua no grupo (ms). */
  partyGraceMs?: number;
  /** Tempo que um membro desconectado continua na sala (fora de partida). */
  roomGraceMs?: number;
  /** Hash das senhas de sala (Argon2id, o mesmo das contas). */
  hasher?: PasswordHasher;
  /** Libera GET /metrics (Prometheus) com esse token. Vazio: endpoint desligado. */
  metricsToken?: string;
  /** Vários processos de jogo (Redis). Padrão: um processo só, tudo em memória. */
  cluster?: Cluster;
  /** URL WebSocket deste nó, quando o cliente não passa por um proxy que entende ?node= (desenvolvimento). */
  publicUrl?: string;
}

interface Client {
  ws: WebSocket;
  userId: string | null;
  username: string;
  tokenVersion: number;
  color: string;
  characterId: string | null;
  character: string;
  match: Match | null;
  /** Fila em que está: modo + tipo (casual/ranqueada) e o bilhete. */
  queued: { mode: QueueMode; ranked: boolean; ticketId: string } | null;
  /** Mandado para outro nó: ao fechar, não aparece offline para os amigos. */
  redirecting: boolean;
  msgWindowStart: number;
  msgCount: number;
  helloTimer: NodeJS.Timeout | null;
  /** Social: amigos, bloqueios (nos dois sentidos) e quem esta pessoa silenciou. */
  friends: Set<string>;
  blockRel: Set<string>;
  muted: Set<string>;
  /** Fim do banimento de chat (Infinity = permanente; 0 = sem banimento). */
  chatBanUntil: number;
  chatTimes: number[];
  presence: PresenceState;
  /** Arsenal escolhido na tela Jogar (usado quando o líder do grupo entra na fila). */
  loadout: string[] | null;
  /** Partida de sala que está assistindo (quadros atrasados). */
  spectating: Match | null;
  lastRoomCreate: number;
  /** Tentativas de senha de sala erradas (anti força bruta). */
  roomPwFails: number[];
}


const queueKey = (mode: QueueMode, ranked: boolean) => `${mode}:${ranked ? "ranked" : "casual"}`;

const MAX_MSGS_PER_SEC = 150;
/** Prazo para o hello depois de abrir o WebSocket (navegador ocupado compilando shaders pode demorar). */
const HELLO_TIMEOUT_MS = 15_000;

/**
 * Servidor de jogo: WebSocket autenticado com o mesmo JWT de acesso da API,
 * fila por modo (só jogadores reais; sem bots), partidas autoritativas e persistência do resultado.
 */
export class GameServer {
  private http: Server;
  private wss: WebSocketServer;
  private verify: (token: string) => Record<string, unknown>;
  private clients = new Map<string, Client>();
  /** Bilhetes deste nó que estão na fila (a fila em si fica no cluster). */
  private localTickets = new Map<string, { key: string; mode: QueueMode; ranked: boolean; since: number; userIds: string[] }>();
  readonly cluster: Cluster;
  private clusterTimer: NodeJS.Timeout | null = null;
  private parties = new PartyManager();
  /** Nome/personagem de quem já se conectou (para mostrar membros de grupo offline). */
  private userInfo = new Map<string, { username: string; character: string }>();
  private partyGrace = new Map<string, NodeJS.Timeout>();
  readonly rooms = new RoomManager();
  private roomGrace = new Map<string, NodeJS.Timeout>();
  private hasher: PasswordHasher;
  private unsubscribe: (() => Promise<void>) | null = null;
  private mmTimer: NodeJS.Timeout | null = null;
  readonly matches = new Map<string, Match>();
  private weapons = new Map<string, WeaponStats>();
  private timer: NodeJS.Timeout | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  private log: Pick<Console, "info" | "warn" | "error">;
  private rotation: string[];
  private rotationIndex = 0;
  /** Promessas de persistência pendentes (testes aguardam). */
  readonly pendingSaves = new Set<Promise<unknown>>();
  readonly registry: Registry;
  readonly metrics: GameMetrics;

  constructor(private opts: GameServerOptions) {
    this.log = opts.log ?? console;
    this.cluster = opts.cluster ?? new LocalCluster();
    this.hasher = opts.hasher ?? new PasswordHasher(19456);
    // Rotação de mapas: em ordem, um mapa por partida (opts.maps restringe, ex.: testes ou eventos).
    this.rotation = (opts.maps ?? MAP_ROTATION).filter((c) => MAP_REGISTRY[c]);
    if (!this.rotation.length) throw new Error("Nenhum mapa válido na rotação");
    this.verify = createVerifier({ key: opts.jwtSecret, algorithms: ["HS256"] }) as unknown as (t: string) => Record<string, unknown>;
    this.registry = createRegistry("game");
    this.metrics = gameMetrics(this.registry, () => this.metricsState());
    this.http = createServer((req, res) => {
      if (req.url === "/metrics") {
        if (!opts.metricsToken) return void res.writeHead(404).end();
        if (!metricsAuthorized(req.headers.authorization, opts.metricsToken)) return void res.writeHead(401).end();
        void this.registry.metrics().then(
          (body) => res.writeHead(200, { "content-type": this.registry.contentType }).end(body),
          () => res.writeHead(500).end(),
        );
        return;
      }
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
    // As salas vivem na memória do processo que as criou: as que ficaram abertas de uma execução anterior
    // são encerradas (com vários nós, só as que não pertencem a nenhum nó vivo).
    const liveRooms = this.cluster.multiNode ? (await this.cluster.roomAll()).map((r) => (JSON.parse(r.json) as { code: string }).code) : [];
    await this.opts.prisma.room.updateMany({ where: { status: { not: "CLOSED" }, code: { notIn: liveRooms } }, data: { status: "CLOSED", closedAt: new Date() } });
    await this.cluster.start((m) => this.onClusterMessage(m), () => ({ load: this.clients.size, url: this.opts.publicUrl ?? null }));
    await new Promise<void>((resolve) => this.http.listen(port, host, resolve));
    if (this.opts.autoTick !== false) {
      this.startLoop();
      // As janelas de MMR das filas ranqueadas abrem com o tempo: reavalia a cada segundo.
      this.mmTimer = setInterval(() => void this.matchmakingTick().catch((e) => this.log.error("[game] fila", e)), 1000);
    } else if (this.cluster.multiNode) {
      // Testes com vários nós: o líder forma as partidas de bilhetes vindos de outros nós.
      this.mmTimer = setInterval(() => void this.matchmakingTick().catch((e) => this.log.error("[game] fila", e)), 300);
    }
    if (this.cluster.multiNode) {
      // A contagem da fila muda com gente de outros nós: atualiza quem está esperando aqui.
      this.clusterTimer = setInterval(() => {
        const keys = new Map([...this.localTickets.values()].map((t) => [t.key, t] as const));
        for (const t of keys.values()) void this.broadcastQueue(t.mode, t.ranked).catch(() => {});
      }, 2000);
    }
    this.recheckTimer = setInterval(() => void this.recheckAccounts(), this.opts.recheckMs ?? 30_000);
    if (this.opts.bus) this.unsubscribe = await this.opts.bus.subscribe((to, ev) => this.onSocialEvent(to, ev));
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
        const t0 = performance.now();
        this.stepAll();
        this.metrics.tick.observe((performance.now() - t0) / 1000);
        next += stepMs;
        steps++;
      }
      if (steps > 1) this.metrics.tickLag.inc({ kind: "catchup" }, steps - 1);
      if (now - next > 250) {
        this.metrics.tickLag.inc({ kind: "stall" });
        next = now; // servidor travou: não tenta recuperar segundos inteiros
      }
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
    if (this.mmTimer) clearInterval(this.mmTimer);
    if (this.clusterTimer) clearInterval(this.clusterTimer);
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    for (const t of this.partyGrace.values()) clearTimeout(t);
    for (const t of this.roomGrace.values()) clearTimeout(t);
    await this.unsubscribe?.();
    for (const c of this.clients.values()) c.ws.close(1001, "shutdown");
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.http.close(() => r()));
    await Promise.allSettled([...this.pendingSaves]);
    await this.cluster.stop();
  }

  private send(c: Client, msg: ServerMessage) {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(msg);
    c.ws.send(data);
    this.metrics.messagesOut.inc();
    this.metrics.bytesOut.inc(Buffer.byteLength(data));
  }

  /** Estado lido pelo Prometheus na hora da coleta. */
  private metricsState() {
    const matches: Record<string, number> = { "1v1": 0, "2v2": 0, "3v3": 0 };
    for (const m of this.matches.values()) if (!m.isEnded) matches[m.mode] = (matches[m.mode] ?? 0) + 1;
    const queues: Record<string, number> = {};
    // Jogadores deste nó em cada fila (a soma dos nós dá o total).
    for (const t of this.localTickets.values()) queues[t.key] = (queues[t.key] ?? 0) + t.userIds.length;
    return { connections: this.wss.clients.size, players: this.clients.size, matches, queues };
  }

  private onConnection(ws: WebSocket) {
    const client: Client = {
      ws, userId: null, username: "", tokenVersion: 0, color: "#287BFF", characterId: null, character: "RAVEN", match: null, queued: null, redirecting: false,
      msgWindowStart: Date.now(), msgCount: 0, helloTimer: null,
      friends: new Set(), blockRel: new Set(), muted: new Set(), chatBanUntil: 0, chatTimes: [], presence: "offline", loadout: null,
      spectating: null, lastRoomCreate: 0, roomPwFails: [],
    };
    // 4000 (e não 4001): demorar para se identificar não é sessão inválida; o cliente só reconecta.
    client.helloTimer = setTimeout(() => ws.close(4000, "hello timeout"), HELLO_TIMEOUT_MS);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.metrics.rejected.inc({ reason: "binary" });
        return ws.close(4002, "binary not supported");
      }
      const now = Date.now();
      if (now - client.msgWindowStart > 1000) {
        client.msgWindowStart = now;
        client.msgCount = 0;
      }
      if (++client.msgCount > MAX_MSGS_PER_SEC) {
        this.metrics.rejected.inc({ reason: "rate_limit" });
        return ws.close(4008, "rate limit");
      }
      let parsed;
      try {
        parsed = clientMessageSchema.safeParse(JSON.parse(data.toString()));
      } catch {
        this.metrics.rejected.inc({ reason: "invalid_json" });
        return ws.close(4002, "invalid json");
      }
      if (!parsed.success) {
        this.metrics.rejected.inc({ reason: "bad_message" });
        this.send(client, { t: "error", code: "BAD_MESSAGE", message: "Mensagem inválida." });
        return;
      }
      this.metrics.messagesIn.inc({ type: parsed.data.t });
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
        return this.enqueue(c, msg.mode, msg.loadout, msg.ranked === true);
      case "cancel_queue":
        this.dequeue(c);
        this.send(c, { t: "queue", state: "idle" });
        return;
      case "loadout": {
        const codes = [...new Set(msg.loadout)];
        if (codes.length === msg.loadout.length && codes.every((code) => this.weapons.has(code))) c.loadout = codes;
        return;
      }
      case "party_invite":
        return this.partyInvite(c, msg.userId);
      case "party_respond":
        return this.partyRespond(c, msg.partyId, msg.accept);
      case "party_leave":
        return this.partyLeave(c.userId);
      case "party_kick":
        return this.partyKick(c, msg.userId);
      case "chat":
        return this.chat(c, msg.channel, msg.text);
      case "room_create":
        return this.roomCreate(c, msg.settings, msg.password);
      case "room_join":
        return this.roomJoin(c, msg.code, msg.password, msg.spectate === true);
      case "room_leave":
        return this.roomLeave(c.userId);
      case "room_update":
        return this.roomUpdate(c, msg.settings, msg.password);
      case "room_team":
        return this.roomTeam(c, msg.userId ?? c.userId, msg.team);
      case "room_kick":
        return this.roomKick(c, msg.userId);
      case "room_lock":
        return this.roomLock(c, msg.locked);
      case "room_start":
        return this.roomStart(c);
      case "room_close":
        return this.roomClose(c);
      case "room_list":
        return this.roomList(c);
      case "room_invite":
        return this.roomInvite(c, msg.userId);
      case "ready":
        c.match?.setReady(c.userId);
        return;
      case "leave_match":
        if (c.spectating) {
          this.stopSpectating(c);
          return;
        }
        if (c.match) {
          c.match.forfeit(c.userId);
          c.match = null;
          this.syncHome(c.userId);
          this.send(c, { t: "left_match" });
          this.updatePresence(c);
        }
        return;
      case "cmd": {
        if (!c.match) return;
        const err = c.match.submitCommands(c.userId, msg.c.map(decodeCommand));
        if (err) {
          this.metrics.rejected.inc({ reason: `cmd_${err}` });
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
      select: { id: true, username: true, status: true, tokenVersion: true, profile: { select: { mainCharacter: { select: { id: true, code: true, primaryColor: true } } } } },
    });
    if (!user || user.status !== "ACTIVE" || user.tokenVersion !== payload.tv) {
      this.send(c, { t: "error", code: "UNAUTHORIZED", message: "Sessão expirada ou conta indisponível.", fatal: true });
      return c.ws.close(4001, "unauthorized");
    }
    if (c.helloTimer) clearTimeout(c.helloTimer);
    // Partida, grupo ou sala em outro nó: vai para lá.
    const home = this.cluster.multiNode ? await this.cluster.home(user.id) : null;
    if (home && home !== this.cluster.nodeId) {
      if (c.ws.readyState !== WebSocket.OPEN) return;
      return this.redirect(c, home);
    }
    c.userId = user.id;
    c.username = user.username;
    c.tokenVersion = user.tokenVersion;
    c.color = user.profile?.mainCharacter?.primaryColor ?? "#287BFF";
    c.characterId = user.profile?.mainCharacter?.id ?? null;
    c.character = user.profile?.mainCharacter?.code ?? "RAVEN";

    // Uma conexão por conta: a nova substitui a antiga (ex.: recarregou a página).
    const old = this.clients.get(user.id);
    if (old && old !== c) {
      this.dequeue(old);
      old.userId = null;
      old.ws.close(4004, "replaced");
    }
    await this.loadRelations(c);
    // A conexão pode ter caído (ou sido substituída) durante as consultas.
    if (c.userId !== user.id || c.ws.readyState !== WebSocket.OPEN) return;
    const replaced = this.clients.get(user.id);
    if (replaced && replaced !== c) {
      this.dequeue(replaced);
      replaced.userId = null;
      replaced.ws.close(4004, "replaced");
    }
    this.clients.set(user.id, c);
    this.userInfo.set(user.id, { username: user.username, character: c.character });
    // Uma conexão por conta também entre nós: o nó antigo derruba a dele.
    if (this.cluster.multiNode) this.track(this.cluster.send({ k: "kick", from: this.cluster.nodeId, userId: user.id }), "conexão única");

    const match = [...this.matches.values()].find((m) => !m.isEnded && m.player(user.id) && !m.player(user.id)!.abandoned);
    this.send(c, { t: "welcome", userId: user.id, username: user.username, inMatch: !!match });
    if (match) {
      c.match = match;
      match.attach(user.id, this.connFor(c));
    }
    // Presença: avisa os amigos e manda para o jogador a situação de cada amigo.
    this.updatePresence(c, true);
    const remote = this.cluster.multiNode ? await this.cluster.presence([...c.friends].filter((id) => !this.clients.has(id))) : new Map<string, PresenceState>();
    if (this.clients.get(user.id) !== c) return;
    this.send(c, { t: "presence", full: true, list: [...c.friends].map((id) => [id, this.clients.get(id)?.presence ?? remote.get(id) ?? "offline"]) });
    // Voltou dentro do prazo: continua no grupo.
    const grace = this.partyGrace.get(user.id);
    if (grace) {
      clearTimeout(grace);
      this.partyGrace.delete(user.id);
    }
    const party = this.parties.of(user.id);
    if (party) this.broadcastParty(party);
    const rg = this.roomGrace.get(user.id);
    if (rg) {
      clearTimeout(rg);
      this.roomGrace.delete(user.id);
    }
    const room = this.rooms.of(user.id);
    if (room) {
      this.broadcastRoom(room);
      if (room.members.get(user.id)!.team === null && room.match && !room.match.isEnded) this.startSpectating(c, room.match);
    }
  }

  /** Amigos, bloqueios, silenciados e banimento de chat (relidos quando a API avisa que mudaram). */
  private async loadRelations(c: Client) {
    const id = c.userId!;
    const now = new Date();
    const db = this.opts.prisma;
    const [friends, blocks, mutes, bans] = await Promise.all([
      db.friend.findMany({ where: { OR: [{ userAId: id }, { userBId: id }] }, select: { userAId: true, userBId: true } }),
      db.userBlock.findMany({ where: { OR: [{ blockerId: id }, { blockedId: id }] }, select: { blockerId: true, blockedId: true } }),
      db.userMute.findMany({ where: { muterId: id }, select: { mutedId: true } }),
      db.ban.findMany({ where: { userId: id, type: "CHAT_MUTE", revokedAt: null, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] }, select: { endsAt: true } }),
    ]);
    c.friends = new Set(friends.map((f) => (f.userAId === id ? f.userBId : f.userAId)));
    c.blockRel = new Set(blocks.map((b) => (b.blockerId === id ? b.blockedId : b.blockerId)));
    c.muted = new Set(mutes.map((m) => m.mutedId));
    c.chatBanUntil = bans.length ? Math.max(...bans.map((b) => (b.endsAt ? b.endsAt.getTime() : Infinity))) : 0;
  }

  // ───────────── Presença ─────────────

  private presenceOf(c: Client): PresenceState {
    if (c.match && !c.match.isEnded) return "match";
    if (c.queued) return "queue";
    if (c.userId && (this.rooms.of(c.userId) || c.spectating)) return "room";
    return "online";
  }

  /** Recalcula a presença e avisa só os amigos conectados (a presença nunca vai para estranhos). */
  private updatePresence(c: Client, force = false, state?: PresenceState) {
    if (!c.userId) return;
    const s = state ?? this.presenceOf(c);
    if (!force && s === c.presence) return;
    c.presence = s;
    for (const fid of c.friends) {
      const f = this.clients.get(fid);
      if (f && f.friends.has(c.userId)) this.send(f, { t: "presence", full: false, list: [[c.userId, s]] });
    }
    // Amigos conectados em outros nós recebem pelo cluster; a presença fica guardada para quem chegar depois.
    if (s !== "offline") this.track(this.cluster.setLocation(c.userId, s), "presença");
    if (this.cluster.multiNode && c.friends.size) this.track(this.cluster.send({ k: "presence", from: this.cluster.nodeId, userId: c.userId, state: s }), "presença");
  }

  // ───────────── Cluster (vários nós) ─────────────

  /** Tem partida, grupo ou sala neste nó? Então este nó é a "casa" do jogador (reconexões vêm para cá). */
  private hasHomeState(userId: string) {
    if ((this.parties.of(userId)?.members.length ?? 0) > 1) return true;
    if (this.rooms.of(userId)) return true;
    for (const m of this.matches.values()) {
      const p = m.player(userId);
      if (p && !p.abandoned && !m.isEnded) return true;
    }
    return false;
  }

  private syncHome(userId: string) {
    this.track(this.hasHomeState(userId) ? this.cluster.setHome(userId) : this.cluster.clearHome(userId), "casa do jogador");
  }

  /** Manda o cliente reconectar em outro nó. */
  private async redirect(c: Client, node: string) {
    const info = (await this.cluster.nodes()).find((n) => n.id === node);
    c.redirecting = true;
    this.send(c, { t: "redirect", node, ...(info?.url ? { url: info.url } : {}) });
    // O cliente fecha sozinho ao receber; se não fechar, fecha aqui.
    setTimeout(() => c.ws.close(4010, "redirect"), 3000).unref();
  }

  private onClusterMessage(m: ClusterMessage) {
    const self = this.cluster.nodeId;
    switch (m.k) {
      case "kick": {
        if (m.from === self) return;
        const old = this.clients.get(m.userId);
        if (!old) return;
        this.dequeue(old);
        this.clients.delete(m.userId);
        old.redirecting = true; // a pessoa continua online, só que em outro nó
        old.userId = null;
        if (old.match) old.match.detach(m.userId);
        old.ws.close(4004, "replaced");
        return;
      }
      case "presence": {
        if (m.from === self) return;
        for (const c of this.clients.values()) if (c.userId && c.friends.has(m.userId)) this.send(c, { t: "presence", full: false, list: [[m.userId, m.state]] });
        return;
      }
      case "redirect": {
        if (m.node === self) return;
        const c = this.clients.get(m.userId);
        if (!c) return;
        // O bilhete dele virou partida em outro nó.
        this.clearTicketOf(c);
        void this.redirect(c, m.node).catch((e) => this.log.error("[game] redirecionamento", e));
        return;
      }
      case "match_create":
        if (m.node === self) this.createMatch(m.spec);
        return;
      case "queue_changed": {
        if (m.from === self) return;
        const [mode, kind] = m.key.split(":") as [QueueMode, string];
        void this.tryMatch(mode, kind === "ranked").catch((e) => this.log.error("[game] fila", e));
        void this.broadcastQueue(mode, kind === "ranked").catch(() => {});
        return;
      }
      default:
        return this.onClusterSocial(m);
    }
  }

  /** Grupos e salas entre nós. */
  private onClusterSocial(m: ClusterMessage) {
    const self = this.cluster.nodeId;
    switch (m.k) {
      case "party_invite": {
        const c = this.clients.get(m.to);
        if (!c || c.blockRel.has(m.inviter.id)) return;
        this.remotePartyInvites.set(m.partyId, m.from);
        this.send(c, { t: "party_invite", partyId: m.partyId, from: m.inviter, expiresAt: m.expiresAt });
        return;
      }
      case "party_respond":
        if (m.node === self) this.partyRespondRemote(m);
        return;
      case "party_rejected":
      case "room_rejected": {
        const c = this.clients.get(m.to);
        if (!c) return;
        if (m.code === "ROOM_BAD_PASSWORD") c.roomPwFails.push(Date.now());
        this.partyError(c, m.code, m.message);
        return;
      }
      case "room_invite": {
        const c = this.clients.get(m.to);
        if (!c || c.blockRel.has(m.inviter.id)) return;
        this.send(c, { t: "room_invite", code: m.code, name: m.name, from: m.inviter, expiresAt: m.expiresAt });
        return;
      }
      case "room_join":
        if (m.node === self) void this.roomJoinRemote(m).catch((e) => this.log.error("[game] entrada remota na sala", e));
        return;
    }
  }

  /** Resposta a convite de grupo de alguém conectado em outro nó (este nó é o do grupo). */
  private partyRespondRemote(m: Extract<ClusterMessage, { k: "party_respond" }>) {
    const reject = (code: string, message: string) => this.track(this.cluster.send({ k: "party_rejected", from: this.cluster.nodeId, to: m.user.id, code, message }), "grupo recusado");
    const p = this.parties.takeInvite(m.partyId, m.user.id);
    if (!p) return reject("INVITE_EXPIRED", "O convite expirou ou foi cancelado.");
    if (!m.accept) {
      const { party, orphaned } = this.parties.dissolveIfAlone(p);
      if (party) this.broadcastParty(party);
      for (const id of orphaned) {
        const oc = this.clients.get(id);
        if (oc) this.send(oc, { t: "party", party: null });
        this.syncHome(id);
      }
      return;
    }
    if (this.parties.isFull(p)) return reject("PARTY_FULL", "O grupo está cheio.");
    const leader = this.clients.get(p.leaderId);
    if (!leader?.friends.has(m.user.id) || leader.blockRel.has(m.user.id)) return reject("INVITE_EXPIRED", "O convite expirou ou foi cancelado.");
    if (leader.queued) {
      this.dequeue(leader);
      this.send(leader, { t: "queue", state: "idle" });
    }
    this.userInfo.set(m.user.id, { username: m.user.username, character: m.user.character });
    this.parties.join(p, m.user.id);
    // Entra como membro ainda desconectado: tem o prazo normal para chegar a este nó.
    this.startPartyGrace(m.user.id);
    this.broadcastParty(p);
    this.track(this.cluster.setHome(m.user.id), "casa do jogador");
    for (const id of p.members) if (id !== m.user.id) this.syncHome(id);
    this.track(this.cluster.send({ k: "redirect", from: this.cluster.nodeId, userId: m.user.id, node: this.cluster.nodeId }), "redirecionamento");
  }

  /** Entrada em sala deste nó pedida por alguém conectado em outro nó. */
  private async roomJoinRemote(m: Extract<ClusterMessage, { k: "room_join" }>) {
    const reject = (code: string, message: string) => this.track(this.cluster.send({ k: "room_rejected", from: this.cluster.nodeId, to: m.user.id, code, message }), "sala recusada");
    let room = this.rooms.byCode(m.code);
    if (!room || m.blocked.includes(room.ownerId)) return reject("ROOM_NOT_FOUND", "Sala não encontrada. Confira o código.");
    const me = m.user.id;
    if (!room.members.has(me)) {
      const invited = this.rooms.hasInvite(room, me);
      if (room.passwordHash && !invited) {
        if (!m.password) return reject("ROOM_PASSWORD", "Esta sala tem senha.");
        const hash = room.passwordHash;
        if (!(await this.hasher.verify(hash, m.password))) return reject("ROOM_BAD_PASSWORD", "Senha incorreta.");
        room = this.rooms.byCode(m.code);
        if (!room || room.passwordHash !== hash) return reject("ROOM_NOT_FOUND", "Sala não encontrada. Confira o código.");
      }
      const team = this.rooms.join(room, me, { spectate: m.spectate, invited });
      if (team !== null && typeof team === "object") return reject(team.code, team.message);
      this.userInfo.set(me, { username: m.user.username, character: m.user.character });
      this.track(
        this.opts.prisma.roomPlayer.upsert({ where: { roomId_userId: { roomId: room.id, userId: me } }, create: { roomId: room.id, userId: me, team }, update: { team, kickedAt: null, joinedAt: new Date() } }),
        "entrada na sala",
      );
      // Ainda desconectado aqui: tem o prazo normal da sala para chegar.
      this.startRoomGrace(me);
      this.broadcastRoom(room);
    }
    await this.cluster.setHome(me);
    await this.cluster.send({ k: "redirect", from: this.cluster.nodeId, userId: me, node: this.cluster.nodeId });
  }

  // ───────────── Eventos sociais (API → aqui → cliente) ─────────────

  private onSocialEvent(to: string, ev: SocialEvent) {
    const c = this.clients.get(to);
    if (!c?.userId) return;
    if (ev.k === "account_changed") {
      // Suspensão/banimento derrubam a conexão agora, sem esperar a reconferência periódica.
      void this.recheckAccounts([to]).catch((e) => this.log.error("[game] reconferência de conta", e));
      return;
    }
    this.send(c, { t: "social", ev });
    if (ev.k === "friend_accepted") {
      c.friends.add(ev.friend.id);
      const local = this.clients.get(ev.friend.id)?.presence;
      if (local || !this.cluster.multiNode) this.send(c, { t: "presence", full: false, list: [[ev.friend.id, local ?? "offline"]] });
      else
        void this.cluster.presence([ev.friend.id]).then((m) => {
          if (this.clients.get(to) === c) this.send(c, { t: "presence", full: false, list: [[ev.friend.id, m.get(ev.friend.id) ?? "offline"]] });
        });
    } else if (ev.k === "friend_removed") {
      c.friends.delete(ev.userId);
      const p = this.parties.get(this.parties.of(to)?.id ?? "");
      if (p?.invites.delete(ev.userId)) this.broadcastParty(p);
    } else if (ev.k === "relations_changed") {
      const userId = c.userId;
      void this.loadRelations(c)
        .then(() => {
          // Bloqueou alguém do próprio grupo: os dois não podem continuar juntos.
          const p = this.parties.of(userId);
          if (!p) return;
          for (const m of p.members) if (m !== userId && c.blockRel.has(m)) return this.partyLeave(p.leaderId === userId ? m : userId);
          for (const inv of p.invites.keys()) if (c.blockRel.has(inv)) p.invites.delete(inv);
        })
        .catch((e) => this.log.error("[game] falha ao recarregar relações", e));
    }
  }

  // ───────────── Grupo ─────────────

  /** Convites de grupo vindos de outros nós: grupo → nó onde ele vive. */
  private remotePartyInvites = new Map<string, string>();

  private partyInfo = (id: string) => {
    const c = this.clients.get(id);
    const info = this.userInfo.get(id);
    return { username: c?.username ?? info?.username ?? "?", character: c?.character ?? info?.character ?? "RAVEN", online: !!c };
  };

  private broadcastParty(p: Party) {
    const view = this.parties.view(p, this.partyInfo);
    for (const m of p.members) {
      const c = this.clients.get(m);
      if (c) this.send(c, { t: "party", party: view });
    }
  }

  private partyError(c: Client, code: string, message: string) {
    this.send(c, { t: "error", code, message });
  }

  private async partyInvite(c: Client, targetId: string) {
    const me = c.userId!;
    const target = this.clients.get(targetId);
    if (!c.friends.has(targetId)) return this.partyError(c, "NOT_FRIEND", "Você só pode convidar amigos.");
    if (c.blockRel.has(targetId)) return this.partyError(c, "NOT_FRIEND", "Você só pode convidar amigos.");
    const remote = !target && this.cluster.multiNode ? await this.cluster.locate(targetId) : null;
    if (!target && !remote) return this.partyError(c, "OFFLINE", "Este amigo está offline.");
    if (this.clients.get(me) !== c) return;
    const current = this.parties.of(me);
    if (current && current.leaderId !== me) return this.partyError(c, "PARTY_NOT_LEADER", "Só o líder pode convidar.");
    if (current?.members.includes(targetId)) return this.partyError(c, "ALREADY_IN_PARTY", "Este amigo já está no seu grupo.");
    if (c.queued) return this.partyError(c, "IN_QUEUE", "Saia da fila antes de convidar.");
    const p = this.parties.ensure(me);
    if (this.parties.isFull(p)) return this.partyError(c, "PARTY_FULL", "O grupo está cheio.");
    const expiresAt = this.parties.invite(p, targetId);
    if (target) this.send(target, { t: "party_invite", partyId: p.id, from: { id: me, username: c.username }, expiresAt });
    else this.track(this.cluster.send({ k: "party_invite", from: this.cluster.nodeId, to: targetId, partyId: p.id, inviter: { id: me, username: c.username }, expiresAt }), "convite de grupo");
    this.broadcastParty(p);
  }

  private partyRespond(c: Client, partyId: string, accept: boolean) {
    const me = c.userId!;
    const remoteNode = !this.parties.get(partyId) ? this.remotePartyInvites.get(partyId) : undefined;
    if (remoteNode) {
      // O grupo vive em outro nó: ele decide; se aceitar, a pessoa é levada para lá.
      this.remotePartyInvites.delete(partyId);
      if (accept) {
        if (c.match && !c.match.isEnded) return this.partyError(c, "IN_MATCH", "Você está em uma partida.");
        if (this.rooms.of(me)) this.roomLeave(me);
        if (this.parties.of(me)) this.partyLeave(me);
        this.dequeue(c);
        this.send(c, { t: "queue", state: "idle" });
      }
      this.track(this.cluster.send({ k: "party_respond", from: this.cluster.nodeId, node: remoteNode, partyId, user: { id: me, username: c.username, character: c.character }, accept }), "resposta de grupo");
      return;
    }
    const p = this.parties.takeInvite(partyId, me);
    if (!p) return this.partyError(c, "INVITE_EXPIRED", "O convite expirou ou foi cancelado.");
    if (!accept) {
      const { party, orphaned } = this.parties.dissolveIfAlone(p);
      if (party) this.broadcastParty(party);
      for (const id of orphaned) {
        const oc = this.clients.get(id);
        if (oc) this.send(oc, { t: "party", party: null });
      }
      return;
    }
    if (c.match && !c.match.isEnded) return this.partyError(c, "IN_MATCH", "Você está em uma partida.");
    if (this.parties.isFull(p)) return this.partyError(c, "PARTY_FULL", "O grupo está cheio.");
    const leader = this.clients.get(p.leaderId);
    if (!leader?.friends.has(me) || c.blockRel.has(p.leaderId)) return this.partyError(c, "INVITE_EXPIRED", "O convite expirou ou foi cancelado.");
    if (this.parties.of(me)) this.partyLeave(me);
    this.dequeue(c);
    this.send(c, { t: "queue", state: "idle" });
    // O grupo mudou: se o líder estava na fila, sai (a fila é do grupo inteiro).
    if (leader.queued) {
      this.dequeue(leader);
      this.send(leader, { t: "queue", state: "idle" });
    }
    this.parties.join(p, me);
    this.updatePresence(c);
    this.broadcastParty(p);
    for (const id of p.members) this.syncHome(id);
  }

  private partyLeave(userId: string) {
    const before = this.parties.of(userId);
    if (!before) return;
    const leaving = this.clients.get(userId);
    if (leaving?.queued) {
      this.dequeue(leaving);
      this.send(leaving, { t: "queue", state: "idle" });
    }
    const { party, orphaned } = this.parties.remove(userId);
    for (const id of [userId, ...orphaned]) this.syncHome(id);
    if (leaving) this.send(leaving, { t: "party", party: null });
    if (party) this.broadcastParty(party);
    for (const id of orphaned) {
      const oc = this.clients.get(id);
      if (oc) this.send(oc, { t: "party", party: null });
    }
  }

  private partyKick(c: Client, targetId: string) {
    const p = this.parties.of(c.userId!);
    if (!p || p.leaderId !== c.userId) return this.partyError(c, "PARTY_NOT_LEADER", "Só o líder pode remover membros.");
    if (targetId === c.userId || !p.members.includes(targetId)) return;
    this.partyLeave(targetId);
  }

  // ───────────── Chat ─────────────

  private chat(c: Client, channel: ChatChannel, raw: string) {
    const me = c.userId!;
    const text = sanitizeChat(raw);
    if (!text) return;
    const now = Date.now();
    if (c.chatBanUntil > now) return this.partyError(c, "CHAT_BANNED", "Seu chat está suspenso pela moderação.");
    c.chatTimes = c.chatTimes.filter((t) => now - t < CHAT_RATE.windowMs);
    if (c.chatTimes.length >= CHAT_RATE.max) return this.partyError(c, "CHAT_RATE", "Calma! Espere alguns segundos para mandar outra mensagem.");
    c.chatTimes.push(now);

    let to: string[];
    if (channel === "party") {
      const p = this.parties.of(me);
      if (!p) return this.partyError(c, "NO_PARTY", "Você não está em um grupo.");
      to = p.members;
    } else if (channel === "room") {
      const room = this.rooms.of(me);
      if (!room) return this.partyError(c, "NO_ROOM", "Você não está em uma sala.");
      // Com a partida rolando, o chat da sala é só de quem assiste: espectador não fala com quem joga.
      const live = room.match && !room.match.isEnded ? room.match : null;
      if (live?.player(me)) return this.partyError(c, "ROOM_CHAT_MATCH", "Durante a partida, use o chat da partida.");
      to = [...room.members.keys()].filter((id) => !live?.player(id));
    } else {
      const m = c.match;
      if (!m || m.isEnded) return this.partyError(c, "NOT_IN_MATCH", "O chat de partida só funciona durante a partida.");
      const self = m.player(me);
      if (!self) return;
      to = m.players.filter((p) => channel === "all" || p.team === self.team).map((p) => p.userId);
      m.recordChat(me, channel, text);
    }
    const msg = { t: "chat" as const, channel, from: { id: me, username: c.username }, text, at: now };
    for (const id of to) {
      const r = this.clients.get(id);
      // Bloqueio (nos dois sentidos) e silêncio são aplicados aqui no servidor: a mensagem nem chega.
      if (!r || (id !== me && (r.blockRel.has(me) || r.muted.has(me)))) continue;
      this.send(r, msg);
    }
  }

  // ───────────── Salas personalizadas ─────────────

  private roomError(c: Client, e: RoomError) {
    this.send(c, { t: "error", code: e.code, message: e.message });
  }

  /** Persistência da sala é um registro (o estado vivo fica na memória); falhas só vão para o log. */
  private track(p: Promise<unknown>, what: string) {
    const t = p.catch((e) => this.log.error(`[game] falha ao gravar ${what}`, e)).finally(() => this.pendingSaves.delete(t));
    this.pendingSaves.add(t);
  }

  private saveRoomStatus(room: Room) {
    const status = room.match && !room.match.isEnded ? "IN_MATCH" : room.locked ? "LOCKED" : "OPEN";
    this.track(this.opts.prisma.room.update({ where: { id: room.id }, data: { status } }), "status da sala");
  }

  private roomDbData(s: RoomSettings) {
    return {
      name: s.name,
      mode: MODES[s.mode].db,
      isPrivate: s.isPrivate,
      maxPlayers: roomMaxPlayers(s.mode),
      roundsToWin: s.roundsToWin,
      roundTimeSec: s.roundTimeSec,
      options: { map: s.map, friendlyFire: s.friendlyFire, headshotsOnly: s.headshotsOnly, weapons: s.weapons, allowSpectators: s.allowSpectators },
    };
  }

  private broadcastRoom(room: Room) {
    const view = this.rooms.view(room, this.partyInfo);
    for (const id of room.members.keys()) {
      const c = this.clients.get(id);
      if (c) this.send(c, { t: "room", room: view });
    }
    this.publishRoom(room);
  }

  /** Registro das salas no cluster: código → nó, e a linha da lista pública. */
  private publishRoom(room: Room) {
    if (!this.cluster.multiNode) return;
    if (this.rooms.byCode(room.code) !== room) {
      this.track(this.cluster.roomDel(room.code), "registro da sala");
      return;
    }
    const item = { ...this.rooms.listItem(room, this.partyInfo(room.ownerId).username), ownerId: room.ownerId, isPrivate: room.settings.isPrivate };
    this.track(this.cluster.roomPut(room.code, { node: this.cluster.nodeId, json: JSON.stringify(item) }), "registro da sala");
    for (const id of room.members.keys()) this.syncHome(id);
  }

  /** Membro desconectado continua no grupo por um tempo (recarregar a página, ou trocar de nó). */
  private startPartyGrace(userId: string) {
    const old = this.partyGrace.get(userId);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.partyGrace.delete(userId);
      if (!this.clients.has(userId)) this.partyLeave(userId);
    }, this.opts.partyGraceMs ?? 60_000);
    t.unref();
    this.partyGrace.set(userId, t);
  }

  private startRoomGrace(userId: string) {
    if (this.roomGrace.has(userId)) return;
    const t = setTimeout(() => {
      this.roomGrace.delete(userId);
      if (!this.clients.has(userId)) this.roomLeave(userId);
    }, this.opts.roomGraceMs ?? 30_000);
    t.unref();
    this.roomGrace.set(userId, t);
  }

  private startSpectating(c: Client, match: Match) {
    if (c.spectating && c.spectating !== match) c.spectating.removeSpectator(c.userId!);
    if (match.addSpectator(c.userId!, this.connFor(c))) c.spectating = match;
  }

  private stopSpectating(c: Client, notify = true) {
    if (!c.spectating) return;
    c.spectating.removeSpectator(c.userId!);
    c.spectating = null;
    if (notify) this.send(c, { t: "spec_end" });
  }

  /** Sai da fila e da sala anterior antes de entrar em outra. Devolve false se está jogando. */
  private freeForRoom(c: Client): boolean {
    if (c.match && !c.match.isEnded) {
      this.partyError(c, "IN_MATCH", "Você está em uma partida.");
      return false;
    }
    if (c.queued) {
      this.dequeue(c);
      this.send(c, { t: "queue", state: "idle" });
    }
    return true;
  }

  private async roomCreate(c: Client, settings: RoomSettings, password?: string) {
    const me = c.userId!;
    if (!this.freeForRoom(c)) return;
    const now = Date.now();
    if (now - c.lastRoomCreate < 5_000) return this.partyError(c, "ROOM_RATE", "Espere alguns segundos para criar outra sala.");
    c.lastRoomCreate = now;
    const db = this.opts.prisma;
    const map = await db.gameMap.findUnique({ where: { code: settings.map }, select: { id: true } });
    if (!map) return this.partyError(c, "ROOM_BAD_MAP", "Mapa indisponível.");
    const passwordHash = password ? await this.hasher.hash(password) : null;
    let row: { id: string; code: string } | null = null;
    for (let i = 0; i < 6 && !row; i++) {
      const code = makeRoomCode(() => randomInt(0, 1_000_000) / 1_000_000);
      if (this.rooms.byCode(code)) continue;
      try {
        row = await db.room.create({ data: { code, ownerId: me, mapId: map.id, passwordHash, ...this.roomDbData(settings), players: { create: { userId: me, team: 0 } } }, select: { id: true, code: true } });
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e;
      }
    }
    if (!row) return this.partyError(c, "ROOM_CODE", "Não foi possível gerar um código. Tente de novo.");
    // A conexão pode ter caído ou entrado em partida enquanto gravávamos.
    if (this.clients.get(me) !== c || (c.match && !c.match.isEnded)) {
      this.track(db.room.update({ where: { id: row.id }, data: { status: "CLOSED", closedAt: new Date() } }), "sala abandonada");
      return;
    }
    if (this.rooms.of(me)) this.roomLeave(me);
    const room = this.rooms.create(row.id, row.code, me, settings, passwordHash);
    this.log.info(`[game] sala ${room.code} criada por ${c.username}`);
    this.broadcastRoom(room);
    this.updatePresence(c);
  }

  private async roomJoin(c: Client, rawCode: string, password: string | undefined, spectate: boolean) {
    const me = c.userId!;
    const code = normalizeRoomCode(rawCode);
    let room = this.rooms.byCode(code);
    if (!room && this.cluster.multiNode) {
      // A sala está em outro nó: o nó dela decide (senha, vagas, banimento) e, se der certo, a pessoa vai para lá.
      const entry = await this.cluster.roomGet(code);
      if (entry && entry.node !== this.cluster.nodeId) {
        if (!this.freeForRoom(c)) return;
        const now = Date.now();
        c.roomPwFails = c.roomPwFails.filter((t) => now - t < 60_000);
        if (c.roomPwFails.length >= 5) return this.partyError(c, "ROOM_RATE", "Muitas tentativas. Espere um minuto.");
        await this.cluster.send({ k: "room_join", from: this.cluster.nodeId, node: entry.node, code, user: { id: me, username: c.username, character: c.character, color: c.color }, password, spectate, blocked: [...c.blockRel] });
        return;
      }
    }
    // Quem foi bloqueado pelo dono não descobre que a sala existe.
    if (!room || c.blockRel.has(room.ownerId)) return this.partyError(c, "ROOM_NOT_FOUND", "Sala não encontrada. Confira o código.");
    const already = room.members.get(me);
    if (already) {
      // Já está na sala (ex.: voltou do espectador para o lobby e quer assistir de novo).
      if (already.team === null && room.match && !room.match.isEnded) this.startSpectating(c, room.match);
      else this.send(c, { t: "room", room: this.rooms.view(room, this.partyInfo) });
      return;
    }
    if (!this.freeForRoom(c)) return;
    const invited = this.rooms.hasInvite(room, me);
    if (room.passwordHash && !invited) {
      if (!password) return this.partyError(c, "ROOM_PASSWORD", "Esta sala tem senha.");
      const now = Date.now();
      c.roomPwFails = c.roomPwFails.filter((t) => now - t < 60_000);
      if (c.roomPwFails.length >= 5) return this.partyError(c, "ROOM_RATE", "Muitas tentativas. Espere um minuto.");
      const hash = room.passwordHash;
      if (!(await this.hasher.verify(hash, password))) {
        c.roomPwFails.push(now);
        return this.partyError(c, "ROOM_BAD_PASSWORD", "Senha incorreta.");
      }
      // A sala pode ter fechado (ou trocado de senha) durante a verificação.
      room = this.rooms.byCode(code);
      if (!room || room.passwordHash !== hash) return this.partyError(c, "ROOM_NOT_FOUND", "Sala não encontrada. Confira o código.");
      if (this.clients.get(me) !== c || (c.match && !c.match.isEnded)) return;
    }
    const other = this.rooms.of(me);
    if (other && other !== room) this.roomLeave(me);
    const team = this.rooms.join(room, me, { spectate, invited });
    if (team !== null && typeof team === "object") return this.roomError(c, team);
    this.track(
      this.opts.prisma.roomPlayer.upsert({ where: { roomId_userId: { roomId: room.id, userId: me } }, create: { roomId: room.id, userId: me, team }, update: { team, kickedAt: null, joinedAt: new Date() } }),
      "entrada na sala",
    );
    this.broadcastRoom(room);
    this.updatePresence(c);
    if (team === null && room.match && !room.match.isEnded) this.startSpectating(c, room.match);
  }

  private roomLeave(userId: string | null, reason: "left" | "kicked" | "closed" = "left") {
    if (!userId) return;
    const room = this.rooms.of(userId);
    if (!room) return;
    const c = this.clients.get(userId);
    if (c) this.stopSpectating(c, false);
    const { closed, newOwner } = this.rooms.leave(room, userId);
    if (c) this.send(c, { t: "room", room: null, reason });
    const db = this.opts.prisma;
    if (reason === "kicked") this.track(db.roomPlayer.updateMany({ where: { roomId: room.id, userId }, data: { kickedAt: new Date() } }), "remoção da sala");
    else this.track(db.roomPlayer.deleteMany({ where: { roomId: room.id, userId } }), "saída da sala");
    this.syncHome(userId);
    if (closed) {
      this.publishRoom(room);
      this.track(db.room.update({ where: { id: room.id }, data: { status: "CLOSED", closedAt: new Date() } }), "sala vazia");
    } else {
      if (newOwner) this.track(db.room.update({ where: { id: room.id }, data: { ownerId: newOwner } }), "novo dono da sala");
      this.broadcastRoom(room);
    }
    if (c) this.updatePresence(c);
  }

  /** Sala da qual o cliente é dono (ou erro). */
  private ownedRoom(c: Client): Room | null {
    const room = this.rooms.of(c.userId!);
    if (!room) {
      this.partyError(c, "NO_ROOM", "Você não está em uma sala.");
      return null;
    }
    if (room.ownerId !== c.userId) {
      this.partyError(c, "ROOM_NOT_OWNER", "Só o dono da sala pode fazer isso.");
      return null;
    }
    return room;
  }

  private async roomUpdate(c: Client, settings: RoomSettings, password: string | null | undefined) {
    let room = this.ownedRoom(c);
    if (!room) return;
    const bad = this.rooms.checkSettings(room, settings);
    if (bad) return this.roomError(c, bad);
    const map = await this.opts.prisma.gameMap.findUnique({ where: { code: settings.map }, select: { id: true } });
    if (!map) return this.partyError(c, "ROOM_BAD_MAP", "Mapa indisponível.");
    const hash = password === undefined ? room.passwordHash : password === null ? null : await this.hasher.hash(password);
    // Confere de novo depois das esperas (alguém pode ter entrado num time ou a partida começado).
    room = this.rooms.of(c.userId!);
    if (!room || room.ownerId !== c.userId) return;
    const again = this.rooms.checkSettings(room, settings);
    if (again) return this.roomError(c, again);
    room.settings = settings;
    room.passwordHash = hash;
    this.track(this.opts.prisma.room.update({ where: { id: room.id }, data: { ...this.roomDbData(settings), mapId: map.id, passwordHash: hash } }), "regras da sala");
    this.broadcastRoom(room);
  }

  private roomTeam(c: Client, target: string, team: RoomTeam) {
    const room = this.rooms.of(c.userId!);
    if (!room) return this.partyError(c, "NO_ROOM", "Você não está em uma sala.");
    if (target !== c.userId && room.ownerId !== c.userId) return this.partyError(c, "ROOM_NOT_OWNER", "Só o dono da sala pode mover outros jogadores.");
    const e = this.rooms.setTeam(room, target, team);
    if (e) return this.roomError(c, e);
    this.track(this.opts.prisma.roomPlayer.updateMany({ where: { roomId: room.id, userId: target }, data: { team } }), "time na sala");
    this.broadcastRoom(room);
  }

  private roomKick(c: Client, target: string) {
    const room = this.ownedRoom(c);
    if (!room || target === c.userId || !room.members.has(target)) return;
    if (room.match && !room.match.isEnded && room.match.player(target)) return this.partyError(c, "ROOM_IN_MATCH", "Não dá para remover quem está jogando a partida em andamento.");
    room.banned.add(target);
    room.invites.delete(target);
    this.roomLeave(target, "kicked");
  }

  private roomLock(c: Client, locked: boolean) {
    const room = this.ownedRoom(c);
    if (!room) return;
    room.locked = locked;
    this.saveRoomStatus(room);
    this.broadcastRoom(room);
  }

  private roomClose(c: Client) {
    const room = this.ownedRoom(c);
    if (!room) return;
    if (room.match && !room.match.isEnded) return this.partyError(c, "ROOM_IN_MATCH", "Espere a partida acabar para encerrar a sala.");
    const ids = this.rooms.close(room);
    this.publishRoom(room);
    for (const id of ids) this.syncHome(id);
    for (const id of ids) {
      const m = this.clients.get(id);
      if (!m) continue;
      this.stopSpectating(m, false);
      this.send(m, { t: "room", room: null, reason: "closed" });
      this.updatePresence(m);
    }
    this.track(this.opts.prisma.room.update({ where: { id: room.id }, data: { status: "CLOSED", closedAt: new Date() } }), "sala encerrada");
  }

  /** Lista pública: só salas não privadas (as privadas só por código ou convite). */
  private async roomList(c: Client) {
    const local = this.rooms
      .all()
      .filter((r) => !r.settings.isPrivate && !c.blockRel.has(r.ownerId))
      .map((r) => this.rooms.listItem(r, this.partyInfo(r.ownerId).username));
    // Salas de outros nós (pelo registro do cluster).
    const remote = this.cluster.multiNode
      ? (await this.cluster.roomAll())
          .filter((e) => e.node !== this.cluster.nodeId)
          .map((e) => JSON.parse(e.json) as RoomListItem & { ownerId: string; isPrivate: boolean })
          .filter((r) => !r.isPrivate && !c.blockRel.has(r.ownerId))
          .map(({ ownerId: _o, isPrivate: _p, ...item }) => item as RoomListItem)
      : [];
    const rooms = [...local, ...remote]
      .sort((a, b) => Number(a.status === "in_match") - Number(b.status === "in_match") || Number(a.locked) - Number(b.locked) || b.players - a.players)
      .slice(0, 50);
    this.send(c, { t: "room_list", rooms });
  }

  private async roomInvite(c: Client, targetId: string) {
    const room = this.rooms.of(c.userId!);
    if (!room) return this.partyError(c, "NO_ROOM", "Você não está em uma sala.");
    if (!c.friends.has(targetId) || c.blockRel.has(targetId)) return this.partyError(c, "NOT_FRIEND", "Você só pode convidar amigos.");
    const target = this.clients.get(targetId);
    const remote = !target && this.cluster.multiNode ? await this.cluster.locate(targetId) : null;
    if (!target && !remote) return this.partyError(c, "OFFLINE", "Este amigo está offline.");
    if (room.members.has(targetId)) return this.partyError(c, "ALREADY_IN_ROOM", "Este amigo já está na sala.");
    if (room.locked) return this.partyError(c, "ROOM_LOCKED", "A sala está trancada.");
    if (room.banned.has(targetId)) return this.partyError(c, "ROOM_BANNED", "Este jogador foi removido da sala.");
    const expiresAt = Date.now() + ROOM_INVITE_TTL_MS;
    room.invites.set(targetId, expiresAt);
    if (target) this.send(target, { t: "room_invite", code: room.code, name: room.settings.name, from: { id: c.userId!, username: c.username }, expiresAt });
    else this.track(this.cluster.send({ k: "room_invite", from: this.cluster.nodeId, to: targetId, code: room.code, name: room.settings.name, inviter: { id: c.userId!, username: c.username }, expiresAt }), "convite de sala");
  }

  /** Arsenal na sala: o escolhido em Jogar, filtrado pelas categorias liberadas (completa com armas permitidas). */
  private roomLoadout(codes: string[] | null, allowed: string[]): WeaponStats[] {
    const ok = (w: WeaponStats) => allowed.includes(w.category);
    const chosen = (this.resolveLoadout(codes ?? DEFAULT_LOADOUT) ?? []).filter(ok);
    if (chosen.length) return chosen;
    const pool = [...this.weapons.values()].filter(ok).sort((a, b) => a.code.localeCompare(b.code));
    const picked: WeaponStats[] = [];
    for (const cat of allowed) {
      const w = pool.find((x) => x.category === cat);
      if (w && picked.length < 3) picked.push(w);
    }
    return picked;
  }

  private async roomStart(c: Client) {
    const room = this.ownedRoom(c);
    if (!room) return;
    const bad = this.rooms.canStart(room);
    if (bad) return this.roomError(c, bad);
    const players = this.rooms.players(room);
    for (const m of players) {
      const mc = this.clients.get(m.userId);
      if (!mc) return this.partyError(c, "ROOM_PLAYER_OFFLINE", `${this.partyInfo(m.userId).username} está offline.`);
      if (mc.match && !mc.match.isEnded) return this.partyError(c, "ROOM_PLAYER_BUSY", `${mc.username} ainda está em outra partida.`);
    }
    const settings = room.settings;
    const seats: Array<{ team: 0 | 1; client: Client; seat: MatchSeat }> = [];
    for (const m of players) {
      const mc = this.clients.get(m.userId)!;
      const loadout = this.roomLoadout(mc.loadout, settings.weapons);
      if (!loadout.length) return this.partyError(c, "ROOM_NO_WEAPONS", "Nenhuma arma disponível nas categorias liberadas.");
      const cosmetics = await this.cosmeticsFor(mc, loadout);
      seats.push({ team: m.team as 0 | 1, client: mc, seat: { userId: mc.userId!, username: mc.username, color: mc.color, characterId: mc.characterId, character: mc.character, loadout, cosmetics } });
    }
    // Algo mudou durante a leitura dos cosméticos (alguém saiu, trocou de time, regra nova): o dono tenta de novo.
    const now = this.rooms.of(c.userId!);
    const same = now === room && room.settings === settings && !room.match && this.rooms.players(room).map((m) => `${m.userId}:${m.team}`).join() === players.map((m) => `${m.userId}:${m.team}`).join();
    if (!same || seats.some((s) => this.clients.get(s.client.userId!) !== s.client || (s.client.match && !s.client.match.isEnded))) return this.partyError(c, "ROOM_CHANGED", "A sala mudou. Tente começar de novo.");

    const match = new Match({
      id: randomUUID(),
      mode: settings.mode,
      mapCode: settings.map,
      map: MAP_REGISTRY[settings.map]!,
      teams: [seats.filter((s) => s.team === 0).map((s) => s.seat), seats.filter((s) => s.team === 1).map((s) => s.seat)],
      seed: randomInt(1, 2 ** 31),
      custom: { roomId: room.id, roundsToWin: settings.roundsToWin, rules: { roundTimeSec: settings.roundTimeSec, friendlyFire: settings.friendlyFire, headshotsOnly: settings.headshotsOnly } },
      onEnd: (r) => this.onMatchEnd(match, r),
    });
    this.matches.set(match.id, match);
    this.metrics.matchesStarted.inc({ mode: match.mode });
    room.match = match;
    room.invites.clear();
    for (const s of seats) {
      s.client.match = match;
      match.attach(s.client.userId!, this.connFor(s.client));
      this.updatePresence(s.client);
    }
    for (const sp of this.rooms.spectators(room)) {
      const sc = this.clients.get(sp.userId);
      if (sc) this.startSpectating(sc, match);
    }
    this.saveRoomStatus(room);
    this.broadcastRoom(room);
    this.log.info(`[game] sala ${room.code}: partida ${match.id} (${settings.mode}, ${settings.map}) iniciada`);
  }

  private resolveLoadout(codes: string[]): WeaponStats[] | null {
    const unique = [...new Set(codes)];
    const loadout = unique.map((code) => this.weapons.get(code)).filter((w): w is WeaponStats => !!w);
    return loadout.length === codes.length ? loadout : null;
  }

  /** Cosméticos equipados (só aparência): skin do operador atual e das armas escolhidas. */
  private async cosmeticsFor(c: Client, loadout: WeaponStats[]): Promise<MatchCosmetics> {
    const equipped = await equippedCosmetics(this.opts.prisma, c.userId!);
    return {
      character: equipped.characters[c.character] ?? null,
      weapons: Object.fromEntries(loadout.filter((w) => equipped.weapons[w.code]).map((w) => [w.code, equipped.weapons[w.code]!])),
    };
  }

  private async enqueue(c: Client, mode: QueueMode, codes: string[], ranked: boolean) {
    if (c.match && !c.match.isEnded) {
      this.send(c, { t: "error", code: "IN_MATCH", message: "Você já está em uma partida." });
      return;
    }
    if (this.rooms.of(c.userId!)) return this.partyError(c, "IN_ROOM", "Saia da sala personalizada antes de entrar na fila.");
    const loadout = this.resolveLoadout(codes);
    if (!loadout) {
      this.send(c, { t: "error", code: "BAD_LOADOUT", message: "Arsenal inválido." });
      return;
    }
    const userId = c.userId!;
    c.loadout = loadout.map((w) => w.code);

    // Grupo: só o líder entra na fila, e leva todo mundo junto.
    const party = this.parties.of(userId);
    const members: Client[] = [c];
    if (party && party.members.length > 1) {
      if (party.leaderId !== userId) return this.partyError(c, "PARTY_NOT_LEADER", "Só o líder do grupo pode entrar na fila.");
      if (ranked) return this.partyError(c, "PARTY_RANKED", "Por enquanto o ranqueado é só individual. Grupos jogam no casual.");
      if (party.members.length > MODES[mode].teamSize) return this.partyError(c, "PARTY_TOO_BIG", `Seu grupo tem ${party.members.length} pessoas: escolha um modo com times desse tamanho.`);
      for (const id of party.members) {
        if (id === userId) continue;
        const mc = this.clients.get(id);
        if (!mc) return this.partyError(c, "PARTY_MEMBER_OFFLINE", `${this.partyInfo(id).username} está offline.`);
        if (mc.match && !mc.match.isEnded) return this.partyError(c, "PARTY_MEMBER_BUSY", `${mc.username} ainda está em uma partida.`);
        members.push(mc);
      }
    }

    const entries: TicketEntry[] = [];
    for (const m of members) {
      // Os outros membros usam o arsenal que escolheram na tela Jogar (ou o padrão).
      const lo = m === c ? loadout : (this.resolveLoadout(m.loadout ?? DEFAULT_LOADOUT) ?? this.resolveLoadout(DEFAULT_LOADOUT) ?? loadout);
      entries.push({ userId: m.userId!, username: m.username, color: m.color, characterId: m.characterId, character: m.character, loadout: lo.map((w) => w.code), cosmetics: await this.cosmeticsFor(m, lo) });
    }
    let mmr = 0;
    if (ranked) {
      const season = await getActiveSeason(this.opts.prisma);
      if (!season) {
        this.send(c, { t: "error", code: "NO_SEASON", message: "Não há temporada ranqueada em andamento." });
        return;
      }
      // Banimento do ranqueado (painel administrativo) vale para qualquer membro do grupo.
      const now = new Date();
      const rankedBan = await this.opts.prisma.ban.findFirst({
        where: { userId: { in: members.map((m) => m.userId!).filter(Boolean) }, type: "RANKED_BAN", revokedAt: null, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        select: { userId: true, endsAt: true },
      });
      if (rankedBan) {
        const who = rankedBan.userId === userId ? "Você está" : `${members.find((m) => m.userId === rankedBan.userId)?.username ?? "Um membro do grupo"} está`;
        const until = rankedBan.endsAt ? ` até ${rankedBan.endsAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : "";
        this.send(c, { t: "error", code: "RANKED_BANNED", message: `${who} banido do ranqueado${until}.` });
        return;
      }
      const cooldown = await rankedCooldownSeconds(this.opts.prisma, userId);
      if (cooldown > 0) {
        this.send(c, { t: "error", code: "RANKED_COOLDOWN", message: `Você abandonou uma partida ranqueada. Fila liberada em ${Math.ceil(cooldown / 60)} min.` });
        return;
      }
      mmr = (await getOrCreateRating(this.opts.prisma, season, mode, userId)).mmr;
    }
    // A conexão pode ter caído, entrado em partida ou o grupo mudado enquanto consultávamos o banco.
    if (c.userId !== userId || this.clients.get(userId) !== c || (c.match && !c.match.isEnded)) return;
    const nowParty = this.parties.of(userId);
    const expected = party && party.members.length > 1 ? party.members : [userId];
    const current = nowParty && nowParty.members.length > 1 ? nowParty.members : [userId];
    if (expected.join() !== current.join() || members.some((m) => this.clients.get(m.userId!) !== m || (m.match && !m.match.isEnded))) return;

    for (const m of members) this.dequeue(m);
    const key = queueKey(mode, ranked);
    const ticket: Ticket = { id: randomUUID(), node: this.cluster.nodeId, entries, since: Date.now(), mmr };
    this.localTickets.set(ticket.id, { key, mode, ranked, since: ticket.since, userIds: members.map((m) => m.userId!) });
    for (const m of members) {
      m.queued = { mode, ranked, ticketId: ticket.id };
      this.updatePresence(m);
    }
    await this.cluster.queueAdd(key, ticket);
    if (this.cluster.multiNode) void this.cluster.send({ k: "queue_changed", from: this.cluster.nodeId, key }).catch(() => {});
    await this.tryMatch(mode, ranked);
    await this.broadcastQueue(mode, ranked);
  }

  /** Tira da fila o bilhete inteiro de quem pediu (se é um grupo, o grupo todo sai). */
  private dequeue(c: Client) {
    if (!c.queued) return;
    const { mode, ranked, ticketId } = c.queued;
    const local = this.localTickets.get(ticketId);
    this.localTickets.delete(ticketId);
    c.queued = null;
    this.updatePresence(c);
    for (const id of local?.userIds ?? []) {
      const m = this.clients.get(id);
      if (!m || m === c || m.queued?.ticketId !== ticketId) continue;
      m.queued = null;
      this.send(m, { t: "queue", state: "idle" });
      this.updatePresence(m);
    }
    this.track(
      this.cluster.queueRemove(queueKey(mode, ranked), ticketId).then(() => this.broadcastQueue(mode, ranked)),
      "saída da fila",
    );
  }

  /** Manda para quem está na fila deste nó quantas pessoas há na fila (de todos os nós). */
  private async broadcastQueue(mode: QueueMode, ranked: boolean) {
    const key = queueKey(mode, ranked);
    const mine = [...this.localTickets.values()].filter((t) => t.key === key);
    if (!mine.length) return;
    const all = await this.cluster.queueAll(key);
    const needed = MODES[mode].teamSize * 2;
    const inQueue = all.reduce((n, t) => n + t.entries.length, 0);
    for (const t of mine)
      for (const id of t.userIds) {
        const c = this.clients.get(id);
        if (c?.queued && this.localTickets.has(c.queued.ticketId) && c.queued.ticketId && queueKey(c.queued.mode, c.queued.ranked) === key)
          this.send(c, { t: "queue", state: "searching", mode, ranked, inQueue, needed, since: t.since });
      }
  }

  /** Reavalia as filas (exposto para testes). Ranqueada: a janela de MMR abre com a espera. Com vários nós, também casual. */
  async matchmakingTick(now = Date.now()) {
    for (const mode of Object.keys(MODES) as QueueMode[]) {
      await this.tryMatch(mode, true, now);
      if (this.cluster.multiNode) await this.tryMatch(mode, false, now);
    }
  }

  private matching = new Set<string>();

  /** Só o líder do cluster forma partidas; os bilhetes saem da fila de forma atômica (todos ou nenhum). */
  private async tryMatch(mode: QueueMode, ranked: boolean, now = Date.now()): Promise<void> {
    const key = queueKey(mode, ranked);
    if (this.matching.has(key)) return;
    this.matching.add(key);
    try {
      if (!(await this.cluster.isLeader())) return;
      const teamSize = MODES[mode].teamSize;
      for (let guard = 0; guard < 50; guard++) {
        const q = await this.cluster.queueAll(key);
        let teams: [TicketEntry[], TicketEntry[]];
        let used: Ticket[];
        if (ranked) {
          // Ranqueada (sempre individual): MMR próximo (a janela abre com a espera) e equipes balanceadas pela soma de MMR.
          if (q.length < teamSize * 2) return;
          const picked = pickMatchGroup(q.map((t) => ({ id: t.entries[0]!.userId, mmr: t.mmr, waitedMs: now - t.since })), teamSize * 2);
          if (!picked) return;
          const ids = new Set(picked.map((p) => p.id));
          used = q.filter((t) => ids.has(t.entries[0]!.userId));
          const [a, b] = balanceTeams(used.map((t) => ({ ...t.entries[0]!, mmr: t.mmr })));
          teams = [a.map(({ mmr: _m, ...e }) => e), b.map(({ mmr: _m, ...e }) => e)];
        } else {
          // Casual: ordem de chegada, sem separar grupos.
          const packed = packParties(q.map((t) => t.entries.length), teamSize);
          if (!packed) return;
          teams = [packed[0].flatMap((i) => q[i]!.entries), packed[1].flatMap((i) => q[i]!.entries)];
          used = [...packed[0], ...packed[1]].map((i) => q[i]!);
        }
        // Outro processo (ou a saída de alguém) pegou um bilhete no meio do caminho: lê a fila de novo.
        if (!(await this.cluster.queueTake(key, used.map((t) => t.id)))) continue;
        const mapCode = this.rotation[this.rotationIndex++ % this.rotation.length]!;
        const spec: MatchSpec = { id: randomUUID(), mode, ranked, mapCode, seed: randomInt(1, 2 ** 31), teams };
        const node = await this.pickNode(used);
        if (node === this.cluster.nodeId) this.createMatch(spec);
        else await this.cluster.send({ k: "match_create", from: this.cluster.nodeId, node, spec });
      }
    } finally {
      this.matching.delete(key);
    }
  }

  /** A partida vai para o nó com mais jogadores dela (menos gente precisa trocar de nó); empate: o menos carregado. */
  private async pickNode(tickets: Ticket[]): Promise<string> {
    if (!this.cluster.multiNode) return this.cluster.nodeId;
    const nodes = await this.cluster.nodes();
    const load = new Map(nodes.map((n) => [n.id, n.load]));
    const count = new Map<string, number>();
    // Grupos pesam mais: o grupo vive no nó dele e, se os membros saíssem de lá, o grupo se desfaria.
    for (const t of tickets) if (load.has(t.node) || t.node === this.cluster.nodeId) count.set(t.node, (count.get(t.node) ?? 0) + t.entries.length + (t.entries.length > 1 ? 100 : 0));
    const best = [...count.entries()].sort((a, b) => b[1] - a[1] || (load.get(a[0]) ?? 0) - (load.get(b[0]) ?? 0))[0];
    return best?.[0] ?? this.cluster.nodeId;
  }

  /** Cria a partida neste nó. Quem está conectado em outro nó é mandado para cá. */
  private createMatch(spec: MatchSpec) {
    const seat = (e: TicketEntry): MatchSeat => {
      const loadout = this.resolveLoadout(e.loadout) ?? this.resolveLoadout(DEFAULT_LOADOUT)!;
      return { userId: e.userId, username: e.username, color: e.color, characterId: e.characterId, character: e.character, loadout, cosmetics: e.cosmetics };
    };
    const map = MAP_REGISTRY[spec.mapCode]!;
    const match = new Match({
      id: spec.id,
      mode: spec.mode,
      mapCode: spec.mapCode,
      map,
      ranked: spec.ranked,
      teams: [spec.teams[0].map(seat), spec.teams[1].map(seat)],
      seed: spec.seed,
      onEnd: (r) => this.onMatchEnd(match, r),
    });
    this.matches.set(match.id, match);
    this.metrics.matchesStarted.inc({ mode: match.mode });
    const all = [...spec.teams[0], ...spec.teams[1]];
    for (const e of all) {
      this.track(this.cluster.setHome(e.userId), "casa do jogador");
      const c = this.clients.get(e.userId);
      if (c) {
        this.clearTicketOf(c);
        c.match = match;
        match.attach(e.userId, this.connFor(c));
        this.updatePresence(c);
      } else {
        // Ainda não está aqui: conta como desconectado (prazo normal de volta) e é chamado para este nó.
        match.detach(e.userId);
        this.track(this.cluster.send({ k: "redirect", from: this.cluster.nodeId, userId: e.userId, node: this.cluster.nodeId }), "redirecionamento");
      }
    }
    this.log.info(`[game] partida ${match.id} (${spec.mode}${spec.ranked ? ", ranqueada" : ""}) criada: ${all.map((e) => e.username).join(", ")}`);
  }

  /** O bilhete virou partida: a pessoa sai da fila sem mexer no cluster (o bilhete já saiu de lá). */
  private clearTicketOf(c: Client) {
    if (!c.queued) return;
    this.localTickets.delete(c.queued.ticketId);
    c.queued = null;
  }

  private onClose(c: Client) {
    if (c.helloTimer) clearTimeout(c.helloTimer);
    if (!c.userId) return;
    const userId = c.userId;
    this.dequeue(c);
    if (c.match) c.match.detach(userId);
    if (c.spectating) {
      c.spectating.removeSpectator(userId);
      c.spectating = null;
    }
    if (this.clients.get(userId) !== c) return;
    this.clients.delete(userId);
    this.track(this.cluster.clearLocation(userId), "localização");
    // Mandado para outro nó: lá ele reaparece; não pisca "offline" para os amigos.
    if (!c.redirecting) this.updatePresence(c, true, "offline");
    void this.opts.prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } }).catch(() => {});
    // No grupo, quem cai tem um prazo para voltar (recarregar a página não desfaz o grupo).
    const party = this.parties.of(userId);
    if (party) {
      this.broadcastParty(party);
      this.startPartyGrace(userId);
    }
    const room = this.rooms.of(userId);
    if (room) {
      this.broadcastRoom(room);
      if (!room.match?.player(userId) || room.match.isEnded) this.startRoomGrace(userId);
    }
  }

  private onMatchEnd(match: Match, r: MatchResult) {
    this.metrics.matchesEnded.inc({ mode: match.mode });
    // Depois que a partida sai da lista, quem não tem grupo nem sala aqui deixa de ter "casa" neste nó.
    setTimeout(() => {
      for (const p of match.players) this.syncHome(p.userId);
    }, 0);
    for (const c of this.clients.values())
      if (c.match === match) {
        c.match = null;
        this.updatePresence(c);
      }
    const room = this.rooms.all().find((x) => x.match === match);
    if (room) {
      // A sala volta para o lobby; quem caiu durante a partida ganha o prazo normal para voltar.
      room.match = null;
      for (const id of room.members.keys()) if (!this.clients.has(id)) this.startRoomGrace(id);
      this.broadcastRoom(room);
      this.saveRoomStatus(room);
    }
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
    // Ranqueada: vale a temporada em andamento quando a partida termina (se ela acabou no meio, a partida não pontua).
    const season = r.ranked ? await getActiveSeason(db, r.endedAt) : null;
    const { ranked: rankedUpdates, progress } = await db.$transaction(async (tx) => {
      const ranked = season ? await applyRankedMatch(tx, season, r) : [];
      const rankedOf = (id: string) => ranked.find((u) => u.userId === id);
      await tx.match.create({
        data: {
          id: r.matchId,
          mode: MODES[r.mode].db,
          type: r.ranked ? "RANKED" : r.roomId ? "CUSTOM" : "CASUAL",
          roomId: r.roomId,
          seasonId: season?.id ?? null,
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
              pointsDelta: rankedOf(p.id)?.pointsDelta ?? null,
              mmrBefore: rankedOf(p.id)?.mmrBefore ?? null,
              mmrAfter: rankedOf(p.id)?.mmrAfter ?? null,
            })),
          },
          events: { create: r.events.map((e) => ({ tick: e.tick, round: e.round, type: e.type, actorId: e.actorId ?? null, targetId: e.targetId ?? null, data: e.data })) },
        },
      });
      // Partida de sala personalizada fica no histórico, mas não mexe nas estatísticas do perfil (regras livres).
      for (const p of r.roomId ? [] : r.players) {
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
      // XP, medalhas, missões e conquistas (só partidas da fila: sala não dá progressão).
      const progress = r.roomId ? [] : await applyMatchProgression(tx, { matchId: r.matchId, winner: r.winner, players: r.players, events: r.events }, (p) => resultFor(p.team, p.abandoned), r.endedAt);
      // Clãs com 2+ membros no mesmo time: histórico e pontos de clã (também só fila).
      if (!r.roomId) await applyClanResults(tx, r.matchId, r.players, (team) => resultFor(team, false) as "WIN" | "LOSS" | "DRAW");
      return { ranked, progress };
    }, { timeout: 20_000 });
    // Cada jogador recebe só o próprio resultado ranqueado (pontos e patente; o MMR fica oculto).
    for (const u of rankedUpdates) {
      const c = this.clients.get(u.userId);
      if (c) this.send(c, u.wire);
    }
    for (const u of progress) {
      const c = this.clients.get(u.userId);
      if (c) this.send(c, u.wire);
    }
    // Replay fora da transação principal (arquivo grande): se falhar, a partida continua gravada, só sem replay.
    if (r.replay) await saveReplay(db, r.replay).catch((e) => this.log.error("replay não gravado", r.matchId, e));
  }

  /** Banimento/suspensão/troca de senha derrubam a conexão de jogo em até `recheckMs`. */
  private async recheckAccounts(only?: string[]) {
    const ids = only ?? [...this.clients.keys()];
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
