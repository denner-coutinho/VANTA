import { z } from "zod";
import { MAP_REGISTRY } from "./game/maps/index.js";
import type { WeaponCategory } from "./game/weapons.js";
import type { QueueMode } from "./net/protocol.js";

// Sem importar valores de protocol.ts (o protocolo importa este arquivo).
const TEAM_SIZE: Record<QueueMode, number> = { "1v1": 1, "2v2": 2, "3v3": 3 };

/**
 * Salas personalizadas: partidas privadas ou públicas montadas por um jogador.
 * Rodam no mesmo servidor de jogo autoritativo das partidas da fila (nada é simulado no cliente).
 */

/** Sem letras/números que se confundem (0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LEN = 6;
export const ROOM_SPECTATOR_MAX = 4;
/** Convite de sala vale 2 min. */
export const ROOM_INVITE_TTL_MS = 120_000;
/**
 * Atraso da transmissão para espectadores. Quem assiste vê tudo (posição e vida de todos),
 * então recebe o jogo com atraso para não conseguir "soprar" informação a quem está jogando.
 */
export const SPECTATOR_DELAY_MS = 3_000;

export const WEAPON_CATEGORIES: WeaponCategory[] = ["ASSAULT_RIFLE", "SMG", "SNIPER", "SHOTGUN", "PISTOL"];
export const WEAPON_CATEGORY_LABEL: Record<WeaponCategory, string> = {
  ASSAULT_RIFLE: "Rifles",
  SMG: "Submetralhadoras",
  SNIPER: "Precisão",
  SHOTGUN: "Escopetas",
  PISTOL: "Pistolas",
};

export const roomSettingsSchema = z.object({
  name: z.string().trim().min(3, "O nome precisa de pelo menos 3 letras.").max(32, "Nome muito longo."),
  mode: z.enum(["1v1", "2v2", "3v3"]),
  map: z.string().refine((m) => !!MAP_REGISTRY[m], "Mapa inválido."),
  roundsToWin: z.number().int().min(1).max(15),
  roundTimeSec: z.number().int().min(30).max(300),
  friendlyFire: z.boolean(),
  headshotsOnly: z.boolean(),
  weapons: z.array(z.enum(["ASSAULT_RIFLE", "SMG", "SNIPER", "SHOTGUN", "PISTOL"])).min(1, "Libere pelo menos uma categoria de arma.").max(5),
  allowSpectators: z.boolean(),
  isPrivate: z.boolean(),
});
export type RoomSettings = z.infer<typeof roomSettingsSchema>;

export const roomPasswordSchema = z.string().min(4, "Senha com pelo menos 4 caracteres.").max(32, "Senha muito longa.");

export function defaultRoomSettings(username: string): RoomSettings {
  return {
    name: `Sala de ${username}`.slice(0, 32),
    mode: "2v2",
    map: Object.keys(MAP_REGISTRY)[0]!,
    roundsToWin: 6,
    roundTimeSec: 100,
    friendlyFire: false,
    headshotsOnly: false,
    weapons: [...WEAPON_CATEGORIES],
    allowSpectators: true,
    isPrivate: false,
  };
}

export const roomMaxPlayers = (mode: QueueMode) => TEAM_SIZE[mode] * 2;

export type RoomTeam = 0 | 1 | null;

export interface RoomMemberView {
  id: string;
  username: string;
  character: string;
  /** 0 = Time A, 1 = Time B, null = espectador. */
  team: RoomTeam;
  online: boolean;
}

export interface RoomView {
  id: string;
  code: string;
  ownerId: string;
  settings: RoomSettings;
  hasPassword: boolean;
  locked: boolean;
  status: "lobby" | "in_match";
  members: RoomMemberView[];
  maxPlayers: number;
  /** Partida em andamento (para quem está jogando reconectar / quem assiste). */
  matchId: string | null;
}

export interface RoomListItem {
  code: string;
  name: string;
  mode: QueueMode;
  map: string;
  players: number;
  maxPlayers: number;
  spectators: number;
  status: "lobby" | "in_match";
  ownerName: string;
  hasPassword: boolean;
  locked: boolean;
}

/** Gera um código de sala (a unicidade é garantida pelo banco). */
export function makeRoomCode(rand: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) s += ROOM_CODE_ALPHABET[Math.floor(rand() * ROOM_CODE_ALPHABET.length)];
  return s;
}

export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_CODE_LEN);
}
