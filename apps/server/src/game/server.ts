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
} from "@vanta/shared";
import { Match, type MatchResult, type MatchSeat } from "./match.js";
import { equippedCosmetics } from "../modules/economy/store.service.js";
import { applyRankedMatch, getActiveSeason, getOrCreateRating, rankedCooldownSeconds } from "./ranked.js";
import { PartyManager, type Party } from "./party.js";
import type { SocialBus } from "../modules/social/bus.js";

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
  /** Fila em que está: modo + tipo (casual/ranqueada). */
  queued: { mode: QueueMode; ranked: boolean } | null;
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
}

interface QueueEntry {
  client: Client;
  loadout: WeaponStats[];
  cosmetics: MatchCosmetics;
}

/** Um "bilhete" na fila: um jogador sozinho ou um grupo inteiro (nunca separado). */
interface QueueTicket {
  entries: QueueEntry[];
  since: number;
  /** MMR oculto na temporada (só nas filas ranqueadas, onde o bilhete é sempre de 1). */
  mmr: number;
}

const queueKey = (mode: QueueMode, ranked: boolean) => `${mode}:${ranked ? "ranked" : "casual"}`;

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
  private queues = new Map<string, QueueTicket[]>();
  private parties = new PartyManager();
  /** Nome/personagem de quem já se conectou (para mostrar membros de grupo offline). */
  private userInfo = new Map<string, { username: string; character: string }>();
  private partyGrace = new Map<string, NodeJS.Timeout>();
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

  constructor(private opts: GameServerOptions) {
    this.log = opts.log ?? console;
    // Rotação de mapas: em ordem, um mapa por partida (opts.maps restringe, ex.: testes ou eventos).
    this.rotation = (opts.maps ?? MAP_ROTATION).filter((c) => MAP_REGISTRY[c]);
    if (!this.rotation.length) throw new Error("Nenhum mapa válido na rotação");
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
    if (this.opts.autoTick !== false) {
      this.startLoop();
      // As janelas de MMR das filas ranqueadas abrem com o tempo: reavalia a cada segundo.
      this.mmTimer = setInterval(() => this.matchmakingTick(), 1000);
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
    if (this.mmTimer) clearInterval(this.mmTimer);
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    for (const t of this.partyGrace.values()) clearTimeout(t);
    await this.unsubscribe?.();
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
    const client: Client = {
      ws, userId: null, username: "", tokenVersion: 0, color: "#287BFF", characterId: null, character: "RAVEN", match: null, queued: null,
      msgWindowStart: Date.now(), msgCount: 0, helloTimer: null,
      friends: new Set(), blockRel: new Set(), muted: new Set(), chatBanUntil: 0, chatTimes: [], presence: "offline", loadout: null,
    };
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
      case "ready":
        c.match?.setReady(c.userId);
        return;
      case "leave_match":
        if (c.match) {
          c.match.forfeit(c.userId);
          c.match = null;
          this.send(c, { t: "left_match" });
          this.updatePresence(c);
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
      select: { id: true, username: true, status: true, tokenVersion: true, profile: { select: { mainCharacter: { select: { id: true, code: true, primaryColor: true } } } } },
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

    const match = [...this.matches.values()].find((m) => !m.isEnded && m.player(user.id) && !m.player(user.id)!.abandoned);
    this.send(c, { t: "welcome", userId: user.id, username: user.username, inMatch: !!match });
    if (match) {
      c.match = match;
      match.attach(user.id, this.connFor(c));
    }
    // Presença: avisa os amigos e manda para o jogador a situação de cada amigo.
    this.updatePresence(c, true);
    this.send(c, { t: "presence", full: true, list: [...c.friends].map((id) => [id, this.clients.get(id)?.presence ?? "offline"]) });
    // Voltou dentro do prazo: continua no grupo.
    const grace = this.partyGrace.get(user.id);
    if (grace) {
      clearTimeout(grace);
      this.partyGrace.delete(user.id);
    }
    const party = this.parties.of(user.id);
    if (party) this.broadcastParty(party);
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
  }

  // ───────────── Eventos sociais (API → aqui → cliente) ─────────────

  private onSocialEvent(to: string, ev: SocialEvent) {
    const c = this.clients.get(to);
    if (!c?.userId) return;
    this.send(c, { t: "social", ev });
    if (ev.k === "friend_accepted") {
      c.friends.add(ev.friend.id);
      this.send(c, { t: "presence", full: false, list: [[ev.friend.id, this.clients.get(ev.friend.id)?.presence ?? "offline"]] });
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

  private partyInvite(c: Client, targetId: string) {
    const me = c.userId!;
    const target = this.clients.get(targetId);
    if (!c.friends.has(targetId)) return this.partyError(c, "NOT_FRIEND", "Você só pode convidar amigos.");
    if (c.blockRel.has(targetId)) return this.partyError(c, "NOT_FRIEND", "Você só pode convidar amigos.");
    if (!target) return this.partyError(c, "OFFLINE", "Este amigo está offline.");
    const current = this.parties.of(me);
    if (current && current.leaderId !== me) return this.partyError(c, "PARTY_NOT_LEADER", "Só o líder pode convidar.");
    if (current?.members.includes(targetId)) return this.partyError(c, "ALREADY_IN_PARTY", "Este amigo já está no seu grupo.");
    if (c.queued) return this.partyError(c, "IN_QUEUE", "Saia da fila antes de convidar.");
    const p = this.parties.ensure(me);
    if (this.parties.isFull(p)) return this.partyError(c, "PARTY_FULL", "O grupo está cheio.");
    const expiresAt = this.parties.invite(p, targetId);
    this.send(target, { t: "party_invite", partyId: p.id, from: { id: me, username: c.username }, expiresAt });
    this.broadcastParty(p);
  }

  private partyRespond(c: Client, partyId: string, accept: boolean) {
    const me = c.userId!;
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

  private queueOf(mode: QueueMode, ranked: boolean) {
    const key = queueKey(mode, ranked);
    let q = this.queues.get(key);
    if (!q) this.queues.set(key, (q = []));
    return q;
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

    const entries: QueueEntry[] = [];
    for (const m of members) {
      // Os outros membros usam o arsenal que escolheram na tela Jogar (ou o padrão).
      const lo = m === c ? loadout : (this.resolveLoadout(m.loadout ?? DEFAULT_LOADOUT) ?? this.resolveLoadout(DEFAULT_LOADOUT) ?? loadout);
      entries.push({ client: m, loadout: lo, cosmetics: await this.cosmeticsFor(m, lo) });
    }
    let mmr = 0;
    if (ranked) {
      const season = await getActiveSeason(this.opts.prisma);
      if (!season) {
        this.send(c, { t: "error", code: "NO_SEASON", message: "Não há temporada ranqueada em andamento." });
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
    const ticket: QueueTicket = { entries, since: Date.now(), mmr };
    for (const m of members) {
      m.queued = { mode, ranked };
      this.updatePresence(m);
    }
    this.queueOf(mode, ranked).push(ticket);
    this.tryMatch(mode, ranked);
    this.broadcastQueue(mode, ranked);
  }

  /** Tira da fila o bilhete inteiro de quem pediu (se é um grupo, o grupo todo sai). */
  private dequeue(c: Client) {
    if (!c.queued) return;
    const { mode, ranked } = c.queued;
    const key = queueKey(mode, ranked);
    const q = this.queueOf(mode, ranked);
    const ticket = q.find((t) => t.entries.some((e) => e.client === c));
    this.queues.set(key, q.filter((t) => t !== ticket));
    c.queued = null;
    this.updatePresence(c);
    for (const e of ticket?.entries ?? []) {
      if (e.client === c) continue;
      e.client.queued = null;
      this.send(e.client, { t: "queue", state: "idle" });
      this.updatePresence(e.client);
    }
    this.broadcastQueue(mode, ranked);
  }

  private broadcastQueue(mode: QueueMode, ranked: boolean) {
    const q = this.queueOf(mode, ranked);
    const needed = MODES[mode].teamSize * 2;
    const inQueue = q.reduce((n, t) => n + t.entries.length, 0);
    for (const t of q) for (const e of t.entries) this.send(e.client, { t: "queue", state: "searching", mode, ranked, inQueue, needed, since: t.since });
  }

  /** Reavalia as filas ranqueadas (exposto para testes; em produção roda a cada segundo). */
  matchmakingTick(now = Date.now()) {
    for (const mode of Object.keys(MODES) as QueueMode[]) this.tryMatch(mode, true, now);
  }

  private tryMatch(mode: QueueMode, ranked: boolean, now = Date.now()): void {
    const teamSize = MODES[mode].teamSize;
    const key = queueKey(mode, ranked);
    for (;;) {
      const q = this.queueOf(mode, ranked);
      let teams: [QueueEntry[], QueueEntry[]];
      let used: Set<QueueTicket>;
      if (ranked) {
        // Ranqueada (sempre individual): MMR próximo (a janela abre com a espera) e equipes balanceadas pela soma de MMR.
        if (q.length < teamSize * 2) return;
        const picked = pickMatchGroup(q.map((t) => ({ id: t.entries[0]!.client.userId!, mmr: t.mmr, waitedMs: now - t.since })), teamSize * 2);
        if (!picked) return;
        const ids = new Set(picked.map((p) => p.id));
        used = new Set(q.filter((t) => ids.has(t.entries[0]!.client.userId!)));
        const group = [...used].map((t) => ({ ...t.entries[0]!, mmr: t.mmr }));
        const [a, b] = balanceTeams(group);
        teams = [a, b];
      } else {
        // Casual: ordem de chegada, sem separar grupos.
        const packed = packParties(q.map((t) => t.entries.length), teamSize);
        if (!packed) return;
        teams = [packed[0].flatMap((i) => q[i]!.entries), packed[1].flatMap((i) => q[i]!.entries)];
        used = new Set([...packed[0], ...packed[1]].map((i) => q[i]!));
      }
      this.queues.set(key, q.filter((t) => !used.has(t)));
      this.startMatch(mode, ranked, teams);
      this.broadcastQueue(mode, ranked);
    }
  }

  private startMatch(mode: QueueMode, ranked: boolean, teams: [QueueEntry[], QueueEntry[]]) {
    const seat = (e: QueueEntry): MatchSeat => ({ userId: e.client.userId!, username: e.client.username, color: e.client.color, characterId: e.client.characterId, character: e.client.character, loadout: e.loadout, cosmetics: e.cosmetics });
    const mapCode = this.rotation[this.rotationIndex++ % this.rotation.length]!;
    const map = MAP_REGISTRY[mapCode]!;
    const match = new Match({
      id: randomUUID(),
      mode,
      mapCode,
      map,
      ranked,
      teams: [teams[0].map(seat), teams[1].map(seat)],
      seed: randomInt(1, 2 ** 31),
      onEnd: (r) => this.onMatchEnd(match, r),
    });
    this.matches.set(match.id, match);
    const all = [...teams[0], ...teams[1]];
    for (const e of all) {
      e.client.queued = null;
      e.client.match = match;
      match.attach(e.client.userId!, this.connFor(e.client));
      this.updatePresence(e.client);
    }
    this.log.info(`[game] partida ${match.id} (${mode}${ranked ? ", ranqueada" : ""}) criada: ${all.map((e) => e.client.username).join(", ")}`);
  }

  private onClose(c: Client) {
    if (c.helloTimer) clearTimeout(c.helloTimer);
    if (!c.userId) return;
    const userId = c.userId;
    this.dequeue(c);
    if (c.match) c.match.detach(userId);
    if (this.clients.get(userId) !== c) return;
    this.clients.delete(userId);
    this.updatePresence(c, true, "offline");
    void this.opts.prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } }).catch(() => {});
    // No grupo, quem cai tem um prazo para voltar (recarregar a página não desfaz o grupo).
    const party = this.parties.of(userId);
    if (party) {
      this.broadcastParty(party);
      const t = setTimeout(() => {
        this.partyGrace.delete(userId);
        if (!this.clients.has(userId)) this.partyLeave(userId);
      }, this.opts.partyGraceMs ?? 60_000);
      t.unref();
      this.partyGrace.set(userId, t);
    }
  }

  private onMatchEnd(match: Match, r: MatchResult) {
    for (const c of this.clients.values())
      if (c.match === match) {
        c.match = null;
        this.updatePresence(c);
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
    const rankedUpdates = await db.$transaction(async (tx) => {
      const ranked = season ? await applyRankedMatch(tx, season, r) : [];
      const rankedOf = (id: string) => ranked.find((u) => u.userId === id);
      await tx.match.create({
        data: {
          id: r.matchId,
          mode: MODES[r.mode].db,
          type: r.ranked ? "RANKED" : "CASUAL",
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
      return ranked;
    });
    // Cada jogador recebe só o próprio resultado ranqueado (pontos e patente; o MMR fica oculto).
    for (const u of rankedUpdates) {
      const c = this.clients.get(u.userId);
      if (c) this.send(c, u.wire);
    }
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
