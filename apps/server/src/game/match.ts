import {
  CATEGORY_TUNING,
  COMMAND_SLACK,
  CollisionWorld,
  MAX_QUEUED_COMMANDS,
  MAX_REWIND_TICKS,
  MODES,
  PHASE_MS,
  RECONNECT_GRACE_MS,
  SNAPSHOT_EVERY,
  TICK_MS,
  ANIM_FLAG,
  isReloading,
  applyCommand,
  createCombatant,
  damageAt,
  humanoidHitboxes,
  raycastEntities,
  raycastWorld,
  resetCombatant,
  sanitizeCommand,
  type Combatant,
  type MapDefinition,
  type MatchEventWire,
  type MatchInfo,
  type MatchPhase,
  type PlayerCommand,
  type PlayerMatchStats,
  type QueueMode,
  type ServerMessage,
  type Vec3,
  type WeaponStats,
  type WireOther,
  type WireSelf,
} from "@vanta/shared";

export interface Conn {
  send(msg: ServerMessage): void;
}

export interface MatchSeat {
  userId: string;
  username: string;
  color: string;
  characterId: string | null;
  /** Código do personagem (modelo e animações no cliente). */
  character: string;
  loadout: WeaponStats[];
}

interface HistoryEntry {
  tick: number;
  pos: Vec3;
  crouched: boolean;
  alive: boolean;
}

interface Stats {
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  damage: number;
  shots: number;
  hits: number;
}

export interface MatchPlayer extends MatchSeat {
  team: 0 | 1;
  c: Combatant;
  queue: PlayerCommand[];
  /** Último seq recebido (validação de continuidade). */
  lastReceived: number;
  /** Créditos de comando: +1 por tick, teto COMMAND_SLACK; cada comando gasta 1 (anti speed-hack). */
  credit: number;
  conn: Conn | null;
  ready: boolean;
  disconnectedAt: number | null;
  abandoned: boolean;
  stats: Stats;
  /** Dano recebido por atacante neste round (assistências). */
  damageBy: Map<string, number>;
  history: HistoryEntry[];
  privateEvents: MatchEventWire[];
  violations: number;
  /** Mira do último comando (para os outros verem para onde olha). */
  lastYaw: number;
  lastPitch: number;
}

export interface MatchResult {
  matchId: string;
  mode: QueueMode;
  mapCode: string;
  ranked: boolean;
  winner: 0 | 1 | null;
  score: [number, number];
  reason: "score" | "forfeit";
  startedAt: Date;
  endedAt: Date;
  roundsToWin: number;
  players: Array<PlayerMatchStats & { characterId: string | null }>;
  events: Array<{ tick: number; round: number; type: string; actorId?: string; targetId?: string; data: object }>;
}

export interface MatchOptions {
  id: string;
  mode: QueueMode;
  mapCode: string;
  map: MapDefinition;
  teams: [MatchSeat[], MatchSeat[]];
  seed: number;
  /** Partida ranqueada (o servidor de jogo aplica MMR e pontos ao gravar). */
  ranked?: boolean;
  onEnd: (r: MatchResult) => void;
  /** Relógio injetável (testes). */
  now?: () => number;
}

const HISTORY = 64;
const ASSIST_MIN_DAMAGE = 25;
const KICK_VIOLATIONS = 60;

export type CommandRejection = "not_in_match" | "sequence" | "flood";

/**
 * Partida autoritativa. Um tick = 1/60 s. O servidor é a única fonte de verdade:
 * movimento, munição, cadência, dispersão, acertos, dano e rounds são calculados aqui
 * com o mesmo código de simulação do cliente (`@vanta/shared`).
 */
export class Match {
  readonly id: string;
  readonly mode: QueueMode;
  readonly roundsToWin: number;
  readonly players: MatchPlayer[] = [];
  private world: CollisionWorld;
  tick = 0;
  phase: MatchPhase = "warmup";
  private phaseEndsAt: number;
  round = 0;
  score: [number, number] = [0, 0];
  private events: MatchEventWire[] = [];
  private log: MatchResult["events"] = [];
  private startedAt = new Date();
  private endedAt: Date | null = null;
  private now: () => number;
  private ended = false;

  constructor(private opts: MatchOptions) {
    this.id = opts.id;
    this.mode = opts.mode;
    this.roundsToWin = MODES[opts.mode].roundsToWin;
    this.world = new CollisionWorld(opts.map.solids.map((s) => s.box));
    this.now = opts.now ?? Date.now;
    this.phaseEndsAt = PHASE_MS.warmupMax / TICK_MS;
    let seedN = opts.seed >>> 0;
    opts.teams.forEach((seats, team) => {
      seats.forEach((seat, i) => {
        seedN = (seedN * 1103515245 + 12345) >>> 0;
        const spawn = this.spawnFor(team as 0 | 1, i);
        this.players.push({
          ...seat,
          team: team as 0 | 1,
          c: createCombatant(spawn, seat.loadout, seedN),
          queue: [],
          lastReceived: 0,
          credit: 1,
          conn: null,
          ready: false,
          disconnectedAt: null,
          abandoned: false,
          stats: { kills: 0, deaths: 0, assists: 0, headshots: 0, damage: 0, shots: 0, hits: 0 },
          damageBy: new Map(),
          history: [],
          privateEvents: [],
          violations: 0,
          lastYaw: team === 0 ? opts.map.spawnYaw.A : opts.map.spawnYaw.B,
          lastPitch: 0,
        });
      });
    });
  }

  get isEnded() {
    return this.ended;
  }

  player(userId: string) {
    return this.players.find((p) => p.userId === userId);
  }

  private spawnFor(team: 0 | 1, index: number): Vec3 {
    const list = team === 0 ? this.opts.map.spawns.A : this.opts.map.spawns.B;
    return list[index % list.length]!;
  }

  info(userId: string): MatchInfo {
    const me = this.player(userId)!;
    return {
      matchId: this.id,
      mode: this.mode,
      ranked: !!this.opts.ranked,
      map: this.opts.mapCode,
      roundsToWin: this.roundsToWin,
      you: userId,
      yourTeam: me.team,
      players: this.players.map((p) => ({ id: p.userId, username: p.username, team: p.team, color: p.color, character: p.character, loadout: p.loadout.map((w) => w.code), connected: !!p.conn && !p.abandoned })),
      lastSeq: me.lastReceived,
      tick: this.tick,
    };
  }

  /** Conecta (ou reconecta) um jogador e envia o estado da partida. */
  attach(userId: string, conn: Conn): boolean {
    const p = this.player(userId);
    if (!p || p.abandoned || this.ended) return false;
    const wasDisconnected = p.disconnectedAt !== null || !p.conn;
    p.conn = conn;
    p.disconnectedAt = null;
    // Comandos pendentes de uma conexão antiga são descartados; o cliente continua do último seq aceito.
    p.queue = [];
    p.lastReceived = p.c.seq;
    conn.send({ t: "match", info: this.info(userId) });
    if (wasDisconnected && this.tick > 0) this.events.push({ k: "player", id: userId, connected: true });
    return true;
  }

  detach(userId: string, conn?: Conn) {
    const p = this.player(userId);
    if (!p || (conn && p.conn !== conn)) return;
    p.conn = null;
    p.queue = [];
    p.disconnectedAt = this.now();
    if (!this.ended) this.events.push({ k: "player", id: userId, connected: false });
  }

  setReady(userId: string) {
    const p = this.player(userId);
    if (p) p.ready = true;
  }

  /** Abandono voluntário (sair da partida). */
  forfeit(userId: string) {
    const p = this.player(userId);
    if (!p || p.abandoned || this.ended) return;
    this.abandon(p);
  }

  private abandon(p: MatchPlayer) {
    p.abandoned = true;
    p.conn = null;
    p.queue = [];
    if (p.c.alive && this.phase !== "warmup") {
      p.c.alive = false;
      p.c.health = 0;
    }
    this.events.push({ k: "player", id: p.userId, connected: false, abandoned: true });
    this.log.push({ tick: this.tick, round: this.round, type: "abandon", actorId: p.userId, data: {} });
    for (const team of [0, 1] as const) {
      const members = this.players.filter((x) => x.team === team);
      if (members.every((m) => m.abandoned)) {
        this.endMatch(team === 0 ? 1 : 0, "forfeit");
        return;
      }
    }
  }

  /**
   * Recebe comandos do cliente. Exige seq contínuo (TCP garante ordem; um buraco indica
   * cliente adulterado) e limita a fila (flood).
   */
  submitCommands(userId: string, cmds: PlayerCommand[]): CommandRejection | null {
    const p = this.player(userId);
    if (!p || p.abandoned || !p.conn) return "not_in_match";
    for (const raw of cmds) {
      if (raw.seq !== p.lastReceived + 1) {
        p.violations++;
        return "sequence";
      }
      if (p.queue.length >= MAX_QUEUED_COMMANDS) {
        p.violations++;
        return "flood";
      }
      p.lastReceived = raw.seq;
      p.queue.push(sanitizeCommand(raw));
    }
    return null;
  }

  shouldKick(userId: string) {
    const p = this.player(userId);
    return !!p && p.violations >= KICK_VIOLATIONS;
  }

  private get frozen() {
    return this.phase !== "live";
  }

  /** Avança um tick de simulação. */
  step() {
    if (this.ended) return;
    this.tick++;
    const nowMs = this.now();

    for (const p of this.players) {
      if (p.abandoned) continue;
      // Reconexão expirada → abandono.
      if (!p.conn && p.disconnectedAt !== null && nowMs - p.disconnectedAt > RECONNECT_GRACE_MS) {
        this.abandon(p);
        if (this.ended) return;
        continue;
      }
      // Relógio de comandos: nunca processa mais comandos do que ticks passados (+ folga limitada).
      p.credit = Math.min(COMMAND_SLACK, p.credit + 1);
      const n = Math.min(p.queue.length > 4 ? 2 : 1, Math.floor(p.credit));
      if (!p.conn && p.queue.length === 0 && n > 0) {
        // Desconectado: comando ocioso (o personagem fica parado, mas a física continua).
        const last = p.c.seq;
        p.queue.push({ seq: last + 1, forward: 0, right: 0, jump: false, crouch: false, sprint: false, aim: false, fire: false, reload: false, slot: p.c.slot, yaw: 0, pitch: 0, viewTick: this.tick });
        p.lastReceived = last + 1;
      }
      for (let i = 0; i < n && p.queue.length; i++) {
        const cmd = p.queue.shift()!;
        p.credit--;
        this.runCommand(p, cmd);
        if (this.ended) return;
      }
    }

    for (const p of this.players) {
      p.history.push({ tick: this.tick, pos: { ...p.c.move.pos }, crouched: p.c.move.crouched, alive: p.c.alive });
      if (p.history.length > HISTORY) p.history.shift();
    }

    this.updatePhase();
    if (this.tick % SNAPSHOT_EVERY === 0) this.broadcast();
  }

  private runCommand(p: MatchPlayer, cmd: PlayerCommand) {
    if (p.c.alive) {
      p.lastYaw = cmd.yaw;
      p.lastPitch = cmd.pitch;
    }
    const out = applyCommand(p.c, cmd, { world: this.world, loadout: p.loadout, frozen: this.frozen, zones: this.opts.map.zones });
    if (!out.shot) return;
    p.stats.shots++;
    const stats = out.shot.weapon;
    const maxRange = CATEGORY_TUNING[stats.category].maxRange;
    // Compensação de latência: os alvos são posicionados onde o atirador os via.
    const rewindTick = Math.max(this.tick - MAX_REWIND_TICKS, Math.min(this.tick, cmd.viewTick));
    const targets = this.players
      .filter((o) => o !== p && o.team !== p.team)
      .map((o) => {
        const h = this.historyAt(o, rewindTick);
        return { entity: o, alive: h.alive, hitboxes: humanoidHitboxes(h.pos, h.crouched) };
      })
      .filter((t) => t.alive && t.entity.c.alive);

    const perTarget = new Map<MatchPlayer, { dmg: number; head: boolean }>();
    const ends: Vec3[] = [];
    const o = out.shot.origin;
    for (const dir of out.shot.directions) {
      const wall = raycastWorld(this.world, o, dir, maxRange);
      const hit = raycastEntities(targets, o, dir, wall ? wall.t : maxRange);
      if (hit) {
        const acc = perTarget.get(hit.entity) ?? { dmg: 0, head: false };
        acc.dmg += damageAt(stats, hit.t, hit.zone);
        acc.head ||= hit.zone === "head";
        perTarget.set(hit.entity, acc);
        ends.push(hit.point);
      } else {
        const t = wall ? wall.t : maxRange;
        ends.push({ x: o.x + dir.x * t, y: o.y + dir.y * t, z: o.z + dir.z * t });
      }
    }
    this.events.push({ k: "shot", by: p.userId, from: o, ends: ends.slice(0, 4).map(r3), cat: stats.category, w: stats.code });
    if (perTarget.size) p.stats.hits++;

    for (const [target, { dmg, head }] of perTarget) {
      if (!target.c.alive) continue;
      const applied = Math.min(dmg, target.c.health);
      target.c.health -= dmg;
      p.stats.damage += applied;
      if (head) p.stats.headshots++;
      target.damageBy.set(p.userId, (target.damageBy.get(p.userId) ?? 0) + applied);
      const kill = target.c.health <= 0;
      const hitEv: MatchEventWire = { k: "hit", by: p.userId, target: target.userId, dmg: Math.round(applied), head, kill };
      p.privateEvents.push(hitEv);
      if (target !== p) target.privateEvents.push(hitEv);
      if (kill) this.kill(p, target, stats, head);
    }
  }

  private kill(killer: MatchPlayer, victim: MatchPlayer, weapon: WeaponStats, head: boolean) {
    victim.c.alive = false;
    victim.c.health = 0;
    victim.stats.deaths++;
    killer.stats.kills++;
    for (const [id, dmg] of victim.damageBy) {
      if (id !== killer.userId && dmg >= ASSIST_MIN_DAMAGE) {
        const a = this.player(id);
        if (a && a.team !== victim.team) a.stats.assists++;
      }
    }
    this.events.push({ k: "kill", killer: killer.userId, victim: victim.userId, weapon: weapon.name, head });
    this.log.push({ tick: this.tick, round: this.round, type: "kill", actorId: killer.userId, targetId: victim.userId, data: { weapon: weapon.code, head } });
  }

  private historyAt(p: MatchPlayer, tick: number): HistoryEntry {
    for (let i = p.history.length - 1; i >= 0; i--) {
      const h = p.history[i]!;
      if (h.tick <= tick) return h;
    }
    return { tick: this.tick, pos: p.c.move.pos, crouched: p.c.move.crouched, alive: p.c.alive };
  }

  private aliveCount(team: 0 | 1) {
    return this.players.filter((p) => p.team === team && p.c.alive && !p.abandoned).length;
  }

  private updatePhase() {
    const t = this.tick;
    switch (this.phase) {
      case "warmup": {
        const active = this.players.filter((p) => !p.abandoned);
        if (active.every((p) => p.ready) || t >= this.phaseEndsAt) this.startRound();
        break;
      }
      case "freeze":
        if (t >= this.phaseEndsAt) {
          this.phase = "live";
          this.phaseEndsAt = t + PHASE_MS.round / TICK_MS;
        }
        break;
      case "live": {
        const a = this.aliveCount(0);
        const b = this.aliveCount(1);
        if (a === 0 || b === 0) this.endRound(a === 0 && b === 0 ? null : a === 0 ? 1 : 0, "elimination");
        else if (t >= this.phaseEndsAt) {
          // Tempo esgotado: vence quem tem mais vivos; empate → mais vida total; senão, empate.
          const hp = (team: 0 | 1) => this.players.filter((p) => p.team === team && p.c.alive).reduce((s, p) => s + p.c.health, 0);
          const winner = a !== b ? (a > b ? 0 : 1) : hp(0) !== hp(1) ? (hp(0) > hp(1) ? 0 : 1) : null;
          this.endRound(winner, "time");
        }
        break;
      }
      case "round_end":
        if (t >= this.phaseEndsAt) {
          if (this.score[0] >= this.roundsToWin || this.score[1] >= this.roundsToWin) this.endMatch(this.score[0] > this.score[1] ? 0 : 1, "score");
          else this.startRound();
        }
        break;
      case "ended":
        break;
    }
  }

  private startRound() {
    this.round++;
    const counters: [number, number] = [0, 0];
    for (const p of this.players) {
      const spawn = this.spawnFor(p.team, counters[p.team]++);
      resetCombatant(p.c, spawn, p.loadout);
      if (p.abandoned) {
        p.c.alive = false;
        p.c.health = 0;
      }
      p.damageBy.clear();
      p.history = [];
    }
    this.phase = "freeze";
    this.phaseEndsAt = this.tick + PHASE_MS.freeze / TICK_MS;
    this.events.push({ k: "round_start", round: this.round });
  }

  private endRound(winner: 0 | 1 | null, reason: "elimination" | "time") {
    if (winner !== null) this.score[winner]++;
    this.phase = "round_end";
    this.phaseEndsAt = this.tick + PHASE_MS.roundEnd / TICK_MS;
    this.events.push({ k: "round_end", round: this.round, winner, reason, score: [...this.score] });
    this.log.push({ tick: this.tick, round: this.round, type: "round_end", data: { winner, reason, score: [...this.score] } });
  }

  private endMatch(winner: 0 | 1 | null, reason: "score" | "forfeit") {
    if (this.ended) return;
    this.ended = true;
    this.phase = "ended";
    this.endedAt = new Date();
    const stats = this.finalStats(winner);
    this.events.push({ k: "match_end", winner, score: [...this.score], reason, stats });
    this.broadcast();
    this.opts.onEnd({
      matchId: this.id,
      mode: this.mode,
      mapCode: this.opts.mapCode,
      ranked: !!this.opts.ranked,
      winner,
      score: [...this.score],
      reason,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      roundsToWin: this.roundsToWin,
      players: stats.map((s) => ({ ...s, characterId: this.player(s.id)!.characterId })),
      events: this.log,
    });
  }

  private finalStats(winner: 0 | 1 | null): PlayerMatchStats[] {
    const score = (p: MatchPlayer) => p.stats.kills * 100 + p.stats.assists * 40 + p.stats.damage * 0.5 + p.stats.headshots * 20;
    const eligible = this.players.filter((p) => !p.abandoned && (winner === null || p.team === winner));
    // Sem nenhuma contribuição (ex.: W.O. antes do primeiro tiro) não há MVP — e portanto não há bônus ranqueado de MVP.
    const best = eligible.sort((a, b) => score(b) - score(a))[0];
    const mvp = best && score(best) > 0 ? best : undefined;
    return this.players.map((p) => ({
      id: p.userId,
      username: p.username,
      team: p.team,
      ...p.stats,
      damage: Math.round(p.stats.damage),
      abandoned: p.abandoned,
      mvp: p === mvp,
    }));
  }

  private selfWire(p: MatchPlayer): WireSelf {
    const m = p.c.move;
    return {
      seq: p.c.seq,
      pos: { ...m.pos },
      vel: { ...m.vel },
      onGround: m.onGround,
      crouched: m.crouched,
      crouchBlend: m.crouchBlend,
      sprinting: m.sprinting,
      jumpCooldown: m.jumpCooldown,
      slot: p.c.slot,
      health: Math.max(0, Math.round(p.c.health)),
      alive: p.c.alive,
      // A semente da dispersão (shotSeed) NÃO é enviada: o cliente não consegue prever a dispersão real.
      weapons: p.c.weapons.map((w) => ({ ammo: w.ammo, reserve: w.reserve, nextFireAt: w.nextFireAt, reloadEndsAt: w.reloadEndsAt, switchEndsAt: w.switchEndsAt, heat: w.heat, lastShotAt: w.lastShotAt, triggerReleased: w.triggerReleased })),
    };
  }

  private broadcast() {
    const phaseEndsIn = Math.max(0, Math.round((this.phaseEndsAt - this.tick) * TICK_MS));
    const kd = this.players.map((o): [string, number, number, number] => [o.userId, o.stats.kills, o.stats.deaths, o.stats.assists]);
    for (const p of this.players) {
      if (!p.conn) {
        p.privateEvents = [];
        continue;
      }
      const others: WireOther[] = this.players
        .filter((o) => o !== p)
        .map((o) => {
          const m = o.c.move;
          return [o.userId, r3n(m.pos.x), r3n(m.pos.y), r3n(m.pos.z), r3n(o.lastYaw), r3n(o.lastPitch), r3n(m.crouchBlend), o.c.alive ? 1 : 0, o.c.slot, o.team === p.team ? Math.max(0, Math.round(o.c.health)) : -1, animFlags(o.c)];
        });
      p.conn.send({ t: "snap", tick: this.tick, phase: this.phase, phaseEndsIn, round: this.round, score: [...this.score], you: this.selfWire(p), others, kd, ev: [...this.events, ...p.privateEvents] });
      p.privateEvents = [];
    }
    this.events = [];
  }
}

/** Estado visível de animação (pulo, corrida, recarga): não revela nada que o outro jogador não veria. */
function animFlags(c: Combatant): number {
  const ws = c.weapons[c.slot];
  return (c.move.onGround ? ANIM_FLAG.onGround : 0) | (c.move.sprinting ? ANIM_FLAG.sprinting : 0) | (ws && isReloading(ws, c.seq * TICK_MS) ? ANIM_FLAG.reloading : 0);
}

const r3n = (n: number) => Math.round(n * 1000) / 1000;
const r3 = (v: Vec3): Vec3 => ({ x: r3n(v.x), y: r3n(v.y), z: r3n(v.z) });
