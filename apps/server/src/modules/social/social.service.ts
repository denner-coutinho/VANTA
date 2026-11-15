import type { Prisma, PrismaClient } from "@vanta/db";
import {
  FRIEND_LIMIT,
  levelFromTotalXp,
  type FriendRequestView,
  type RecentPlayerView,
  type ReportReasonCode,
  type SocialOverviewResponse,
  type SocialRelation,
  type SocialUserView,
  type UserSearchResult,
} from "@vanta/shared";
import { Errors } from "../../lib/errors.js";
import type { SocialBus } from "./bus.js";

export const USER_VIEW_SELECT = {
  id: true,
  username: true,
  profile: { select: { totalXp: true, mainCharacter: { select: { code: true } } } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_VIEW_SELECT }>;

export function toUserView(u: UserRow): SocialUserView {
  return { id: u.id, username: u.username, level: levelFromTotalXp(u.profile?.totalXp ?? 0).level, character: u.profile?.mainCharacter?.code ?? null };
}

/** Par ordenado da tabela Friend (guardada uma vez por par, com userAId < userBId). */
export const pair = (a: string, b: string) => (a < b ? { userAId: a, userBId: b } : { userAId: b, userBId: a });

const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

/**
 * Regras do sistema social. Toda decisão acontece aqui, no servidor:
 * o cliente só diz "quero adicionar fulano", nunca "somos amigos".
 */
export class SocialService {
  constructor(private db: PrismaClient, private bus: SocialBus) {}

  private notify(userId: string, type: string, title: string, body: string, data?: Prisma.InputJsonValue) {
    return this.db.notification.create({ data: { userId, type, title, body, data } });
  }

  async friendIds(userId: string): Promise<string[]> {
    const rows = await this.db.friend.findMany({ where: { OR: [{ userAId: userId }, { userBId: userId }] }, select: { userAId: true, userBId: true } });
    return rows.map((r) => (r.userAId === userId ? r.userBId : r.userAId));
  }

  async relations(userId: string, others: string[]): Promise<Map<string, SocialRelation>> {
    const out = new Map<string, SocialRelation>(others.map((id) => [id, "none"]));
    if (!others.length) return out;
    const [friends, reqs, blocks] = await Promise.all([
      this.db.friend.findMany({ where: { OR: [{ userAId: userId, userBId: { in: others } }, { userBId: userId, userAId: { in: others } }] } }),
      this.db.friendRequest.findMany({ where: { status: "PENDING", OR: [{ fromId: userId, toId: { in: others } }, { toId: userId, fromId: { in: others } }] } }),
      this.db.userBlock.findMany({ where: { blockerId: userId, blockedId: { in: others } } }),
    ]);
    for (const r of reqs) out.set(r.fromId === userId ? r.toId : r.fromId, r.fromId === userId ? "pending_out" : "pending_in");
    for (const f of friends) out.set(f.userAId === userId ? f.userBId : f.userAId, "friend");
    for (const b of blocks) out.set(b.blockedId, "blocked");
    return out;
  }

  private async isBlockedEitherWay(a: string, b: string) {
    return !!(await this.db.userBlock.findFirst({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] }, select: { id: true } }));
  }

  async overview(userId: string): Promise<SocialOverviewResponse> {
    const [friends, incoming, outgoing, blocked, muted] = await Promise.all([
      this.db.friend.findMany({ where: { OR: [{ userAId: userId }, { userBId: userId }] }, include: { userA: { select: USER_VIEW_SELECT }, userB: { select: USER_VIEW_SELECT } } }),
      this.db.friendRequest.findMany({ where: { toId: userId, status: "PENDING" }, include: { from: { select: USER_VIEW_SELECT } }, orderBy: { createdAt: "desc" } }),
      this.db.friendRequest.findMany({ where: { fromId: userId, status: "PENDING" }, include: { to: { select: USER_VIEW_SELECT } }, orderBy: { createdAt: "desc" } }),
      this.db.userBlock.findMany({ where: { blockerId: userId }, include: { blocked: { select: USER_VIEW_SELECT } }, orderBy: { createdAt: "desc" } }),
      this.db.userMute.findMany({ where: { muterId: userId }, include: { muted: { select: USER_VIEW_SELECT } }, orderBy: { createdAt: "desc" } }),
    ]);
    return {
      friends: friends
        .map((f) => ({ ...toUserView(f.userAId === userId ? f.userB : f.userA), since: f.createdAt.toISOString() }))
        .sort((a, b) => a.username.localeCompare(b.username)),
      incoming: incoming.map((r): FriendRequestView => ({ id: r.id, user: toUserView(r.from), createdAt: r.createdAt.toISOString() })),
      outgoing: outgoing.map((r): FriendRequestView => ({ id: r.id, user: toUserView(r.to), createdAt: r.createdAt.toISOString() })),
      blocked: blocked.map((b) => toUserView(b.blocked)),
      muted: muted.map((m) => toUserView(m.muted)),
    };
  }

  async search(userId: string, q: string): Promise<UserSearchResult[]> {
    const term = q.trim().toLowerCase();
    if (term.length < 2) return [];
    const rows = await this.db.user.findMany({
      where: {
        usernameLower: { startsWith: term },
        status: "ACTIVE",
        id: { not: userId },
        // Quem me bloqueou não aparece para mim.
        blocks: { none: { blockedId: userId } },
      },
      select: USER_VIEW_SELECT,
      orderBy: { usernameLower: "asc" },
      take: 10,
    });
    const rel = await this.relations(userId, rows.map((r) => r.id));
    return rows.map((r) => ({ ...toUserView(r), relation: rel.get(r.id) ?? "none" }));
  }

  /** Jogadores das últimas partidas (mais recentes primeiro, sem repetir). */
  async recent(userId: string): Promise<RecentPlayerView[]> {
    const mine = await this.db.matchPlayer.findMany({
      where: { userId },
      orderBy: { joinedAt: "desc" },
      take: 20,
      select: { team: true, match: { select: { id: true, endedAt: true, createdAt: true, players: { select: { userId: true, team: true, user: { select: USER_VIEW_SELECT } } } } } },
    });
    const seen = new Map<string, RecentPlayerView>();
    for (const m of mine) {
      for (const p of m.match.players) {
        if (p.userId === userId || seen.has(p.userId)) continue;
        seen.set(p.userId, {
          ...toUserView(p.user),
          relation: "none",
          lastMatchAt: (m.match.endedAt ?? m.match.createdAt).toISOString(),
          lastMatchId: m.match.id,
          teammate: p.team === m.team,
        });
      }
    }
    const list = [...seen.values()].slice(0, 30);
    const rel = await this.relations(userId, list.map((p) => p.id));
    return list.map((p) => ({ ...p, relation: rel.get(p.id) ?? "none" }));
  }

  async sendRequest(userId: string, username: string): Promise<{ status: "sent" | "accepted"; requestId: string }> {
    const target = await this.db.user.findUnique({ where: { usernameLower: username.trim().toLowerCase() }, select: { ...USER_VIEW_SELECT, status: true } });
    // Conta inexistente, inativa ou que me bloqueou: mesma resposta (não revela bloqueio).
    if (!target || target.status !== "ACTIVE") throw Errors.notFound("Jogador não encontrado.");
    if (target.id === userId) throw Errors.badRequest("SELF", "Você não pode adicionar a si mesmo.");
    const iBlocked = await this.db.userBlock.findUnique({ where: { blockerId_blockedId: { blockerId: userId, blockedId: target.id } } });
    if (iBlocked) throw Errors.conflict("BLOCKED", "Você bloqueou este jogador. Desbloqueie antes de adicionar.");
    if (await this.isBlockedEitherWay(userId, target.id)) throw Errors.notFound("Jogador não encontrado.");
    if (await this.db.friend.findUnique({ where: { userAId_userBId: pair(userId, target.id) } })) throw Errors.conflict("ALREADY_FRIENDS", "Vocês já são amigos.");

    // Ele já tinha me convidado: adicionar = aceitar.
    const reverse = await this.db.friendRequest.findFirst({ where: { fromId: target.id, toId: userId, status: "PENDING" } });
    if (reverse) {
      await this.accept(userId, reverse.id);
      return { status: "accepted", requestId: reverse.id };
    }
    const [mine, theirs] = await Promise.all([this.db.friend.count({ where: { OR: [{ userAId: userId }, { userBId: userId }] } }), this.db.friend.count({ where: { OR: [{ userAId: target.id }, { userBId: target.id }] } })]);
    if (mine >= FRIEND_LIMIT) throw Errors.conflict("FRIEND_LIMIT", `Você atingiu o limite de ${FRIEND_LIMIT} amigos.`);
    if (theirs >= FRIEND_LIMIT) throw Errors.conflict("FRIEND_LIMIT", "Este jogador atingiu o limite de amigos.");
    const pendingOut = await this.db.friendRequest.count({ where: { fromId: userId, status: "PENDING" } });
    if (pendingOut >= 50) throw Errors.conflict("TOO_MANY_PENDING", "Você tem muitos pedidos pendentes. Cancele alguns antes.");

    let req;
    try {
      req = await this.db.friendRequest.create({ data: { fromId: userId, toId: target.id } });
    } catch (e) {
      // Índice único parcial: no máximo um pedido pendente por direção.
      if (isUnique(e)) throw Errors.conflict("REQUEST_PENDING", "Você já enviou um pedido para este jogador.");
      throw e;
    }
    const me = await this.db.user.findUniqueOrThrow({ where: { id: userId }, select: USER_VIEW_SELECT });
    await this.notify(target.id, "FRIEND_REQUEST", "Pedido de amizade", `${me.username} quer ser seu amigo.`, { requestId: req.id, fromId: userId });
    await this.bus.publish([target.id], { k: "friend_request", requestId: req.id, from: toUserView(me) });
    return { status: "sent", requestId: req.id };
  }

  async accept(userId: string, requestId: string) {
    const req = await this.db.friendRequest.findUnique({ where: { id: requestId } });
    if (!req || req.toId !== userId || req.status !== "PENDING") throw Errors.notFound("Pedido não encontrado.");
    if (await this.isBlockedEitherWay(req.fromId, req.toId)) throw Errors.notFound("Pedido não encontrado.");
    const mine = await this.db.friend.count({ where: { OR: [{ userAId: userId }, { userBId: userId }] } });
    if (mine >= FRIEND_LIMIT) throw Errors.conflict("FRIEND_LIMIT", `Você atingiu o limite de ${FRIEND_LIMIT} amigos.`);
    await this.db.$transaction(async (tx) => {
      // updateMany com status no filtro: dois cliques simultâneos não aceitam duas vezes.
      const done = await tx.friendRequest.updateMany({ where: { id: req.id, status: "PENDING" }, data: { status: "ACCEPTED", respondedAt: new Date() } });
      if (!done.count) throw Errors.notFound("Pedido não encontrado.");
      await tx.friendRequest.updateMany({ where: { fromId: req.toId, toId: req.fromId, status: "PENDING" }, data: { status: "ACCEPTED", respondedAt: new Date() } });
      await tx.friend.upsert({ where: { userAId_userBId: pair(req.fromId, req.toId) }, update: {}, create: pair(req.fromId, req.toId) });
    });
    const [from, to] = await Promise.all([
      this.db.user.findUniqueOrThrow({ where: { id: req.fromId }, select: USER_VIEW_SELECT }),
      this.db.user.findUniqueOrThrow({ where: { id: req.toId }, select: USER_VIEW_SELECT }),
    ]);
    await this.notify(from.id, "FRIEND_ACCEPTED", "Amizade aceita", `${to.username} aceitou seu pedido de amizade.`, { userId: to.id });
    await this.bus.publish([from.id], { k: "friend_accepted", friend: toUserView(to) });
    await this.bus.publish([to.id], { k: "friend_accepted", friend: toUserView(from) });
  }

  async decline(userId: string, requestId: string) {
    const done = await this.db.friendRequest.updateMany({ where: { id: requestId, toId: userId, status: "PENDING" }, data: { status: "DECLINED", respondedAt: new Date() } });
    if (!done.count) throw Errors.notFound("Pedido não encontrado.");
    const req = await this.db.friendRequest.findUniqueOrThrow({ where: { id: requestId } });
    // Quem enviou não é avisado da recusa (só some da lista dele ao recarregar).
    await this.bus.publish([userId], { k: "request_closed", requestId });
    return req;
  }

  async cancel(userId: string, requestId: string) {
    const done = await this.db.friendRequest.updateMany({ where: { id: requestId, fromId: userId, status: "PENDING" }, data: { status: "CANCELLED", respondedAt: new Date() } });
    if (!done.count) throw Errors.notFound("Pedido não encontrado.");
    const req = await this.db.friendRequest.findUniqueOrThrow({ where: { id: requestId } });
    await this.bus.publish([req.toId, userId], { k: "request_closed", requestId });
  }

  async removeFriend(userId: string, otherId: string) {
    const done = await this.db.friend.deleteMany({ where: pair(userId, otherId) });
    if (!done.count) throw Errors.notFound("Vocês não são amigos.");
    await this.bus.publish([userId], { k: "friend_removed", userId: otherId });
    await this.bus.publish([otherId], { k: "friend_removed", userId });
  }

  /** Bloquear desfaz a amizade, encerra pedidos e impede chat, convites e novos pedidos nos dois sentidos. */
  async block(userId: string, otherId: string) {
    if (otherId === userId) throw Errors.badRequest("SELF", "Você não pode bloquear a si mesmo.");
    const other = await this.db.user.findUnique({ where: { id: otherId }, select: { id: true } });
    if (!other) throw Errors.notFound("Jogador não encontrado.");
    let wasFriend = false;
    await this.db.$transaction(async (tx) => {
      try {
        await tx.userBlock.create({ data: { blockerId: userId, blockedId: otherId } });
      } catch (e) {
        if (!isUnique(e)) throw e;
      }
      wasFriend = (await tx.friend.deleteMany({ where: pair(userId, otherId) })).count > 0;
      await tx.friendRequest.updateMany({
        where: { status: "PENDING", OR: [{ fromId: userId, toId: otherId }, { fromId: otherId, toId: userId }] },
        data: { status: "CANCELLED", respondedAt: new Date() },
      });
    });
    if (wasFriend) {
      await this.bus.publish([userId], { k: "friend_removed", userId: otherId });
      await this.bus.publish([otherId], { k: "friend_removed", userId });
    }
    await this.bus.publish([userId, otherId], { k: "relations_changed" });
  }

  async unblock(userId: string, otherId: string) {
    const done = await this.db.userBlock.deleteMany({ where: { blockerId: userId, blockedId: otherId } });
    if (!done.count) throw Errors.notFound("Este jogador não está bloqueado.");
    await this.bus.publish([userId, otherId], { k: "relations_changed" });
  }

  async mute(userId: string, otherId: string) {
    if (otherId === userId) throw Errors.badRequest("SELF", "Você não pode silenciar a si mesmo.");
    if (!(await this.db.user.findUnique({ where: { id: otherId }, select: { id: true } }))) throw Errors.notFound("Jogador não encontrado.");
    await this.db.userMute.upsert({ where: { muterId_mutedId: { muterId: userId, mutedId: otherId } }, update: {}, create: { muterId: userId, mutedId: otherId } });
    await this.bus.publish([userId], { k: "relations_changed" });
  }

  async unmute(userId: string, otherId: string) {
    await this.db.userMute.deleteMany({ where: { muterId: userId, mutedId: otherId } });
    await this.bus.publish([userId], { k: "relations_changed" });
  }

  async report(userId: string, body: { userId: string; reason: ReportReasonCode; matchId?: string; description?: string }) {
    if (body.userId === userId) throw Errors.badRequest("SELF", "Você não pode denunciar a si mesmo.");
    const target = await this.db.user.findUnique({ where: { id: body.userId }, select: { id: true } });
    if (!target) throw Errors.notFound("Jogador não encontrado.");
    if (body.matchId) {
      // Só quem jogou a partida pode denunciar alguém dela (e o denunciado precisa ter jogado).
      const n = await this.db.matchPlayer.count({ where: { matchId: body.matchId, userId: { in: [userId, body.userId] } } });
      if (n < 2) throw Errors.badRequest("NOT_IN_MATCH", "Vocês não jogaram essa partida juntos.");
    }
    const since = new Date(Date.now() - 24 * 3600_000);
    const dup = await this.db.report.findFirst({
      where: { reporterId: userId, reportedId: body.userId, status: { in: ["OPEN", "IN_REVIEW"] }, createdAt: { gte: since }, ...(body.matchId ? { matchId: body.matchId } : {}) },
    });
    if (dup) throw Errors.conflict("ALREADY_REPORTED", "Você já denunciou este jogador. A moderação vai analisar.");
    const r = await this.db.report.create({
      data: { reporterId: userId, reportedId: body.userId, reason: body.reason, matchId: body.matchId ?? null, description: body.description?.trim() || null },
    });
    return { id: r.id, status: r.status };
  }
}
