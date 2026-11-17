import { z } from "zod";

/**
 * Identidade pública (Fase 7, parte 3b): cartão do jogador, avatar, clãs, perfil público e rankings.
 * Cartões e avatares são gratuitos: os cartões abrem por nível (recompensa de nível), nunca por dinheiro.
 */

// ───────────── Cartão do jogador ─────────────

export type CardPattern = "lines" | "grid" | "circuit" | "chevrons" | "rings" | "shards";

export interface PlayerCardStyle {
  key: string;
  name: string;
  /** Nível mínimo para usar (recompensa de nível). */
  minLevel: number;
  from: string;
  to: string;
  accent: string;
  pattern: CardPattern;
}

export const PLAYER_CARDS: readonly PlayerCardStyle[] = [
  { key: "default", name: "Padrão", minLevel: 1, from: "#101826", to: "#1A2740", accent: "#287BFF", pattern: "lines" },
  { key: "grid", name: "Grade", minLevel: 3, from: "#0E1A1F", to: "#123A3A", accent: "#2EE6A6", pattern: "grid" },
  { key: "circuit", name: "Circuito", minLevel: 5, from: "#140F24", to: "#2B1A4F", accent: "#9B5CFF", pattern: "circuit" },
  { key: "chevron", name: "Divisa", minLevel: 10, from: "#1F1208", to: "#4A2A0E", accent: "#FFB020", pattern: "chevrons" },
  { key: "pulse", name: "Pulso", minLevel: 15, from: "#1F0A12", to: "#4A1028", accent: "#FF3B6B", pattern: "rings" },
  { key: "shard", name: "Fragmento", minLevel: 25, from: "#0A0F1F", to: "#16304F", accent: "#7FD4FF", pattern: "shards" },
];

export const AVATAR_COLORS: Record<string, string> = {
  default: "#287BFF",
  green: "#2EE6A6",
  purple: "#9B5CFF",
  amber: "#FFB020",
  red: "#FF3B6B",
  ice: "#7FD4FF",
};

export function cardStyle(key: string | null | undefined): PlayerCardStyle {
  return PLAYER_CARDS.find((c) => c.key === key) ?? PLAYER_CARDS[0]!;
}

export const updateCardSchema = z.object({
  playerCardKey: z.string().refine((k) => PLAYER_CARDS.some((c) => c.key === k), "Cartão desconhecido."),
  avatarKey: z.string().refine((k) => k in AVATAR_COLORS, "Cor de avatar desconhecida."),
});

// ───────────── Clãs ─────────────

export const CLAN_MAX_MEMBERS = 30;
export const CLAN_INVITE_TTL_MS = 7 * 24 * 3600_000;
/** Pontos de clã ao começar. */
export const CLAN_START_POINTS = 1500;

export const CLAN_SHAPES = ["shield", "hex", "diamond", "circle", "chevron", "crosshair"] as const;
export type ClanShape = (typeof CLAN_SHAPES)[number];
export const CLAN_COLORS: Record<string, string> = { blue: "#287BFF", green: "#2EE6A6", purple: "#9B5CFF", amber: "#FFB020", red: "#FF3B6B", ice: "#7FD4FF", white: "#E8EEF8" };

export function parseClanLogo(key: string | null | undefined): { shape: ClanShape; color: string } {
  const [shape, color] = (key ?? "").split(":");
  return {
    shape: (CLAN_SHAPES as readonly string[]).includes(shape ?? "") ? (shape as ClanShape) : "shield",
    color: CLAN_COLORS[color ?? ""] ?? CLAN_COLORS.blue!,
  };
}

const logoKey = z.string().refine((k) => {
  const [shape, color] = k.split(":");
  return (CLAN_SHAPES as readonly string[]).includes(shape ?? "") && !!color && color in CLAN_COLORS;
}, "Logo inválido.");

export const clanNameSchema = z.string().trim().min(3, "O nome precisa de 3 a 24 caracteres.").max(24, "O nome precisa de 3 a 24 caracteres.").regex(/^[\p{L}\p{N} ._-]+$/u, "Use letras, números, espaço, ponto, hífen ou sublinhado.");
export const clanTagSchema = z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9]{2,5}$/, "A tag tem de 2 a 5 letras ou números."));

export const createClanSchema = z.object({
  name: clanNameSchema,
  tag: clanTagSchema,
  description: z.string().trim().max(500).optional(),
  logoKey: logoKey.default("shield:blue"),
  isOpen: z.boolean().default(true),
});
export const updateClanSchema = z.object({
  description: z.string().trim().max(500).nullable().optional(),
  logoKey: logoKey.optional(),
  isOpen: z.boolean().optional(),
});

export type ClanRoleCode = "LEADER" | "OFFICER" | "MEMBER";
export const CLAN_ROLE_LABEL: Record<ClanRoleCode, string> = { LEADER: "Líder", OFFICER: "Oficial", MEMBER: "Membro" };

/** Pontos de clã por partida da fila com 2+ membros no mesmo time. */
export function clanPointsDelta(result: "WIN" | "LOSS" | "DRAW" | "ABANDON"): number {
  return result === "WIN" ? 20 : result === "LOSS" || result === "ABANDON" ? -15 : 0;
}

/** Quem pode fazer o quê no clã. */
export function canManage(actor: ClanRoleCode, target: ClanRoleCode): boolean {
  if (actor === "LEADER") return target !== "LEADER";
  if (actor === "OFFICER") return target === "MEMBER";
  return false;
}

// ───────────── Tipos de API ─────────────

export interface ClanTagView {
  id: string;
  name: string;
  tag: string;
  logoKey: string;
}

export interface PlayerCardView {
  userId: string;
  username: string;
  displayName: string;
  level: number;
  title: string | null;
  avatarKey: string;
  playerCardKey: string;
  clan: ClanTagView | null;
  /** Melhor patente da temporada ativa (ordem em RANKS), se jogou ranqueada. */
  rankOrder: number | null;
}

export interface PublicMatchView {
  matchId: string;
  mode: "1v1" | "2v2" | "3v3";
  type: "CASUAL" | "RANKED";
  map: string;
  result: "WIN" | "LOSS" | "DRAW" | "ABANDON" | null;
  kills: number;
  deaths: number;
  assists: number;
  mvp: boolean;
  medals: string[];
  endedAt: string | null;
}

export interface PublicProfileResponse {
  card: PlayerCardView;
  memberSince: string;
  stats: { matchesPlayed: number; wins: number; losses: number; kills: number; deaths: number; assists: number; headshots: number; accuracy: number; mvpCount: number };
  ranked: Array<{ mode: "1v1" | "2v2" | "3v3"; points: number; rankOrder: number; wins: number; losses: number; placementLeft: number }>;
  medals: Array<{ code: string; count: number }>;
  achievements: Array<{ code: string; name: string; unlockedAt: string }>;
  recent: PublicMatchView[];
  relation: "self" | "friend" | "none";
}

export interface ClanMemberView {
  userId: string;
  username: string;
  level: number;
  title: string | null;
  role: ClanRoleCode;
  joinedAt: string;
  online?: boolean;
}

export interface ClanMatchView {
  matchId: string;
  mode: "1v1" | "2v2" | "3v3";
  map: string;
  result: "WIN" | "LOSS" | "DRAW";
  pointsDelta: number;
  members: string[];
  score: [number, number];
  at: string;
}

export interface ClanView {
  id: string;
  name: string;
  tag: string;
  description: string | null;
  logoKey: string;
  isOpen: boolean;
  points: number;
  wins: number;
  losses: number;
  position: number;
  createdAt: string;
  members: ClanMemberView[];
  history: ClanMatchView[];
  /** Papel de quem está vendo (null se não é membro). */
  myRole: ClanRoleCode | null;
}

export interface ClanSummary {
  id: string;
  name: string;
  tag: string;
  logoKey: string;
  isOpen: boolean;
  points: number;
  wins: number;
  losses: number;
  members: number;
}

export interface ClanInviteView {
  id: string;
  clan: ClanSummary;
  invitedBy: string;
  expiresAt: string;
}

export interface MyClanResponse {
  clan: ClanView | null;
  invites: ClanInviteView[];
}

export interface LevelLeaderboardResponse {
  total: number;
  entries: Array<{ position: number; userId: string; username: string; level: number; totalXp: number; title: string | null; clanTag: string | null }>;
  me: { position: number; level: number; totalXp: number } | null;
}

export interface ClanLeaderboardResponse {
  total: number;
  entries: Array<ClanSummary & { position: number }>;
  mine: { position: number; tag: string } | null;
}
