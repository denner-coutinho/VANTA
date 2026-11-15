/**
 * Curva de níveis do jogador (XP de conta, separada da patente competitiva).
 * XP necessário para ir do nível n para n+1: 500 + 150·(n−1). Nível máximo: 200.
 */
export const MAX_PLAYER_LEVEL = 200;

export function xpToNextLevel(level: number): number {
  return 500 + 150 * (Math.max(1, level) - 1);
}

export function levelFromTotalXp(totalXp: number): { level: number; xpIntoLevel: number; xpForNext: number } {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  while (level < MAX_PLAYER_LEVEL && remaining >= xpToNextLevel(level)) {
    remaining -= xpToNextLevel(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpForNext: level >= MAX_PLAYER_LEVEL ? 0 : xpToNextLevel(level) };
}

// ───────────── XP por partida ─────────────

export type MatchOutcome = "WIN" | "LOSS" | "DRAW" | "ABANDONED";

/** Teto de XP por partida (evita picos absurdos em partidas longas). */
export const MATCH_XP_CAP = 1500;

/**
 * XP de conta ao fim de uma partida da fila (casual ou ranqueada). Partidas de sala não dão XP
 * (as regras são livres e daria para "farmar"). Abandono não dá nada.
 */
export function matchXp(p: { kills: number; assists: number; headshots: number; mvp: boolean }, outcome: MatchOutcome): number {
  if (outcome === "ABANDONED") return 0;
  const base = 100 + (outcome === "WIN" ? 150 : outcome === "DRAW" ? 75 : 0);
  return Math.min(MATCH_XP_CAP, base + p.kills * 20 + p.assists * 10 + p.headshots * 5 + (p.mvp ? 100 : 0));
}

// ───────────── Medalhas ─────────────

export const MEDALS = {
  MVP: { name: "MVP", description: "Melhor jogador do time vencedor." },
  ACE: { name: "Ace", description: "Eliminou o time adversário inteiro (2 ou mais) sozinho num round." },
  CLUTCH: { name: "Sangue frio", description: "Venceu um round sendo o último vivo do time contra 2 ou mais." },
  OPENER: { name: "Abertura", description: "Fez a primeira eliminação do round 3 vezes na partida." },
  HEADHUNTER: { name: "Caçador de cabeças", description: "5 ou mais headshots, com metade das eliminações na cabeça." },
  PRECISION: { name: "Precisão", description: "Acertou 45% dos disparos (mínimo de 20)." },
  FLAWLESS: { name: "Impecável", description: "Venceu a partida sem morrer nenhuma vez." },
} as const;
export type MedalCode = keyof typeof MEDALS;

export interface MedalPlayer {
  id: string;
  team: 0 | 1;
  kills: number;
  deaths: number;
  headshots: number;
  shots: number;
  hits: number;
  mvp: boolean;
  abandoned: boolean;
}
export interface MedalEvent {
  round: number;
  type: string;
  actorId?: string;
  targetId?: string;
  data: object;
}

/** Medalhas de cada jogador, calculadas no servidor a partir do registro da partida. */
export function computeMedals(players: MedalPlayer[], events: MedalEvent[], winner: 0 | 1 | null): Map<string, MedalCode[]> {
  const out = new Map<string, Set<MedalCode>>(players.map((p) => [p.id, new Set()]));
  const team = new Map(players.map((p) => [p.id, p.team]));
  const size: [number, number] = [players.filter((p) => p.team === 0).length, players.filter((p) => p.team === 1).length];
  const opens = new Map<string, number>();

  const rounds = new Map<number, MedalEvent[]>();
  for (const e of events) {
    if (e.type !== "kill" && e.type !== "round_end") continue;
    let list = rounds.get(e.round);
    if (!list) rounds.set(e.round, (list = []));
    list.push(e);
  }
  for (const list of rounds.values()) {
    const alive: [Set<string>, Set<string>] = [new Set(), new Set()];
    for (const p of players) alive[p.team].add(p.id);
    const killsBy = new Map<string, number>();
    const clutch = new Set<string>();
    let first = true;
    for (const e of list) {
      if (e.type === "kill" && e.actorId && e.targetId) {
        const vt = team.get(e.targetId);
        if (vt === undefined) continue;
        alive[vt].delete(e.targetId);
        const teamKill = (e.data as { teamKill?: boolean }).teamKill === true;
        if (!teamKill) {
          killsBy.set(e.actorId, (killsBy.get(e.actorId) ?? 0) + 1);
          if (first) opens.set(e.actorId, (opens.get(e.actorId) ?? 0) + 1);
          first = false;
        }
        // Último vivo do time contra 2 ou mais: candidato a "sangue frio".
        for (const t of [0, 1] as const) {
          if (alive[t].size === 1 && alive[t === 0 ? 1 : 0].size >= 2) clutch.add([...alive[t]][0]!);
        }
      } else if (e.type === "round_end") {
        const w = (e.data as { winner?: 0 | 1 | null }).winner;
        for (const id of clutch) if (w !== null && w !== undefined && team.get(id) === w && alive[w].has(id)) out.get(id)?.add("CLUTCH");
        for (const [id, k] of killsBy) {
          const enemies = size[team.get(id) === 0 ? 1 : 0];
          if (enemies >= 2 && k >= enemies) out.get(id)?.add("ACE");
        }
      }
    }
  }
  for (const p of players) {
    const m = out.get(p.id)!;
    if (p.abandoned) {
      m.clear();
      continue;
    }
    if (p.mvp) m.add("MVP");
    if ((opens.get(p.id) ?? 0) >= 3) m.add("OPENER");
    if (p.headshots >= 5 && p.headshots * 2 >= p.kills) m.add("HEADHUNTER");
    if (p.shots >= 20 && p.hits / p.shots >= 0.45) m.add("PRECISION");
    if (winner !== null && p.team === winner && p.deaths === 0 && p.kills > 0) m.add("FLAWLESS");
  }
  return new Map([...out].map(([id, s]) => [id, [...s]]));
}

// ───────────── Missões e conquistas ─────────────

/** Estatísticas que missões (por partida) e conquistas (acumuladas) sabem contar. */
export const PROGRESS_STATS = ["matchesPlayed", "wins", "kills", "assists", "headshots", "mvpCount", "medals", "level"] as const;
export type ProgressStat = (typeof PROGRESS_STATS)[number];
export interface Objective {
  stat: ProgressStat | `medal:${MedalCode}`;
  target: number;
}

/** As missões viram à meia-noite de Brasília (UTC−3, sem horário de verão). */
const BRT_OFFSET_MS = -3 * 3600_000;

/** Chave da janela da missão: dia (AAAA-MM-DD) ou semana começando na segunda (W-AAAA-MM-DD). */
export function periodKey(period: "DAILY" | "WEEKLY" | "SEASONAL" | "EVENT" | "ONE_TIME", now: Date, eventId?: string | null): string {
  const local = new Date(now.getTime() + BRT_OFFSET_MS);
  const day = local.toISOString().slice(0, 10);
  if (period === "DAILY") return day;
  if (period === "WEEKLY") {
    const dow = (local.getUTCDay() + 6) % 7; // 0 = segunda
    return `W-${new Date(local.getTime() - dow * 86400_000).toISOString().slice(0, 10)}`;
  }
  if (period === "EVENT") return `E-${eventId ?? "?"}`;
  if (period === "SEASONAL") return `S-${local.getUTCFullYear()}`;
  return "ONCE";
}

/** Fim da janela atual (para mostrar "renova em"). */
export function periodEndsAt(period: "DAILY" | "WEEKLY", now: Date): Date {
  const local = new Date(now.getTime() + BRT_OFFSET_MS);
  const startOfDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const days = period === "DAILY" ? 1 : 7 - ((local.getUTCDay() + 6) % 7);
  return new Date(startOfDay + days * 86400_000 - BRT_OFFSET_MS);
}

/** Quanto uma partida avança um objetivo. */
export function objectiveDelta(o: Objective, m: { won: boolean; kills: number; assists: number; headshots: number; mvp: boolean; medals: string[] }): number {
  if (o.stat.startsWith("medal:")) return m.medals.includes(o.stat.slice(6)) ? 1 : 0;
  switch (o.stat) {
    case "matchesPlayed": return 1;
    case "wins": return m.won ? 1 : 0;
    case "kills": return m.kills;
    case "assists": return m.assists;
    case "headshots": return m.headshots;
    case "mvpCount": return m.mvp ? 1 : 0;
    case "medals": return m.medals.length;
    default: return 0;
  }
}

/** Progresso de uma conquista a partir dos totais da conta. */
export function objectiveTotal(o: Objective, totals: Record<string, number>): number {
  return totals[o.stat] ?? 0;
}

// ───────────── Tipos da API ─────────────

export interface MissionView {
  id: string;
  code: string;
  name: string;
  description: string;
  period: "DAILY" | "WEEKLY" | "EVENT" | "SEASONAL" | "ONE_TIME";
  target: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
  rewardXp: number;
  rewardCoins: number;
  endsAt: string | null;
  event: { code: string; name: string } | null;
}

export interface AchievementView {
  id: string;
  code: string;
  name: string;
  description: string;
  target: number;
  progress: number;
  unlockedAt: string | null;
  rewardXp: number;
  rewardTitle: string | null;
}

export interface ProgressionResponse {
  level: number;
  totalXp: number;
  xpIntoLevel: number;
  xpForNext: number;
  title: string | null;
  titles: string[];
  missions: MissionView[];
  achievements: AchievementView[];
  medals: Array<{ code: MedalCode; name: string; description: string; count: number }>;
  history: Array<{ amount: number; source: string; label: string; levelAfter: number; at: string }>;
}

/** Resumo enviado a cada jogador depois que a partida é gravada. */
export interface MatchProgressWire {
  t: "progress";
  matchId: string;
  xp: number;
  levelBefore: number;
  levelAfter: number;
  xpIntoLevel: number;
  xpForNext: number;
  medals: MedalCode[];
  missionsCompleted: string[];
  achievementsUnlocked: Array<{ name: string; title: string | null }>;
}
