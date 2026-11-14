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
