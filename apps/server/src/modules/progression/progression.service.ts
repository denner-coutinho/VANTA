import type { Prisma, PrismaClient } from "@vanta/db";
import {
  MEDALS,
  computeMedals,
  levelFromTotalXp,
  matchXp,
  objectiveDelta,
  objectiveTotal,
  periodEndsAt,
  periodKey,
  type AchievementView,
  type MatchOutcome,
  type MatchProgressWire,
  type MedalCode,
  type MissionView,
  type Objective,
  type ProgressionResponse,
} from "@vanta/shared";
import { Errors } from "../../lib/errors.js";
import { postLedger } from "../economy/wallet.js";

type Tx = Prisma.TransactionClient | PrismaClient;
type MissionRow = Prisma.MissionGetPayload<{ include: { event: true } }>;

/** O que o servidor de jogo entrega depois de gravar a partida. */
export interface ProgressMatchInput {
  matchId: string;
  winner: 0 | 1 | null;
  players: Array<{ id: string; team: 0 | 1; kills: number; deaths: number; assists: number; headshots: number; shots: number; hits: number; mvp: boolean; abandoned: boolean }>;
  events: Array<{ round: number; type: string; actorId?: string; targetId?: string; data: object }>;
}

const parseObjective = (o: unknown): Objective => {
  const v = o as Partial<Objective>;
  return { stat: (v.stat ?? "matchesPlayed") as Objective["stat"], target: Math.max(1, Number(v.target) || 1) };
};

/** Missões valendo agora: ativas, dentro da janela e (se de evento) com o evento publicado e em andamento. */
async function activeMissions(tx: Tx, now: Date): Promise<MissionRow[]> {
  const rows = await tx.mission.findMany({
    where: { isActive: true, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] },
    include: { event: true },
    orderBy: [{ period: "asc" }, { code: "asc" }],
  });
  return rows.filter((m) => !m.event || (m.event.isPublished && m.event.startsAt <= now && m.event.endsAt > now));
}

/** Soma XP (uma vez por origem: repetir não soma de novo) e recalcula o nível. Devolve o nível depois. */
export async function grantXp(tx: Tx, userId: string, amount: number, source: "MATCH" | "MISSION" | "ACHIEVEMENT", refId: string): Promise<{ applied: boolean; level: number }> {
  const profile = await tx.userProfile.findUniqueOrThrow({ where: { userId }, select: { totalXp: true, level: true } });
  if (amount <= 0) return { applied: false, level: profile.level };
  const exists = await tx.xpGrant.findUnique({ where: { userId_source_refId: { userId, source, refId } } });
  if (exists) return { applied: false, level: profile.level };
  const updated = await tx.userProfile.update({ where: { userId }, data: { totalXp: { increment: amount } }, select: { totalXp: true } });
  const level = levelFromTotalXp(updated.totalXp).level;
  if (level !== profile.level) await tx.userProfile.update({ where: { userId }, data: { level } });
  await tx.xpGrant.create({ data: { userId, amount, source, refId, levelAfter: level } });
  return { applied: true, level };
}

/** Totais da conta usados pelas conquistas (estatísticas do perfil, medalhas e nível). */
async function totalsFor(tx: Tx, userId: string): Promise<Record<string, number>> {
  const [p, medals] = await Promise.all([
    tx.userProfile.findUniqueOrThrow({ where: { userId } }),
    tx.userMedal.findMany({ where: { userId } }),
  ]);
  const t: Record<string, number> = { matchesPlayed: p.matchesPlayed, wins: p.wins, kills: p.kills, assists: p.assists, headshots: p.headshots, mvpCount: p.mvpCount, level: p.level, medals: 0 };
  for (const m of medals) {
    t[`medal:${m.code}`] = m.count;
    t.medals! += m.count;
  }
  return t;
}

/** Confere as conquistas; as novas dão XP (e título). Roda de novo se o XP subir o nível (conquista de nível). */
async function checkAchievements(tx: Tx, userId: string): Promise<Array<{ name: string; title: string | null }>> {
  const unlocked: Array<{ name: string; title: string | null }> = [];
  const all = await tx.achievement.findMany();
  for (let pass = 0; pass < 3; pass++) {
    const totals = await totalsFor(tx, userId);
    const mine = new Map((await tx.userAchievement.findMany({ where: { userId } })).map((u) => [u.achievementId, u]));
    let leveled = false;
    for (const a of all) {
      if (mine.get(a.id)?.unlockedAt) continue;
      const o = parseObjective(a.objective);
      const progress = Math.min(o.target, objectiveTotal(o, totals));
      const done = progress >= o.target;
      if (!done && (mine.get(a.id)?.progress ?? 0) === progress) continue;
      await tx.userAchievement.upsert({
        where: { userId_achievementId: { userId, achievementId: a.id } },
        create: { userId, achievementId: a.id, progress, unlockedAt: done ? new Date() : null },
        update: { progress, unlockedAt: done ? new Date() : null },
      });
      if (done) {
        unlocked.push({ name: a.name, title: a.rewardTitle });
        const before = totals.level!;
        const g = await grantXp(tx, userId, a.rewardXp, "ACHIEVEMENT", a.id);
        if (g.level !== before) leveled = true;
      }
    }
    if (!leveled) break;
  }
  return unlocked;
}

/**
 * Progressão ao fim de uma partida da fila (casual ou ranqueada), na mesma transação que grava a partida:
 * medalhas, XP, missões e conquistas. Quem abandonou não ganha nada.
 */
export async function applyMatchProgression(tx: Tx, input: ProgressMatchInput, outcomeOf: (p: ProgressMatchInput["players"][number]) => MatchOutcome, now = new Date()): Promise<Array<{ userId: string; wire: MatchProgressWire }>> {
  const medals = computeMedals(input.players, input.events, input.winner);
  const missions = await activeMissions(tx, now);
  const out: Array<{ userId: string; wire: MatchProgressWire }> = [];
  for (const p of input.players) {
    const outcome = outcomeOf(p);
    const before = await tx.userProfile.findUniqueOrThrow({ where: { userId: p.id }, select: { level: true } });
    const myMedals = medals.get(p.id) ?? [];
    const xp = matchXp(p, outcome);
    await tx.matchPlayer.updateMany({ where: { matchId: input.matchId, userId: p.id }, data: { xpEarned: xp, medals: myMedals } });
    for (const code of myMedals) await tx.userMedal.upsert({ where: { userId_code: { userId: p.id, code } }, create: { userId: p.id, code, count: 1 }, update: { count: { increment: 1 } } });

    const missionsCompleted: string[] = [];
    if (outcome !== "ABANDONED") {
      const stats = { won: outcome === "WIN", kills: p.kills, assists: p.assists, headshots: p.headshots, mvp: p.mvp, medals: myMedals };
      for (const m of missions) {
        const o = parseObjective(m.objective);
        const delta = objectiveDelta(o, stats);
        if (delta <= 0) continue;
        const key = periodKey(m.period, now, m.eventId);
        const cur = await tx.userMission.upsert({ where: { userId_missionId_periodKey: { userId: p.id, missionId: m.id, periodKey: key } }, create: { userId: p.id, missionId: m.id, periodKey: key }, update: {} });
        if (cur.completedAt) continue;
        const progress = Math.min(o.target, cur.progress + delta);
        const done = progress >= o.target;
        await tx.userMission.update({ where: { id: cur.id }, data: { progress, completedAt: done ? now : null } });
        if (done) missionsCompleted.push(m.name);
      }
    }
    await grantXp(tx, p.id, xp, "MATCH", input.matchId);
    const achievementsUnlocked = outcome === "ABANDONED" ? [] : await checkAchievements(tx, p.id);
    const after = await tx.userProfile.findUniqueOrThrow({ where: { userId: p.id }, select: { totalXp: true, level: true } });
    const lv = levelFromTotalXp(after.totalXp);
    out.push({ userId: p.id, wire: { t: "progress", matchId: input.matchId, xp, levelBefore: before.level, levelAfter: after.level, xpIntoLevel: lv.xpIntoLevel, xpForNext: lv.xpForNext, medals: myMedals, missionsCompleted, achievementsUnlocked } });
  }
  return out;
}

export class ProgressionService {
  constructor(private db: PrismaClient) {}

  async titles(userId: string): Promise<string[]> {
    const rows = await this.db.userAchievement.findMany({ where: { userId, unlockedAt: { not: null }, achievement: { rewardTitle: { not: null } } }, select: { achievement: { select: { rewardTitle: true } } } });
    return [...new Set(rows.map((r) => r.achievement.rewardTitle!))];
  }

  async overview(userId: string, now = new Date()): Promise<ProgressionResponse> {
    const db = this.db;
    const [profile, missions, achievements, mine, medals, history, titles] = await Promise.all([
      db.userProfile.findUniqueOrThrow({ where: { userId } }),
      activeMissions(db, now),
      db.achievement.findMany({ orderBy: { createdAt: "asc" } }),
      db.userAchievement.findMany({ where: { userId } }),
      db.userMedal.findMany({ where: { userId } }),
      db.xpGrant.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 30 }),
      this.titles(userId),
    ]);
    const keys = missions.map((m) => ({ missionId: m.id, periodKey: periodKey(m.period, now, m.eventId) }));
    const ums = keys.length ? await db.userMission.findMany({ where: { userId, OR: keys } }) : [];
    const umOf = (id: string, key: string) => ums.find((u) => u.missionId === id && u.periodKey === key);
    const missionViews: MissionView[] = missions.map((m) => {
      const o = parseObjective(m.objective);
      const um = umOf(m.id, periodKey(m.period, now, m.eventId));
      const endsAt = m.period === "DAILY" || m.period === "WEEKLY" ? periodEndsAt(m.period, now) : (m.event?.endsAt ?? m.endsAt);
      return { id: m.id, code: m.code, name: m.name, description: m.description, period: m.period, target: o.target, progress: um?.progress ?? 0, completed: !!um?.completedAt, claimed: !!um?.claimedAt, rewardXp: m.rewardXp, rewardCoins: m.rewardCoins, endsAt: endsAt ? endsAt.toISOString() : null, event: m.event ? { code: m.event.code, name: m.event.name } : null };
    });
    const ua = new Map(mine.map((u) => [u.achievementId, u]));
    const achievementViews: AchievementView[] = achievements
      .filter((a) => !a.isHidden || ua.get(a.id)?.unlockedAt)
      .map((a) => {
        const u = ua.get(a.id);
        return { id: a.id, code: a.code, name: a.name, description: a.description, target: parseObjective(a.objective).target, progress: u?.progress ?? 0, unlockedAt: u?.unlockedAt?.toISOString() ?? null, rewardXp: a.rewardXp, rewardTitle: a.rewardTitle };
      });
    const labelIds = { MISSION: new Set<string>(), ACHIEVEMENT: new Set<string>() };
    for (const h of history) if (h.source !== "MATCH") labelIds[h.source as "MISSION" | "ACHIEVEMENT"]?.add(h.refId);
    const [ums2, achs] = await Promise.all([
      labelIds.MISSION.size ? db.userMission.findMany({ where: { id: { in: [...labelIds.MISSION] } }, select: { id: true, mission: { select: { name: true } } } }) : [],
      labelIds.ACHIEVEMENT.size ? db.achievement.findMany({ where: { id: { in: [...labelIds.ACHIEVEMENT] } }, select: { id: true, name: true } }) : [],
    ]);
    const label = (source: string, refId: string) =>
      source === "MATCH" ? "Partida" : source === "MISSION" ? `Missão: ${ums2.find((u) => u.id === refId)?.mission.name ?? "?"}` : `Conquista: ${achs.find((a) => a.id === refId)?.name ?? "?"}`;
    const lv = levelFromTotalXp(profile.totalXp);
    return {
      level: profile.level,
      totalXp: profile.totalXp,
      xpIntoLevel: lv.xpIntoLevel,
      xpForNext: lv.xpForNext,
      title: profile.title,
      titles,
      missions: missionViews,
      achievements: achievementViews,
      medals: (Object.keys(MEDALS) as MedalCode[]).map((code) => ({ code, ...MEDALS[code], count: medals.find((m) => m.code === code)?.count ?? 0 })),
      history: history.map((h) => ({ amount: h.amount, source: h.source, label: label(h.source, h.refId), levelAfter: h.levelAfter, at: h.createdAt.toISOString() })),
    };
  }

  /** Resgata a recompensa de uma missão concluída na janela atual (uma vez só, mesmo com cliques simultâneos). */
  async claim(userId: string, missionId: string, now = new Date()) {
    const m = (await activeMissions(this.db, now)).find((x) => x.id === missionId);
    if (!m) throw Errors.notFound("Missão não encontrada ou fora do prazo.");
    const key = periodKey(m.period, now, m.eventId);
    return this.db.$transaction(async (tx) => {
      const um = await tx.userMission.findUnique({ where: { userId_missionId_periodKey: { userId, missionId, periodKey: key } } });
      if (!um?.completedAt) throw Errors.conflict("MISSION_INCOMPLETE", "Conclua a missão antes de resgatar.");
      const taken = await tx.userMission.updateMany({ where: { id: um.id, claimedAt: null }, data: { claimedAt: now } });
      if (taken.count !== 1) throw Errors.conflict("MISSION_CLAIMED", "Recompensa já resgatada.");
      const g = await grantXp(tx, userId, m.rewardXp, "MISSION", um.id);
      if (m.rewardCoins > 0) await postLedger(tx, { userId, amount: m.rewardCoins, type: "REWARD_CREDIT", idempotencyKey: `mission:${um.id}`, description: `Missão: ${m.name}` });
      const achievementsUnlocked = await checkAchievements(tx, userId);
      return { xp: m.rewardXp, coins: m.rewardCoins, level: g.level, achievementsUnlocked };
    });
  }

  async setTitle(userId: string, title: string | null) {
    if (title !== null && !(await this.titles(userId)).includes(title)) throw Errors.badRequest("TITLE_LOCKED", "Você ainda não desbloqueou este título.");
    await this.db.userProfile.update({ where: { userId }, data: { title } });
    return { title };
  }
}
