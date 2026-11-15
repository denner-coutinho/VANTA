import type { CharacterSkinMaterial, WeaponSkinMaterial } from "../cosmetics.js";
import { CHAT_MAX_LEN, type ChatChannel, type PartyView, type PresenceState, type SocialEvent } from "../social.js";
import { z } from "zod";
import { roomPasswordSchema, roomSettingsSchema, type RoomListItem, type RoomView } from "../rooms.js";
import type { PlayerCommand } from "../game/sim.js";
import type { Vec3 } from "../game/math.js";

/**
 * Protocolo do servidor de jogo (WebSocket, JSON).
 * Toda mensagem do cliente é validada com zod no servidor; o cliente só envia intenções.
 */

export const GAME_PROTOCOL_VERSION = 4;
export const SERVER_TICK_RATE = 60;
/** Um snapshot a cada N ticks (60/2 = 30 Hz). */
export const SNAPSHOT_EVERY = 2;
/** Atraso de interpolação dos outros jogadores no cliente (ticks). 6 ticks = 100 ms = 3 snapshots. */
export const INTERP_DELAY_TICKS = 6;
/** Rebobinamento máximo da compensação de latência (ticks). 15 = 250 ms. */
export const MAX_REWIND_TICKS = 15;
/** Comandos que podem ficar na fila por jogador antes de serem descartados. */
export const MAX_QUEUED_COMMANDS = 20;
/** Folga de comandos acima do relógio do servidor (anti speed-hack). */
export const COMMAND_SLACK = 10;
/** Tempo para reconectar antes de ser considerado abandono (ms). */
export const RECONNECT_GRACE_MS = 60_000;

export type QueueMode = "1v1" | "2v2" | "3v3";
export const MODES: Record<QueueMode, { teamSize: number; roundsToWin: number; db: "DUEL_1V1" | "TEAM_2V2" | "TEAM_3V3"; label: string }> = {
  "1v1": { teamSize: 1, roundsToWin: 5, db: "DUEL_1V1", label: "Duelo 1v1" },
  "2v2": { teamSize: 2, roundsToWin: 6, db: "TEAM_2V2", label: "Equipe 2v2" },
  "3v3": { teamSize: 3, roundsToWin: 7, db: "TEAM_3V3", label: "Equipe 3v3" },
};

export const PHASE_MS = {
  /** Espera todos carregarem o mapa (no máximo). */
  warmupMax: 20_000,
  freeze: 4_000,
  round: 100_000,
  roundEnd: 4_000,
};

export type MatchPhase = "warmup" | "freeze" | "live" | "round_end" | "ended";

// ───────────── Botões do comando (bitmask) ─────────────
export const BTN = { fwd: 1, back: 2, left: 4, right: 8, jump: 16, crouch: 32, sprint: 64, aim: 128, fire: 256, reload: 512 } as const;

/** Comando compacto: [seq, botões, yaw, pitch, viewTick, slot]. */
export type WireCommand = [number, number, number, number, number, number];

export function encodeCommand(c: PlayerCommand): WireCommand {
  let b = 0;
  if (c.forward > 0) b |= BTN.fwd;
  if (c.forward < 0) b |= BTN.back;
  if (c.right < 0) b |= BTN.left;
  if (c.right > 0) b |= BTN.right;
  if (c.jump) b |= BTN.jump;
  if (c.crouch) b |= BTN.crouch;
  if (c.sprint) b |= BTN.sprint;
  if (c.aim) b |= BTN.aim;
  if (c.fire) b |= BTN.fire;
  if (c.reload) b |= BTN.reload;
  return [c.seq, b, round5(c.yaw), round5(c.pitch), c.viewTick, c.slot];
}

export function decodeCommand(w: WireCommand): PlayerCommand {
  const [seq, b, yaw, pitch, viewTick, slot] = w;
  return {
    seq,
    forward: (b & BTN.fwd ? 1 : 0) - (b & BTN.back ? 1 : 0),
    right: (b & BTN.right ? 1 : 0) - (b & BTN.left ? 1 : 0),
    jump: !!(b & BTN.jump),
    crouch: !!(b & BTN.crouch),
    sprint: !!(b & BTN.sprint),
    aim: !!(b & BTN.aim),
    fire: !!(b & BTN.fire),
    reload: !!(b & BTN.reload),
    slot,
    yaw,
    pitch,
    viewTick,
  };
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

// ───────────── Cliente → servidor ─────────────
const finite = z.number().refine(Number.isFinite, "número inválido");
const wireCommand = z.tuple([
  z.number().int().min(1).max(2 ** 31),
  z.number().int().min(0).max(1023),
  finite.min(-1e4).max(1e4),
  finite.min(-2).max(2),
  z.number().int().min(0).max(2 ** 31),
  z.number().int().min(0).max(2),
]);

export const clientMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), token: z.string().min(10).max(4096), v: z.number().int() }),
  z.object({ t: z.literal("queue"), mode: z.enum(["1v1", "2v2", "3v3"]), loadout: z.array(z.string().min(1).max(40)).min(1).max(3), ranked: z.boolean().optional() }),
  z.object({ t: z.literal("cancel_queue") }),
  z.object({ t: z.literal("ready") }),
  z.object({ t: z.literal("cmd"), c: z.array(wireCommand).min(1).max(30) }),
  z.object({ t: z.literal("ping"), n: z.number().int().min(0).max(2 ** 31) }),
  z.object({ t: z.literal("leave_match") }),
  // Social (Fase 7)
  z.object({ t: z.literal("loadout"), loadout: z.array(z.string().min(1).max(40)).min(1).max(3) }),
  z.object({ t: z.literal("party_invite"), userId: z.string().min(1).max(40) }),
  z.object({ t: z.literal("party_respond"), partyId: z.string().min(1).max(40), accept: z.boolean() }),
  z.object({ t: z.literal("party_leave") }),
  z.object({ t: z.literal("party_kick"), userId: z.string().min(1).max(40) }),
  z.object({ t: z.literal("chat"), channel: z.enum(["all", "team", "party", "room"]), text: z.string().min(1).max(CHAT_MAX_LEN * 2) }),
  // Salas personalizadas e espectador (Fase 7)
  z.object({ t: z.literal("room_create"), settings: roomSettingsSchema, password: roomPasswordSchema.optional() }),
  z.object({ t: z.literal("room_join"), code: z.string().min(1).max(12), password: z.string().max(64).optional(), spectate: z.boolean().optional() }),
  z.object({ t: z.literal("room_leave") }),
  z.object({ t: z.literal("room_update"), settings: roomSettingsSchema, password: roomPasswordSchema.nullable().optional() }),
  z.object({ t: z.literal("room_team"), userId: z.string().min(1).max(40).optional(), team: z.union([z.literal(0), z.literal(1), z.null()]) }),
  z.object({ t: z.literal("room_kick"), userId: z.string().min(1).max(40) }),
  z.object({ t: z.literal("room_lock"), locked: z.boolean() }),
  z.object({ t: z.literal("room_start") }),
  z.object({ t: z.literal("room_close") }),
  z.object({ t: z.literal("room_list") }),
  z.object({ t: z.literal("room_invite"), userId: z.string().min(1).max(40) }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ───────────── Servidor → cliente ─────────────
export interface MatchPlayerInfo {
  id: string;
  username: string;
  team: 0 | 1;
  color: string;
  character: string;
  loadout: string[];
  connected: boolean;
  /** Cosméticos equipados (só aparência): skin do operador e skins das armas do arsenal. */
  cosmetics?: MatchCosmetics;
}

export interface MatchCosmetics {
  character: CharacterSkinMaterial | null;
  weapons: Record<string, WeaponSkinMaterial>;
}

export interface MatchInfo {
  matchId: string;
  mode: QueueMode;
  /** Partida ranqueada (vale MMR e Pontos de Patente). */
  ranked: boolean;
  map: string;
  roundsToWin: number;
  you: string;
  yourTeam: 0 | 1;
  players: MatchPlayerInfo[];
  /** Último seq de comando aceito do jogador (ao reconectar, o cliente continua dele). */
  lastSeq: number;
  tick: number;
  /** Regras da sala personalizada (null nas partidas da fila). */
  rules?: CustomMatchRules | null;
}

/** Estado completo do próprio jogador, para reconciliação da predição. */
export interface WireSelf {
  seq: number;
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  crouched: boolean;
  crouchBlend: number;
  sprinting: boolean;
  jumpCooldown: number;
  slot: number;
  health: number;
  alive: boolean;
  weapons: Array<{ ammo: number; reserve: number; nextFireAt: number; reloadEndsAt: number | null; switchEndsAt: number; heat: number; lastShotAt: number; triggerReleased: boolean }>;
}

/** Outro jogador: [id, x, y, z, yaw, pitch, crouchBlend, vivo(0/1), slot, vida (só aliados, senão -1)]. */
/** Bits de estado de animação em `WireOther[10]`. */
export const ANIM_FLAG = { onGround: 1, sprinting: 2, reloading: 4 } as const;

/** [id, x, y, z, yaw, pitch, crouchBlend, alive, slot, hp do aliado (-1 = oculto), flags de animação]. */
export type WireOther = [string, number, number, number, number, number, number, 0 | 1, number, number, number];

export type MatchEventWire =
  | { k: "shot"; by: string; from: Vec3; ends: Vec3[]; cat: string; w: string }
  | { k: "hit"; by: string; target: string; dmg: number; head: boolean; kill: boolean }
  | { k: "kill"; killer: string; victim: string; weapon: string; head: boolean }
  | { k: "round_start"; round: number }
  | { k: "round_end"; round: number; winner: 0 | 1 | null; reason: "elimination" | "time" | "forfeit"; score: [number, number] }
  | { k: "player"; id: string; connected: boolean; abandoned?: boolean }
  | { k: "match_end"; winner: 0 | 1 | null; score: [number, number]; reason: "score" | "forfeit"; stats: PlayerMatchStats[] };

export interface PlayerMatchStats {
  id: string;
  username: string;
  team: 0 | 1;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  damage: number;
  shots: number;
  hits: number;
  abandoned: boolean;
  mvp: boolean;
}

export interface Snapshot {
  t: "snap";
  tick: number;
  phase: MatchPhase;
  phaseEndsIn: number;
  round: number;
  score: [number, number];
  you: WireSelf;
  others: WireOther[];
  /** Placar individual: [id, abates, mortes, assistências]. */
  kd: Array<[string, number, number, number]>;
  ev: MatchEventWire[];
  /** Quantas pessoas estão assistindo (com atraso). Só aparece quando há espectadores. */
  spec?: number;
}

/** Opções de partida personalizada (só existem em partidas de sala). */
export interface CustomMatchRules {
  roundTimeSec: number;
  friendlyFire: boolean;
  headshotsOnly: boolean;
}

/** Jogador visto pelo espectador: [id, x, y, z, yaw, pitch, crouchBlend, vivo, slot, vida, flags, time]. */
export type WireSpec = [string, number, number, number, number, number, number, 0 | 1, number, number, number, 0 | 1];

export interface SpectatorInfo {
  matchId: string;
  mode: QueueMode;
  map: string;
  roundsToWin: number;
  players: MatchPlayerInfo[];
  delayMs: number;
  rules: CustomMatchRules | null;
}

/** Quadro atrasado para espectadores (SPECTATOR_DELAY_MS). Só eventos públicos. */
export interface SpecFrame {
  t: "spec";
  tick: number;
  phase: MatchPhase;
  phaseEndsIn: number;
  round: number;
  score: [number, number];
  players: WireSpec[];
  kd: Array<[string, number, number, number]>;
  ev: MatchEventWire[];
}

/** Resultado ranqueado do próprio jogador, enviado depois que o servidor grava a partida. */
export interface RankedResultWire {
  t: "ranked_result";
  matchId: string;
  mode: QueueMode;
  outcome: "WIN" | "LOSS" | "DRAW" | "ABANDONED";
  pointsBefore: number;
  pointsAfter: number;
  delta: number;
  /** Ordem da patente (1..15) ou null durante a classificação. */
  rankBefore: number | null;
  rankAfter: number | null;
  placementLeft: number;
  /** Terminou a classificação nesta partida. */
  placed: boolean;
  promoted: boolean;
  demoted: boolean;
  winStreak: number;
}

export type ServerMessage =
  | { t: "welcome"; userId: string; username: string; inMatch: boolean }
  | { t: "queue"; state: "idle" | "searching"; mode?: QueueMode; ranked?: boolean; inQueue?: number; needed?: number; since?: number }
  | RankedResultWire
  | { t: "match"; info: MatchInfo }
  | Snapshot
  | { t: "pong"; n: number; tick: number }
  | { t: "left_match" }
  | { t: "error"; code: string; message: string; fatal?: boolean }
  /** Presença dos amigos: lista completa logo após o welcome, depois só o que mudou. */
  | { t: "presence"; full: boolean; list: Array<[string, PresenceState]> }
  | { t: "social"; ev: SocialEvent }
  | { t: "party"; party: PartyView | null }
  | { t: "party_invite"; partyId: string; from: { id: string; username: string }; expiresAt: number }
  | { t: "chat"; channel: ChatChannel; from: { id: string; username: string }; text: string; at: number }
  /** Sala atual (null = saiu, foi removido ou a sala fechou; `reason` explica). */
  | { t: "room"; room: RoomView | null; reason?: "left" | "kicked" | "closed" }
  | { t: "room_list"; rooms: RoomListItem[] }
  | { t: "room_invite"; code: string; name: string; from: { id: string; username: string }; expiresAt: number }
  | { t: "spec_start"; info: SpectatorInfo }
  | SpecFrame
  | { t: "spec_end" };
