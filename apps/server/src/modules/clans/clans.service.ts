import type { Prisma, PrismaClient } from "@vanta/db";
import {
  CLAN_INVITE_TTL_MS,
  CLAN_MAX_MEMBERS,
  canManage,
  clanPointsDelta,
  levelFromTotalXp,
  type ClanInviteView,
  type ClanMatchView,
  type ClanRoleCode,
  type ClanSummary,
  type ClanView,
  type MyClanResponse,
} from "@vanta/shared";
import type { z } from "zod";
import type { createClanSchema, updateClanSchema } from "@vanta/shared";
import { Errors } from "../../lib/errors.js";

type Tx = Prisma.TransactionClient | PrismaClient;
type DbMode = "DUEL_1V1" | "TEAM_2V2" | "TEAM_3V3";
const MODE_OF: Record<DbMode, "1v1" | "2v2" | "3v3"> = { DUEL_1V1: "1v1", TEAM_2V2: "2v2", TEAM_3V3: "3v3" };

const SUMMARY_SELECT = { id: true, name: true, tag: true, logoKey: true, isOpen: true, rating: true, wins: true, losses: true, _count: { select: { members: true } } } satisfies Prisma.ClanSelect;
type SummaryRow = Prisma.ClanGetPayload<{ select: typeof SUMMARY_SELECT }>;

export function toSummary(c: SummaryRow): ClanSummary {
  return { id: c.id, name: c.name, tag: c.tag, logoKey: c.logoKey, isOpen: c.isOpen, points: Math.round(c.rating), wins: c.wins, losses: c.losses, members: c._count.members };
}

/** Trava a linha do clã até o fim da transação (entrada simultânea não estoura o limite de membros). */
async function lockClan(tx: Prisma.TransactionClient, clanId: string) {
  await tx.$queryRaw`SELECT id FROM "Clan" WHERE id = ${clanId} FOR UPDATE`;
}

async function ensureRoom(tx: Prisma.TransactionClient, clanId: string) {
  await lockClan(tx, clanId);
  const n = await tx.clanMember.count({ where: { clanId } });
  if (n >= CLAN_MAX_MEMBERS) throw Errors.conflict("CLAN_FULL", `O clã já tem ${CLAN_MAX_MEMBERS} membros.`);
}

export class ClanService {
  constructor(private readonly db: PrismaClient) {}

  private async membership(userId: string) {
    return this.db.clanMember.findUnique({ where: { userId }, select: { clanId: true, role: true } });
  }

  private async requireRole(userId: string, roles: ClanRoleCode[]) {
    const m = await this.membership(userId);
    if (!m) throw Errors.badRequest("NOT_IN_CLAN", "Você não está em um clã.");
    if (!roles.includes(m.role)) throw Errors.forbidden("Seu cargo no clã não permite isso.");
    return m;
  }

  async view(clanId: string, viewerId: string): Promise<ClanView> {
    const clan = await this.db.clan.findUnique({
      where: { id: clanId },
      include: {
        members: { include: { user: { select: { id: true, username: true, profile: { select: { totalXp: true, title: true } } } } }, orderBy: [{ joinedAt: "asc" }] },
        matches: { orderBy: { createdAt: "desc" }, take: 20, include: { match: { select: { mode: true, scoreTeamA: true, scoreTeamB: true, endedAt: true, map: { select: { code: true } } } } } },
      },
    });
    if (!clan) throw Errors.notFound("Clã não encontrado.");
    const ahead = await this.db.clan.count({ where: { rating: { gt: clan.rating } } });
    const names = new Map(clan.members.map((m) => [m.userId, m.user.username]));
    const missing = [...new Set(clan.matches.flatMap((m) => m.memberIds))].filter((id) => !names.has(id));
    if (missing.length) for (const u of await this.db.user.findMany({ where: { id: { in: missing } }, select: { id: true, username: true } })) names.set(u.id, u.username);
    const order: Record<ClanRoleCode, number> = { LEADER: 0, OFFICER: 1, MEMBER: 2 };
    const history: ClanMatchView[] = clan.matches.map((m) => ({
      matchId: m.matchId,
      mode: MODE_OF[m.match.mode as DbMode] ?? "1v1",
      map: m.match.map.code,
      result: m.result === "WIN" ? "WIN" : m.result === "DRAW" ? "DRAW" : "LOSS",
      pointsDelta: m.pointsDelta,
      members: m.memberIds.map((id) => names.get(id) ?? "?"),
      score: [m.match.scoreTeamA, m.match.scoreTeamB],
      at: (m.match.endedAt ?? m.createdAt).toISOString(),
    }));
    return {
      id: clan.id,
      name: clan.name,
      tag: clan.tag,
      description: clan.description,
      logoKey: clan.logoKey,
      isOpen: clan.isOpen,
      points: Math.round(clan.rating),
      wins: clan.wins,
      losses: clan.losses,
      position: ahead + 1,
      createdAt: clan.createdAt.toISOString(),
      members: clan.members
        .map((m) => ({ userId: m.userId, username: m.user.username, level: levelFromTotalXp(m.user.profile?.totalXp ?? 0).level, title: m.user.profile?.title ?? null, role: m.role, joinedAt: m.joinedAt.toISOString() }))
        .sort((a, b) => order[a.role] - order[b.role] || a.joinedAt.localeCompare(b.joinedAt)),
      history,
      myRole: clan.members.find((m) => m.userId === viewerId)?.role ?? null,
    };
  }

  async byTag(tag: string, viewerId: string) {
    const c = await this.db.clan.findUnique({ where: { tag: tag.toUpperCase() }, select: { id: true } });
    if (!c) throw Errors.notFound("Clã não encontrado.");
    return this.view(c.id, viewerId);
  }

  async mine(userId: string): Promise<MyClanResponse> {
    const [m, invites] = await Promise.all([
      this.membership(userId),
      this.db.clanInvite.findMany({ where: { userId, expiresAt: { gt: new Date() } }, include: { clan: { select: SUMMARY_SELECT }, invitedBy: { select: { username: true } } }, orderBy: { createdAt: "desc" } }),
    ]);
    const inv: ClanInviteView[] = invites.map((i) => ({ id: i.id, clan: toSummary(i.clan), invitedBy: i.invitedBy.username, expiresAt: i.expiresAt.toISOString() }));
    return { clan: m ? await this.view(m.clanId, userId) : null, invites: m ? [] : inv };
  }

  async search(q: string | undefined): Promise<ClanSummary[]> {
    const where: Prisma.ClanWhereInput = q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { tag: { contains: q.toUpperCase() } }] } : {};
    const rows = await this.db.clan.findMany({ where, select: SUMMARY_SELECT, orderBy: [{ rating: "desc" }, { createdAt: "asc" }], take: 20 });
    return rows.map(toSummary);
  }

  async create(userId: string, input: z.infer<typeof createClanSchema>) {
    if (await this.membership(userId)) throw Errors.conflict("ALREADY_IN_CLAN", "Saia do seu clã antes de criar outro.");
    const clash = await this.db.clan.findFirst({ where: { OR: [{ name: { equals: input.name, mode: "insensitive" } }, { tag: input.tag }] }, select: { name: true, tag: true } });
    if (clash) throw Errors.conflict("CLAN_TAKEN", clash.tag === input.tag ? "Essa tag já é de outro clã." : "Esse nome já é de outro clã.");
    try {
      const clan = await this.db.$transaction(async (tx) => {
        const c = await tx.clan.create({ data: { name: input.name, tag: input.tag, description: input.description || null, logoKey: input.logoKey, isOpen: input.isOpen, ownerId: userId } });
        await tx.clanMember.create({ data: { clanId: c.id, userId, role: "LEADER" } });
        await tx.clanInvite.deleteMany({ where: { userId } });
        return c;
      });
      return this.view(clan.id, userId);
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw Errors.conflict("CLAN_TAKEN", "Nome, tag ou participação já em uso. Tente de novo.");
      throw e;
    }
  }

  async update(userId: string, input: z.infer<typeof updateClanSchema>) {
    const m = await this.requireRole(userId, ["LEADER", "OFFICER"]);
    if (input.isOpen !== undefined && m.role !== "LEADER") throw Errors.forbidden("Só o líder abre ou fecha o clã.");
    await this.db.clan.update({ where: { id: m.clanId }, data: { ...(input.description !== undefined ? { description: input.description || null } : {}), ...(input.logoKey ? { logoKey: input.logoKey } : {}), ...(input.isOpen !== undefined ? { isOpen: input.isOpen } : {}) } });
    return this.view(m.clanId, userId);
  }

  async invite(userId: string, username: string) {
    const m = await this.requireRole(userId, ["LEADER", "OFFICER"]);
    const target = await this.db.user.findUnique({ where: { usernameLower: username.toLowerCase() }, select: { id: true, status: true, clanMembership: { select: { clanId: true } } } });
    if (!target || target.status !== "ACTIVE") throw Errors.notFound("Jogador não encontrado.");
    if (target.id === userId) throw Errors.badRequest("SELF", "Você já está no clã.");
    if (target.clanMembership) throw Errors.conflict("ALREADY_IN_CLAN", target.clanMembership.clanId === m.clanId ? "Esse jogador já é do seu clã." : "Esse jogador já está em outro clã.");
    const blocked = await this.db.userBlock.findFirst({ where: { OR: [{ blockerId: userId, blockedId: target.id }, { blockerId: target.id, blockedId: userId }] }, select: { id: true } });
    if (blocked) throw Errors.forbidden("Não é possível convidar esse jogador.");
    const n = await this.db.clanMember.count({ where: { clanId: m.clanId } });
    if (n >= CLAN_MAX_MEMBERS) throw Errors.conflict("CLAN_FULL", `O clã já tem ${CLAN_MAX_MEMBERS} membros.`);
    const expiresAt = new Date(Date.now() + CLAN_INVITE_TTL_MS);
    await this.db.clanInvite.upsert({ where: { clanId_userId: { clanId: m.clanId, userId: target.id } }, create: { clanId: m.clanId, userId: target.id, invitedById: userId, expiresAt }, update: { invitedById: userId, expiresAt } });
    return { ok: true, expiresAt: expiresAt.toISOString() };
  }

  private async addMember(userId: string, clanId: string) {
    try {
      await this.db.$transaction(async (tx) => {
        await ensureRoom(tx, clanId);
        await tx.clanMember.create({ data: { clanId, userId, role: "MEMBER" } });
        await tx.clanInvite.deleteMany({ where: { userId } });
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw Errors.conflict("ALREADY_IN_CLAN", "Você já está em um clã.");
      throw e;
    }
    return this.view(clanId, userId);
  }

  async acceptInvite(userId: string, inviteId: string) {
    const inv = await this.db.clanInvite.findUnique({ where: { id: inviteId } });
    if (!inv || inv.userId !== userId) throw Errors.notFound("Convite não encontrado.");
    if (inv.expiresAt <= new Date()) {
      await this.db.clanInvite.delete({ where: { id: inv.id } });
      throw Errors.badRequest("INVITE_EXPIRED", "Esse convite expirou.");
    }
    if (await this.membership(userId)) throw Errors.conflict("ALREADY_IN_CLAN", "Saia do seu clã antes de entrar em outro.");
    return this.addMember(userId, inv.clanId);
  }

  async declineInvite(userId: string, inviteId: string) {
    const r = await this.db.clanInvite.deleteMany({ where: { id: inviteId, userId } });
    if (!r.count) throw Errors.notFound("Convite não encontrado.");
    return { ok: true };
  }

  async join(userId: string, clanId: string) {
    const clan = await this.db.clan.findUnique({ where: { id: clanId }, select: { isOpen: true } });
    if (!clan) throw Errors.notFound("Clã não encontrado.");
    if (await this.membership(userId)) throw Errors.conflict("ALREADY_IN_CLAN", "Saia do seu clã antes de entrar em outro.");
    if (!clan.isOpen) {
      const inv = await this.db.clanInvite.findFirst({ where: { clanId, userId, expiresAt: { gt: new Date() } } });
      if (!inv) throw Errors.forbidden("Esse clã é fechado: só entra quem for convidado.");
    }
    return this.addMember(userId, clanId);
  }

  /** Sair. Se o líder sai, a liderança passa para o oficial mais antigo (ou o membro mais antigo); se era o último, o clã acaba. */
  async leave(userId: string) {
    const m = await this.membership(userId);
    if (!m) throw Errors.badRequest("NOT_IN_CLAN", "Você não está em um clã.");
    const result = await this.db.$transaction(async (tx) => {
      await lockClan(tx, m.clanId);
      await tx.clanMember.delete({ where: { userId } });
      if (m.role !== "LEADER") return { disbanded: false, newLeader: null as string | null };
      const next = (await tx.clanMember.findFirst({ where: { clanId: m.clanId, role: "OFFICER" }, orderBy: { joinedAt: "asc" } })) ?? (await tx.clanMember.findFirst({ where: { clanId: m.clanId }, orderBy: { joinedAt: "asc" } }));
      if (!next) {
        await tx.clan.delete({ where: { id: m.clanId } });
        return { disbanded: true, newLeader: null };
      }
      await tx.clanMember.update({ where: { id: next.id }, data: { role: "LEADER" } });
      await tx.clan.update({ where: { id: m.clanId }, data: { ownerId: next.userId } });
      return { disbanded: false, newLeader: next.userId };
    });
    return { ok: true, ...result };
  }

  async kick(userId: string, targetId: string) {
    const m = await this.requireRole(userId, ["LEADER", "OFFICER"]);
    const t = await this.db.clanMember.findUnique({ where: { userId: targetId } });
    if (!t || t.clanId !== m.clanId) throw Errors.notFound("Esse jogador não é do seu clã.");
    if (!canManage(m.role, t.role)) throw Errors.forbidden("Seu cargo não permite remover esse jogador.");
    await this.db.clanMember.delete({ where: { id: t.id } });
    return this.view(m.clanId, userId);
  }

  async setRole(userId: string, targetId: string, role: "OFFICER" | "MEMBER") {
    const m = await this.requireRole(userId, ["LEADER"]);
    const t = await this.db.clanMember.findUnique({ where: { userId: targetId } });
    if (!t || t.clanId !== m.clanId) throw Errors.notFound("Esse jogador não é do seu clã.");
    if (t.role === "LEADER") throw Errors.badRequest("IS_LEADER", "Use a transferência de liderança.");
    await this.db.clanMember.update({ where: { id: t.id }, data: { role } });
    return this.view(m.clanId, userId);
  }

  async transfer(userId: string, targetId: string) {
    const m = await this.requireRole(userId, ["LEADER"]);
    const t = await this.db.clanMember.findUnique({ where: { userId: targetId } });
    if (!t || t.clanId !== m.clanId || t.userId === userId) throw Errors.notFound("Esse jogador não é do seu clã.");
    await this.db.$transaction([
      this.db.clanMember.update({ where: { id: t.id }, data: { role: "LEADER" } }),
      this.db.clanMember.update({ where: { userId }, data: { role: "OFFICER" } }),
      this.db.clan.update({ where: { id: m.clanId }, data: { ownerId: targetId } }),
    ]);
    return this.view(m.clanId, userId);
  }

  async disband(userId: string) {
    const m = await this.requireRole(userId, ["LEADER"]);
    await this.db.clan.delete({ where: { id: m.clanId } });
    return { ok: true };
  }
}

/**
 * Chamado pelo servidor de jogo dentro da transação que grava a partida (só fila, nunca sala):
 * um clã com 2+ membros no mesmo time registra a partida no histórico e ganha ou perde pontos.
 */
export async function applyClanResults(tx: Tx, matchId: string, players: Array<{ id: string; team: 0 | 1 }>, teamResult: (team: 0 | 1) => "WIN" | "LOSS" | "DRAW") {
  if (players.length < 2) return [];
  const members = await tx.clanMember.findMany({ where: { userId: { in: players.map((p) => p.id) } }, select: { userId: true, clanId: true } });
  const teamOf = new Map(players.map((p) => [p.id, p.team]));
  const groups = new Map<string, { clanId: string; team: 0 | 1; ids: string[] }>();
  for (const m of members) {
    const team = teamOf.get(m.userId)!;
    const k = `${m.clanId}:${team}`;
    const g = groups.get(k) ?? { clanId: m.clanId, team, ids: [] };
    g.ids.push(m.userId);
    groups.set(k, g);
  }
  const out: Array<{ clanId: string; result: string; delta: number }> = [];
  for (const g of groups.values()) {
    if (g.ids.length < 2) continue;
    const result = teamResult(g.team);
    const exists = await tx.clanMatch.findUnique({ where: { clanId_matchId: { clanId: g.clanId, matchId } } });
    if (exists) continue;
    const clan = await tx.clan.findUniqueOrThrow({ where: { id: g.clanId }, select: { rating: true } });
    const delta = Math.max(-clan.rating, clanPointsDelta(result));
    await tx.clanMatch.create({ data: { clanId: g.clanId, matchId, result, pointsDelta: delta, memberIds: g.ids } });
    await tx.clan.update({ where: { id: g.clanId }, data: { rating: { increment: delta }, ...(result === "WIN" ? { wins: { increment: 1 } } : result === "LOSS" ? { losses: { increment: 1 } } : {}) } });
    out.push({ clanId: g.clanId, result, delta });
  }
  return out;
}
