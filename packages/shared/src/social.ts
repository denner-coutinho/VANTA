/**
 * Sistema social: amigos, presença, grupo, chat e denúncias.
 * Tipos compartilhados entre API, servidor de jogo e cliente.
 */

/** Onde o jogador está agora (calculado pelo servidor de jogo; nada vem do cliente). */
export type PresenceState = "offline" | "online" | "queue" | "match" | "room";

export const PRESENCE_LABEL: Record<PresenceState, string> = {
  offline: "Offline",
  online: "Online",
  queue: "Na fila",
  match: "Em partida",
  room: "Em sala",
};

/** Tamanho máximo do grupo (cabe num time do 3v3). */
export const PARTY_MAX = 3;
/** Convite de grupo expira em 60 s. */
export const PARTY_INVITE_TTL_MS = 60_000;
/** Limite de amigos por conta. */
export const FRIEND_LIMIT = 200;
export const CHAT_MAX_LEN = 200;
/** Anti-flood do chat: no máximo N mensagens por janela. */
export const CHAT_RATE = { max: 5, windowMs: 5_000 } as const;

export type ChatChannel = "all" | "team" | "party";
export const CHAT_CHANNEL_LABEL: Record<ChatChannel, string> = { all: "Todos", team: "Equipe", party: "Grupo" };

/** Arsenal padrão (quem ainda não escolheu armas entra com este). */
export const DEFAULT_LOADOUT = ["VK7_LAMINA", "P9_FAISCA", "LR1_HORIZONTE"];

export const REPORT_REASONS = ["CHEATING", "TOXIC_CHAT", "OFFENSIVE_NAME", "GRIEFING", "AFK", "BOOSTING", "OTHER"] as const;
export type ReportReasonCode = (typeof REPORT_REASONS)[number];
export const REPORT_REASON_LABEL: Record<ReportReasonCode, string> = {
  CHEATING: "Trapaça (aimbot, wallhack…)",
  TOXIC_CHAT: "Chat ofensivo",
  OFFENSIVE_NAME: "Nome ofensivo",
  GRIEFING: "Atrapalhar o próprio time",
  AFK: "Ausente na partida",
  BOOSTING: "Manipulação de ranking",
  OTHER: "Outro motivo",
};

// ───────────── API ─────────────

export interface SocialUserView {
  id: string;
  username: string;
  level: number;
  character: string | null;
}

export interface FriendView extends SocialUserView {
  since: string;
}

export interface FriendRequestView {
  id: string;
  user: SocialUserView;
  createdAt: string;
}

export interface SocialOverviewResponse {
  friends: FriendView[];
  incoming: FriendRequestView[];
  outgoing: FriendRequestView[];
  blocked: SocialUserView[];
  muted: SocialUserView[];
}

export type SocialRelation = "none" | "friend" | "pending_out" | "pending_in" | "blocked";

export interface UserSearchResult extends SocialUserView {
  relation: SocialRelation;
}

export interface RecentPlayerView extends SocialUserView {
  relation: SocialRelation;
  lastMatchAt: string;
  lastMatchId: string;
  /** Jogou no mesmo time na última partida em comum. */
  teammate: boolean;
}

// ───────────── Eventos em tempo real (API → servidor de jogo → cliente) ─────────────

export type SocialEvent =
  | { k: "friend_request"; requestId: string; from: SocialUserView }
  | { k: "friend_accepted"; friend: SocialUserView }
  | { k: "friend_removed"; userId: string }
  | { k: "request_closed"; requestId: string }
  /** Bloqueio, desbloqueio ou silêncio mudou: o servidor de jogo recarrega as listas. */
  | { k: "relations_changed" };

// ───────────── Grupo ─────────────

export interface PartyMemberView {
  id: string;
  username: string;
  character: string;
  online: boolean;
}

export interface PartyView {
  id: string;
  leaderId: string;
  members: PartyMemberView[];
  /** Convites pendentes (ids de quem foi convidado). */
  invited: string[];
}

/**
 * Monta dois times de `teamSize` com grupos inteiros (um grupo nunca é separado),
 * dando prioridade a quem chegou antes. `sizes[i]` é o tamanho do i-ésimo grupo na fila.
 * Devolve os índices dos grupos de cada time, ou null se não fecha.
 */
export function packParties(sizes: number[], teamSize: number): [number[], number[]] | null {
  const n = sizes.length;
  const dead = new Set<string>();
  const a: number[] = [];
  const b: number[] = [];
  const go = (i: number, fa: number, fb: number): boolean => {
    if (fa === teamSize && fb === teamSize) return true;
    if (i >= n) return false;
    const key = `${i}:${fa}:${fb}`;
    if (dead.has(key)) return false;
    const s = sizes[i]!;
    if (fa + s <= teamSize) {
      a.push(i);
      if (go(i + 1, fa + s, fb)) return true;
      a.pop();
    }
    // Times vazios são iguais: não vale testar o mesmo grupo no B quando os dois estão no mesmo ponto.
    if (fb + s <= teamSize && !(fa === fb)) {
      b.push(i);
      if (go(i + 1, fa, fb + s)) return true;
      b.pop();
    }
    if (go(i + 1, fa, fb)) return true;
    dead.add(key);
    return false;
  };
  return go(0, 0, 0) ? [a, b] : null;
}

/** Limpa texto de chat: tira caracteres de controle, junta espaços e corta no limite. */
export function sanitizeChat(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_MAX_LEN);
}
