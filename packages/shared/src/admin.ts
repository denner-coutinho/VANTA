import { z } from "zod";
import type { UserRole } from "./api-types.js";

/**
 * Painel administrativo (Fase 7, parte 5): níveis de permissão e regras de punição.
 * O servidor confere tudo; o cliente usa as mesmas funções só para esconder o que não pode fazer.
 */

export const ROLE_RANK: Record<UserRole, number> = { PLAYER: 0, MODERATOR: 1, ADMIN: 2, SUPERADMIN: 3 };
export const ROLE_LABEL: Record<UserRole, string> = { PLAYER: "Jogador", MODERATOR: "Moderador", ADMIN: "Administrador", SUPERADMIN: "Superadmin" };

export type AdminPermission =
  | "panel.view"
  | "reports.view"
  | "reports.handle"
  | "users.view"
  | "users.viewEmail"
  | "matches.view"
  | "punish.mute"
  | "punish.suspend"
  | "punish.rankedBan"
  | "punish.permanent"
  | "punish.revoke"
  | "wallet.adjust"
  | "items.grant"
  | "seasons.manage"
  | "audit.viewAll"
  | "roles.manage";

const MOD: AdminPermission[] = ["panel.view", "reports.view", "reports.handle", "users.view", "matches.view", "punish.mute", "punish.suspend", "punish.revoke"];
const ADMIN: AdminPermission[] = [...MOD, "users.viewEmail", "punish.rankedBan", "punish.permanent", "wallet.adjust", "items.grant", "seasons.manage", "audit.viewAll"];
const SUPER: AdminPermission[] = [...ADMIN, "roles.manage"];

export const ROLE_PERMISSIONS: Record<UserRole, readonly AdminPermission[]> = { PLAYER: [], MODERATOR: MOD, ADMIN, SUPERADMIN: SUPER };

export function hasPermission(role: UserRole, p: AdminPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(p);
}

/** Só se age sobre quem tem cargo menor (moderador não pune moderador; ninguém pune a si mesmo). */
export function outranks(actor: UserRole, target: UserRole): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

// ───────────── Punições ─────────────

export type BanTypeCode = "CHAT_MUTE" | "RANKED_BAN" | "SUSPENSION" | "PERMANENT";
export const BAN_LABEL: Record<BanTypeCode, string> = { CHAT_MUTE: "Silêncio no chat", RANKED_BAN: "Banimento do ranqueado", SUSPENSION: "Suspensão da conta", PERMANENT: "Banimento permanente" };

/** Moderador: silêncio até 7 dias e suspensão até 72 horas. Admin: até 1 ano, mais ranqueado e permanente. */
export const MOD_MAX_HOURS: Partial<Record<BanTypeCode, number>> = { CHAT_MUTE: 7 * 24, SUSPENSION: 72 };
export const ADMIN_MAX_HOURS = 365 * 24;

export const banInputSchema = z
  .object({
    type: z.enum(["CHAT_MUTE", "RANKED_BAN", "SUSPENSION", "PERMANENT"]),
    reason: z.string().trim().min(5, "Explique o motivo (5 a 300 caracteres).").max(300, "Explique o motivo (5 a 300 caracteres)."),
    /** Duração em horas; null só no banimento permanente. */
    hours: z.number().int().min(1).max(ADMIN_MAX_HOURS).nullable(),
  })
  .refine((b) => (b.type === "PERMANENT") === (b.hours === null), { message: "Só o banimento permanente fica sem prazo.", path: ["hours"] });
export type BanInput = z.infer<typeof banInputSchema>;

const PERMISSION_FOR: Record<BanTypeCode, AdminPermission> = { CHAT_MUTE: "punish.mute", RANKED_BAN: "punish.rankedBan", SUSPENSION: "punish.suspend", PERMANENT: "punish.permanent" };

/** Motivo da recusa, ou null se o cargo pode aplicar essa punição com esse prazo. */
export function punishmentError(role: UserRole, type: BanTypeCode, hours: number | null): string | null {
  if (!hasPermission(role, PERMISSION_FOR[type])) return `${ROLE_LABEL[role]} não pode aplicar ${BAN_LABEL[type].toLowerCase()}.`;
  if (role === "MODERATOR") {
    const max = MOD_MAX_HOURS[type];
    if (max !== undefined && (hours === null || hours > max)) return `Moderador pode aplicar no máximo ${max} horas de ${BAN_LABEL[type].toLowerCase()}.`;
  }
  return null;
}

/** Revogar segue a mesma regra de aplicar (moderador não desfaz um banimento permanente). */
export function canRevoke(role: UserRole, type: BanTypeCode): boolean {
  return hasPermission(role, "punish.revoke") && hasPermission(role, PERMISSION_FOR[type]);
}

export const ASSIGNABLE_ROLES: readonly UserRole[] = ["PLAYER", "MODERATOR", "ADMIN"];
export const setRoleSchema = z.object({ role: z.enum(["PLAYER", "MODERATOR", "ADMIN"]), reason: z.string().trim().min(5).max(300) });

export const resolveReportSchema = z.object({
  status: z.enum(["IN_REVIEW", "ACTION_TAKEN", "DISMISSED"]),
  resolution: z.string().trim().max(500).optional(),
  ban: banInputSchema.optional(),
}).refine((r) => !r.ban || r.status === "ACTION_TAKEN", { message: "Punição só junto com \"ação tomada\".", path: ["ban"] })
  .refine((r) => r.status === "IN_REVIEW" || (r.resolution?.length ?? 0) >= 5, { message: "Escreva a resolução (5 caracteres ou mais).", path: ["resolution"] });

export const REPORT_STATUS_LABEL: Record<string, string> = { OPEN: "Aberta", IN_REVIEW: "Em análise", ACTION_TAKEN: "Ação tomada", DISMISSED: "Arquivada" };

/** Rótulos legíveis das ações do registro de auditoria. */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  "ban.create": "Aplicou punição",
  "ban.revoke": "Revogou punição",
  "report.resolve": "Tratou denúncia",
  "role.set": "Mudou cargo",
  "user.view": "Abriu ficha de jogador",
  "wallet.adjust": "Ajustou saldo",
  "item.grant": "Concedeu item",
  "ranked.season.start": "Abriu temporada",
  "ranked.season.close": "Fechou temporada",
  ROLE_GRANTED_CLI: "Cargo dado pelo terminal",
};

// ───────────── Tipos de API ─────────────

export interface AdminMeResponse { role: UserRole; permissions: AdminPermission[] }

export interface AdminOverview {
  users: number;
  newUsers24h: number;
  matches24h: number;
  openReports: number;
  activeBans: number;
  recentAudit: AdminAuditEntry[];
}

export interface AdminUserRow {
  id: string;
  username: string;
  role: UserRole;
  status: "ACTIVE" | "SUSPENDED" | "BANNED" | "DELETED";
  level: number;
  createdAt: string;
  lastSeenAt: string | null;
  openReports: number;
}

export interface AdminBanView {
  id: string;
  type: BanTypeCode;
  reason: string;
  issuedBy: string | null;
  startsAt: string;
  endsAt: string | null;
  revokedAt: string | null;
  active: boolean;
}

export interface AdminReportView {
  id: string;
  reporter: { id: string; username: string };
  reported: { id: string; username: string; role: UserRole; status: AdminUserRow["status"] };
  reason: string;
  description: string | null;
  matchId: string | null;
  status: "OPEN" | "IN_REVIEW" | "ACTION_TAKEN" | "DISMISSED";
  handledBy: string | null;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AdminReportDetail extends AdminReportView {
  /** Mensagens do denunciado na partida (prova gravada pelo servidor). */
  chat: Array<{ round: number; channel: string; text: string; at: string }>;
  /** Denúncias anteriores contra o mesmo jogador. */
  priorReports: number;
  activeBans: AdminBanView[];
}

export interface AdminUserDetail extends AdminUserRow {
  /** Só para quem tem users.viewEmail; para os outros vem mascarado. */
  email: string;
  emailVerified: boolean;
  title: string | null;
  balance: number;
  stats: { matchesPlayed: number; wins: number; losses: number; kills: number; deaths: number };
  bans: AdminBanView[];
  reports: AdminReportView[];
  recentMatches: Array<{ matchId: string; mode: string; type: string; result: string | null; kills: number; deaths: number; endedAt: string | null }>;
}

export interface AdminAuditEntry {
  id: string;
  actor: { id: string; username: string; role: UserRole };
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

export interface AdminAuditPage { entries: AdminAuditEntry[]; nextCursor: string | null }

/** Mostra só o começo e o domínio: "jo***@gmail.com". */
export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 2)}***@${domain}`;
}
