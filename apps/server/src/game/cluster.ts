import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import type { MatchCosmetics, PresenceState, QueueMode } from "@vanta/shared";

/**
 * Vários processos de jogo (Fase 8, parte 3).
 *
 * Modelo: cada partida, grupo e sala vive na memória de UM processo (o "nó"). Quem precisa
 * interagir é levado ao mesmo nó: o servidor manda `{t:"redirect", node}` e o cliente reconecta
 * em `/game?node=<id>` (o nginx encaminha para aquele nó). O que precisa ser visto por todos os
 * nós fica no Redis: quais nós estão vivos, onde cada jogador está conectado e sua presença,
 * a "casa" de quem tem partida/grupo/sala em andamento, as filas e o líder que forma as partidas.
 *
 * `LocalCluster` é o mesmo contrato para um processo só (desenvolvimento e testes).
 */

export interface TicketEntry {
  userId: string;
  username: string;
  color: string;
  characterId: string | null;
  character: string;
  loadout: string[];
  cosmetics: MatchCosmetics;
}

/** Bilhete da fila: um jogador ou um grupo inteiro, sempre do mesmo nó. */
export interface Ticket {
  id: string;
  node: string;
  since: number;
  mmr: number;
  entries: TicketEntry[];
}

export interface MatchSpec {
  id: string;
  mode: QueueMode;
  ranked: boolean;
  mapCode: string;
  seed: number;
  teams: [TicketEntry[], TicketEntry[]];
}

export interface RoomListEntry {
  node: string;
  json: string;
}

export type ClusterMessage =
  /** Conexão nova em outro nó: o nó antigo derruba a dele. */
  | { k: "kick"; from: string; userId: string }
  | { k: "presence"; from: string; userId: string; state: PresenceState }
  /** O jogador precisa ir para `node` (partida, grupo ou sala estão lá). */
  | { k: "redirect"; from: string; userId: string; node: string }
  | { k: "match_create"; from: string; node: string; spec: MatchSpec }
  | { k: "queue_changed"; from: string; key: string }
  | { k: "party_invite"; from: string; to: string; partyId: string; inviter: { id: string; username: string }; expiresAt: number }
  | { k: "party_respond"; from: string; node: string; partyId: string; user: { id: string; username: string; character: string }; accept: boolean }
  | { k: "party_rejected"; from: string; to: string; code: string; message: string }
  | { k: "room_invite"; from: string; to: string; code: string; name: string; inviter: { id: string; username: string }; expiresAt: number }
  | { k: "room_join"; from: string; node: string; code: string; user: { id: string; username: string; character: string; color: string }; password?: string; spectate: boolean; blocked: string[] }
  | { k: "room_rejected"; from: string; to: string; code: string; message: string };

export type ClusterHandler = (msg: ClusterMessage) => void;

export interface NodeInfo {
  id: string;
  load: number;
  url: string | null;
  at: number;
}

export interface Cluster {
  readonly nodeId: string;
  /** Quantos nós podem existir (1 no LocalCluster): o servidor pula o trabalho de cluster quando é 1. */
  readonly multiNode: boolean;
  start(handler: ClusterHandler, info: () => { load: number; url: string | null }): Promise<void>;
  stop(): Promise<void>;
  send(msg: ClusterMessage): Promise<void>;
  nodes(): Promise<NodeInfo[]>;
  isAlive(node: string): Promise<boolean>;

  /** Onde o jogador está conectado e com que presença. */
  setLocation(userId: string, state: PresenceState): Promise<void>;
  clearLocation(userId: string): Promise<void>;
  locate(userId: string): Promise<{ node: string; state: PresenceState } | null>;
  presence(userIds: string[]): Promise<Map<string, PresenceState>>;

  /** Nó onde está a partida, o grupo ou a sala do jogador. */
  setHome(userId: string): Promise<void>;
  clearHome(userId: string): Promise<void>;
  home(userId: string): Promise<string | null>;

  queueAdd(key: string, t: Ticket): Promise<void>;
  /** false se o bilhete já saiu (por exemplo, virou partida). */
  queueRemove(key: string, ticketId: string): Promise<boolean>;
  queueAll(key: string): Promise<Ticket[]>;
  /** Tira todos os bilhetes de uma vez, ou nenhum (se algum já saiu). */
  queueTake(key: string, ids: string[]): Promise<boolean>;
  /** Só o líder forma partidas (evita dois nós pegarem os mesmos bilhetes). */
  isLeader(): Promise<boolean>;

  /** Salas abertas de todos os nós (a lista pública e o código → nó). */
  roomPut(code: string, entry: RoomListEntry): Promise<void>;
  roomDel(code: string): Promise<void>;
  roomGet(code: string): Promise<RoomListEntry | null>;
  roomAll(): Promise<RoomListEntry[]>;
}

const ALIVE_MS = 7000;
const HEARTBEAT_MS = 2000;

/** Um processo só: tudo em memória, mensagens entregues para o próprio nó. */
export class LocalCluster implements Cluster {
  readonly multiNode = false;
  private ee = new EventEmitter();
  private loc = new Map<string, PresenceState>();
  private homes = new Set<string>();
  private queues = new Map<string, Map<string, Ticket>>();
  private rooms = new Map<string, RoomListEntry>();
  private info: () => { load: number; url: string | null } = () => ({ load: 0, url: null });
  constructor(readonly nodeId = "local") {}
  async start(handler: ClusterHandler, info: () => { load: number; url: string | null }) {
    this.info = info;
    this.ee.on("m", handler);
  }
  async stop() {
    this.ee.removeAllListeners();
  }
  async send(msg: ClusterMessage) {
    setImmediate(() => this.ee.emit("m", msg));
  }
  async nodes() {
    return [{ id: this.nodeId, ...this.info(), at: Date.now() }];
  }
  async isAlive(node: string) {
    return node === this.nodeId;
  }
  async setLocation(userId: string, state: PresenceState) {
    this.loc.set(userId, state);
  }
  async clearLocation(userId: string) {
    this.loc.delete(userId);
  }
  async locate(userId: string) {
    const s = this.loc.get(userId);
    return s ? { node: this.nodeId, state: s } : null;
  }
  async presence(ids: string[]) {
    return new Map(ids.map((id) => [id, this.loc.get(id) ?? "offline"] as const));
  }
  async setHome(userId: string) {
    this.homes.add(userId);
  }
  async clearHome(userId: string) {
    this.homes.delete(userId);
  }
  async home(userId: string) {
    return this.homes.has(userId) ? this.nodeId : null;
  }
  private q(key: string) {
    let q = this.queues.get(key);
    if (!q) this.queues.set(key, (q = new Map()));
    return q;
  }
  async queueAdd(key: string, t: Ticket) {
    this.q(key).set(t.id, t);
  }
  async queueRemove(key: string, id: string) {
    return this.q(key).delete(id);
  }
  async queueAll(key: string) {
    return [...this.q(key).values()];
  }
  async queueTake(key: string, ids: string[]) {
    const q = this.q(key);
    if (!ids.every((id) => q.has(id))) return false;
    for (const id of ids) q.delete(id);
    return true;
  }
  async isLeader() {
    return true;
  }
  async roomPut(code: string, e: RoomListEntry) {
    this.rooms.set(code, e);
  }
  async roomDel(code: string) {
    this.rooms.delete(code);
  }
  async roomGet(code: string) {
    return this.rooms.get(code) ?? null;
  }
  async roomAll() {
    return [...this.rooms.values()];
  }
}

// Apaga a chave só se ainda for deste nó (outro nó pode ter assumido o jogador).
const DEL_IF_PREFIX = `local v = redis.call("GET", KEYS[1]) if v and string.sub(v, 1, string.len(ARGV[1])) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;
const DEL_IF_EQ = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;
const TAKE_ALL = `for i, id in ipairs(ARGV) do if redis.call("HEXISTS", KEYS[1], id) == 0 then return 0 end end for i, id in ipairs(ARGV) do redis.call("HDEL", KEYS[1], id) end return 1`;
const LEAD = `local v = redis.call("GET", KEYS[1]) if not v then redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2]) return 1 end if v == ARGV[1] then redis.call("PEXPIRE", KEYS[1], ARGV[2]) return 1 end return 0`;

/** Vários processos, estado compartilhado no Redis e mensagens por Pub/Sub. */
export class RedisCluster implements Cluster {
  readonly multiNode = true;
  private redis: Redis;
  private sub: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  private aliveCache: { at: number; nodes: Map<string, NodeInfo> } | null = null;
  private info: () => { load: number; url: string | null } = () => ({ load: 0, url: null });
  private leaderUntil = 0;

  constructor(
    url: string,
    readonly nodeId: string,
    private prefix = "vanta:",
  ) {
    if (!/^[a-z0-9-]{1,32}$/.test(nodeId)) throw new Error("GAME_NODE_ID: use letras minúsculas, números e hífen (até 32).");
    this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
    this.url = url;
  }
  private url: string;
  private k = (s: string) => `${this.prefix}cluster:${s}`;

  async start(handler: ClusterHandler, info: () => { load: number; url: string | null }) {
    this.info = info;
    this.sub = new Redis(this.url, { maxRetriesPerRequest: null });
    await this.sub.subscribe(this.k("bus"));
    this.sub.on("message", (_ch, raw) => {
      try {
        handler(JSON.parse(raw) as ClusterMessage);
      } catch {
        /* malformada: ignora */
      }
    });
    await this.heartbeat();
    this.timer = setInterval(() => void this.heartbeat().catch(() => {}), HEARTBEAT_MS);
    this.timer.unref();
  }

  private async heartbeat() {
    const { load, url } = this.info();
    await this.redis.hset(this.k("nodes"), this.nodeId, JSON.stringify({ load, url, at: Date.now() }));
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.redis.hdel(this.k("nodes"), this.nodeId).catch(() => {});
    if ((await this.redis.get(this.k("leader")).catch(() => null)) === this.nodeId) await this.redis.del(this.k("leader")).catch(() => {});
    this.sub?.disconnect();
    this.redis.disconnect();
  }

  async send(msg: ClusterMessage) {
    await this.redis.publish(this.k("bus"), JSON.stringify(msg));
  }

  private async aliveNodes(): Promise<Map<string, NodeInfo>> {
    const now = Date.now();
    if (this.aliveCache && now - this.aliveCache.at < 1000) return this.aliveCache.nodes;
    const raw = await this.redis.hgetall(this.k("nodes"));
    const nodes = new Map<string, NodeInfo>();
    for (const [id, v] of Object.entries(raw)) {
      try {
        const n = JSON.parse(v) as Omit<NodeInfo, "id">;
        if (now - n.at < ALIVE_MS) nodes.set(id, { id, ...n });
      } catch {
        /* ignora */
      }
    }
    this.aliveCache = { at: now, nodes };
    return nodes;
  }

  async nodes() {
    return [...(await this.aliveNodes()).values()];
  }
  async isAlive(node: string) {
    return node === this.nodeId || (await this.aliveNodes()).has(node);
  }

  async setLocation(userId: string, state: PresenceState) {
    await this.redis.set(this.k(`loc:${userId}`), `${this.nodeId}|${state}`);
  }
  async clearLocation(userId: string) {
    await this.redis.eval(DEL_IF_PREFIX, 1, this.k(`loc:${userId}`), `${this.nodeId}|`);
  }
  async locate(userId: string) {
    const v = await this.redis.get(this.k(`loc:${userId}`));
    if (!v) return null;
    const [node, state] = v.split("|") as [string, PresenceState];
    return (await this.isAlive(node)) ? { node, state } : null;
  }
  async presence(ids: string[]) {
    const out = new Map<string, PresenceState>();
    if (!ids.length) return out;
    const vals = await this.redis.mget(ids.map((id) => this.k(`loc:${id}`)));
    const alive = await this.aliveNodes();
    ids.forEach((id, i) => {
      const v = vals[i];
      const [node, state] = (v ?? "").split("|") as [string, PresenceState];
      out.set(id, v && (node === this.nodeId || alive.has(node)) ? state : "offline");
    });
    return out;
  }

  async setHome(userId: string) {
    await this.redis.set(this.k(`home:${userId}`), this.nodeId);
  }
  async clearHome(userId: string) {
    await this.redis.eval(DEL_IF_EQ, 1, this.k(`home:${userId}`), this.nodeId);
  }
  async home(userId: string) {
    const node = await this.redis.get(this.k(`home:${userId}`));
    if (!node) return null;
    if (await this.isAlive(node)) return node;
    // O nó caiu: o que vivia nele (partida, grupo, sala) se perdeu junto.
    await this.redis.eval(DEL_IF_EQ, 1, this.k(`home:${userId}`), node);
    return null;
  }

  async queueAdd(key: string, t: Ticket) {
    await this.redis.hset(this.k(`q:${key}`), t.id, JSON.stringify(t));
  }
  async queueRemove(key: string, id: string) {
    return (await this.redis.hdel(this.k(`q:${key}`), id)) > 0;
  }
  async queueAll(key: string) {
    const raw = await this.redis.hgetall(this.k(`q:${key}`));
    const alive = await this.aliveNodes();
    const out: Ticket[] = [];
    const dead: string[] = [];
    for (const [id, v] of Object.entries(raw)) {
      const t = JSON.parse(v) as Ticket;
      if (t.node === this.nodeId || alive.has(t.node)) out.push(t);
      else dead.push(id);
    }
    // Bilhetes de um nó que caiu: os jogadores perderam a conexão, saem da fila.
    if (dead.length) await this.redis.hdel(this.k(`q:${key}`), ...dead);
    return out.sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
  }
  async queueTake(key: string, ids: string[]) {
    if (!ids.length) return true;
    return (await this.redis.eval(TAKE_ALL, 1, this.k(`q:${key}`), ...ids)) === 1;
  }
  async isLeader() {
    const now = Date.now();
    if (now < this.leaderUntil) return true;
    const ok = (await this.redis.eval(LEAD, 1, this.k("leader"), this.nodeId, "5000")) === 1;
    this.leaderUntil = ok ? now + 2000 : 0;
    return ok;
  }

  async roomPut(code: string, e: RoomListEntry) {
    await this.redis.hset(this.k("rooms"), code, JSON.stringify(e));
  }
  async roomDel(code: string) {
    await this.redis.hdel(this.k("rooms"), code);
  }
  async roomGet(code: string) {
    const v = await this.redis.hget(this.k("rooms"), code);
    if (!v) return null;
    const e = JSON.parse(v) as RoomListEntry;
    if (await this.isAlive(e.node)) return e;
    await this.redis.hdel(this.k("rooms"), code);
    return null;
  }
  async roomAll() {
    const raw = await this.redis.hgetall(this.k("rooms"));
    const alive = await this.aliveNodes();
    return Object.values(raw)
      .map((v) => JSON.parse(v) as RoomListEntry)
      .filter((e) => e.node === this.nodeId || alive.has(e.node));
  }
}
