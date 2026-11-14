/** Tipos de resposta da API compartilhados entre cliente e servidor. */
export type UserRole = "PLAYER" | "MODERATOR" | "ADMIN" | "SUPERADMIN";

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  role: UserRole;
  createdAt: string;
}

export interface MeResponse {
  user: PublicUser;
  profile: {
    displayName: string;
    level: number;
    xpIntoLevel: number;
    xpForNext: number;
    totalXp: number;
    title: string | null;
    avatarKey: string;
    mainCharacterId: string | null;
  };
  wallet: { balance: number; currency: "VC" };
  ranked: {
    seasonName: string | null;
    points: number;
    rankOrder: number;
    placementMatchesLeft: number;
  } | null;
}

export interface AuthResponse {
  accessToken: string;
  expiresIn: number;
  user: PublicUser;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface ActiveEvent {
  id: string;
  name: string;
  description: string;
  startsAt: string;
  endsAt: string;
}

// ───────── Competitivo ─────────
export interface RankedModeStatus {
  mode: "1v1" | "2v2" | "3v3";
  points: number;
  /** Ordem da patente (1..15). `null` enquanto a classificação não termina. */
  rankOrder: number | null;
  placementLeft: number;
  wins: number;
  losses: number;
  winStreak: number;
  peakPoints: number;
}

export interface RankedOverviewResponse {
  season: { id: string; number: number; name: string; startsAt: string; endsAt: string; placementMatches: number } | null;
  /** Segundos de bloqueio da fila ranqueada por abandono (0 = liberada). */
  cooldownSeconds: number;
  modes: RankedModeStatus[];
  recent: Array<{
    matchId: string;
    mode: "1v1" | "2v2" | "3v3";
    map: string;
    result: "WIN" | "LOSS" | "DRAW" | "ABANDONED";
    pointsDelta: number | null;
    /** [sua equipe, adversários] */
    score: number[];
    kills: number;
    deaths: number;
    assists: number;
    mvp: boolean;
    endedAt: string | null;
  }>;
}

export interface RankedLeaderboardEntry {
  position: number;
  userId: string;
  username: string;
  level: number;
  points: number;
  rankOrder: number;
  wins: number;
  losses: number;
  winStreak: number;
}

export interface RankedLeaderboardResponse {
  season: string | null;
  mode: "1v1" | "2v2" | "3v3";
  total: number;
  entries: RankedLeaderboardEntry[];
  me: { position: number; points: number; rankOrder: number } | null;
}
