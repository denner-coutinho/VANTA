import type { CharacterSkinMaterial, WeaponSkinMaterial } from "./cosmetics.js";
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
  /** Cosméticos equipados (só aparência). Chave = código do operador / da arma. */
  cosmetics: {
    characters: Record<string, CharacterSkinMaterial>;
    weapons: Record<string, WeaponSkinMaterial>;
  };
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

// ───────── Economia (Fase 6) ─────────

export type StoreItemType = "WEAPON_SKIN" | "CHARACTER_SKIN" | "EMBLEM";

export interface StoreItemView {
  id: string;
  code: string;
  type: StoreItemType;
  name: string;
  description: string;
  rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY" | "SEASONAL";
  /** null = não vendável (recompensa). */
  priceVc: number | null;
  owned: boolean;
  equipped: boolean;
  /** Arma ou operador ao qual a skin se aplica. */
  target: { kind: "weapon" | "character"; code: string; name: string } | null;
  /** Material visual (cores/padrão) interpretado pelo cliente; null para emblemas. */
  material: Record<string, unknown> | null;
  acquiredAt: string | null;
  source: "PURCHASE" | "REWARD" | "SEASON_REWARD" | "EVENT" | "ADMIN_GRANT" | "DEFAULT" | null;
}

export interface StoreCatalogResponse {
  balance: number;
  items: StoreItemView[];
}

export interface StorePurchaseResponse {
  balance: number;
  item: StoreItemView;
}

export interface WalletTransactionView {
  id: string;
  type: "PURCHASE_CREDIT" | "REWARD_CREDIT" | "STORE_DEBIT" | "REFUND_DEBIT" | "CHARGEBACK_DEBIT" | "ADMIN_ADJUSTMENT";
  amount: number;
  balanceAfter: number;
  description: string;
  createdAt: string;
}

export interface WalletResponse {
  balance: number;
  transactions: WalletTransactionView[];
  nextCursor: string | null;
}

export interface CoinPackageView {
  id: string;
  code: string;
  coins: number;
  bonusCoins: number;
  priceCents: number;
  currency: string;
}

export interface CoinPackagesResponse {
  /** false quando o servidor não tem a Stripe configurada: a compra de VC fica indisponível (sem simulação). */
  paymentsEnabled: boolean;
  packages: CoinPackageView[];
}

export interface CheckoutResponse {
  orderId: string;
  /** Página de pagamento hospedada pela Stripe. O cartão é digitado lá, nunca no jogo. */
  url: string;
}

export interface PaymentOrderView {
  id: string;
  status: "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "DISPUTED";
  coins: number;
  priceCents: number;
  currency: string;
  createdAt: string;
  paidAt: string | null;
}
