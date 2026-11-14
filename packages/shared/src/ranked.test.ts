import { describe, expect, it } from "vitest";
import { RANKS, rankForPoints } from "./ranks.js";
import {
  GLICKO,
  RANKED_RULES,
  abandonCooldownMinutes,
  applyRankedResult,
  balanceTeams,
  defaultRating,
  glicko2Update,
  mmrWindow,
  pickMatchGroup,
  pointsForMmr,
  seasonSoftReset,
  teamRating,
  winProbability,
} from "./ranked.js";

describe("Glicko-2", () => {
  it("reproduz o exemplo do artigo de Glickman (1500/200/0,06 contra três adversários)", () => {
    const r = glicko2Update({ mmr: 1500, rd: 200, vol: 0.06 }, [
      { opponent: { mmr: 1400, rd: 30, vol: 0.06 }, score: 1 },
      { opponent: { mmr: 1550, rd: 100, vol: 0.06 }, score: 0 },
      { opponent: { mmr: 1700, rd: 300, vol: 0.06 }, score: 0 },
    ]);
    expect(r.mmr).toBeCloseTo(1464.06, 1);
    expect(r.rd).toBeCloseTo(151.52, 1);
    expect(r.vol).toBeCloseTo(0.05999, 4);
  });

  it("vencer sobe, perder desce, e a incerteza diminui com partidas", () => {
    const a = defaultRating();
    const win = glicko2Update(a, [{ opponent: defaultRating(), score: 1 }]);
    const loss = glicko2Update(a, [{ opponent: defaultRating(), score: 0 }]);
    expect(win.mmr).toBeGreaterThan(1500);
    expect(loss.mmr).toBeLessThan(1500);
    expect(win.mmr - 1500).toBeCloseTo(1500 - loss.mmr, 6);
    expect(win.rd).toBeLessThan(a.rd);
  });

  it("vencer um adversário mais forte vale mais do que vencer um mais fraco", () => {
    const me = { mmr: 1500, rd: 80, vol: 0.06 };
    const strong = glicko2Update(me, [{ opponent: { mmr: 1800, rd: 80, vol: 0.06 }, score: 1 }]);
    const weak = glicko2Update(me, [{ opponent: { mmr: 1200, rd: 80, vol: 0.06 }, score: 1 }]);
    expect(strong.mmr - 1500).toBeGreaterThan((weak.mmr - 1500) * 3);
  });

  it("sem partidas a incerteza cresce; o desvio respeita os limites", () => {
    const idle = glicko2Update({ mmr: 1700, rd: 60, vol: 0.06 }, []);
    expect(idle.mmr).toBe(1700);
    expect(idle.rd).toBeGreaterThan(60);
    let r = defaultRating();
    for (let i = 0; i < 200; i++) r = glicko2Update(r, [{ opponent: { mmr: r.mmr, rd: 50, vol: 0.06 }, score: i % 2 }]);
    expect(r.rd).toBeGreaterThanOrEqual(GLICKO.minRd);
    expect(Number.isFinite(r.mmr) && Number.isFinite(r.vol)).toBe(true);
  });

  it("probabilidade de vitória e adversário composto da equipe", () => {
    expect(winProbability(defaultRating(), defaultRating())).toBeCloseTo(0.5, 6);
    expect(winProbability({ mmr: 1800, rd: 50, vol: 0.06 }, { mmr: 1500, rd: 50, vol: 0.06 })).toBeGreaterThan(0.8);
    const t = teamRating([{ mmr: 1400, rd: 100, vol: 0.06 }, { mmr: 1600, rd: 200, vol: 0.06 }]);
    expect(t.mmr).toBe(1500);
    expect(t.rd).toBeCloseTo(Math.sqrt((100 ** 2 + 200 ** 2) / 2), 6);
  });
});

describe("Pontos de Patente", () => {
  const base = { points: 500, mmrAfter: 0, placementLeft: 0, winStreak: 0, mvp: false, teammateAbandoned: false };
  const mmrAt = (points: number) => RANKED_RULES.mmrFloor + (points / RANKS.at(-1)!.minPoints) * (RANKED_RULES.mmrCeil - RANKED_RULES.mmrFloor);

  it("vitória soma, derrota tira, empate não muda", () => {
    const mmr = mmrAt(500);
    expect(applyRankedResult({ ...base, mmrAfter: mmr, outcome: "WIN" }).delta).toBe(RANKED_RULES.baseWin);
    expect(applyRankedResult({ ...base, mmrAfter: mmr, outcome: "LOSS" }).delta).toBe(-RANKED_RULES.baseLoss);
    expect(applyRankedResult({ ...base, mmrAfter: mmr, outcome: "DRAW" }).delta).toBe(0);
  });

  it("os PP convergem para o MMR: MMR alto ganha mais e perde menos", () => {
    const high = mmrAt(500) + 400;
    const low = mmrAt(500) - 400;
    const winHigh = applyRankedResult({ ...base, mmrAfter: high, outcome: "WIN" }).delta;
    const winLow = applyRankedResult({ ...base, mmrAfter: low, outcome: "WIN" }).delta;
    const lossHigh = applyRankedResult({ ...base, mmrAfter: high, outcome: "LOSS" }).delta;
    const lossLow = applyRankedResult({ ...base, mmrAfter: low, outcome: "LOSS" }).delta;
    expect(winHigh).toBe(RANKED_RULES.baseWin + RANKED_RULES.maxConvergence);
    expect(winLow).toBe(RANKED_RULES.baseWin - RANKED_RULES.maxConvergence);
    expect(lossHigh).toBe(-(RANKED_RULES.baseLoss - RANKED_RULES.maxConvergence));
    expect(lossLow).toBe(-(RANKED_RULES.baseLoss + RANKED_RULES.maxConvergence));
    expect(winLow).toBeGreaterThan(0);
  });

  it("sequência de vitórias dá bônus a partir da 3ª, com teto; derrota zera", () => {
    const mmr = mmrAt(500);
    const third = applyRankedResult({ ...base, mmrAfter: mmr, outcome: "WIN", winStreak: 2 });
    expect(third.delta).toBe(RANKED_RULES.baseWin + RANKED_RULES.streakBonus);
    expect(third.winStreak).toBe(3);
    const tenth = applyRankedResult({ ...base, mmrAfter: mmr, outcome: "WIN", winStreak: 9 });
    expect(tenth.delta).toBe(RANKED_RULES.baseWin + RANKED_RULES.maxStreakBonus);
    expect(applyRankedResult({ ...base, mmrAfter: mmr, outcome: "LOSS", winStreak: 9 }).winStreak).toBe(0);
  });

  it("MVP ganha um bônus pequeno; nunca fica negativo", () => {
    const mmr = mmrAt(500);
    expect(applyRankedResult({ ...base, mmrAfter: mmr, outcome: "WIN", mvp: true }).delta).toBe(RANKED_RULES.baseWin + RANKED_RULES.mvpBonus);
    const zero = applyRankedResult({ ...base, points: 5, mmrAfter: mmrAt(5), outcome: "LOSS" });
    expect(zero.points).toBe(0);
    expect(zero.delta).toBe(-5);
  });

  it("classificação: ganhos dobrados, derrota não tira, e ao terminar a patente vem do MMR (com teto)", () => {
    const w = applyRankedResult({ ...base, points: 0, mmrAfter: 1500, placementLeft: 5, outcome: "WIN" });
    expect(w.delta).toBeGreaterThanOrEqual(RANKED_RULES.baseWin * 2);
    expect(w.placementLeft).toBe(4);
    expect(w.placed).toBe(false);
    const l = applyRankedResult({ ...base, points: 40, mmrAfter: 1500, placementLeft: 3, outcome: "LOSS" });
    expect(l.delta).toBe(0);
    const last = applyRankedResult({ ...base, points: 100, mmrAfter: 1600, placementLeft: 1, outcome: "LOSS" });
    expect(last.placed).toBe(true);
    expect(last.points).toBe(pointsForMmr(1600));
    const prodigy = applyRankedResult({ ...base, points: 100, mmrAfter: 2600, placementLeft: 1, outcome: "WIN" });
    expect(rankForPoints(prodigy.points).order).toBe(RANKED_RULES.placementCapOrder);
  });

  it("abandono: penalidade fixa mesmo na classificação; aliados de quem abandonou perdem menos", () => {
    const mmr = mmrAt(500);
    expect(applyRankedResult({ ...base, mmrAfter: mmr, outcome: "ABANDONED" }).delta).toBe(-RANKED_RULES.abandonPenalty);
    expect(applyRankedResult({ ...base, points: 100, mmrAfter: 1500, placementLeft: 4, outcome: "ABANDONED" }).delta).toBe(-RANKED_RULES.abandonPenalty);
    expect(applyRankedResult({ ...base, mmrAfter: mmr, outcome: "LOSS", teammateAbandoned: true }).delta).toBe(-RANKED_RULES.baseLoss / 2);
    expect(abandonCooldownMinutes(0)).toBe(0);
    expect(abandonCooldownMinutes(1)).toBe(5);
    expect(abandonCooldownMinutes(2)).toBe(15);
    expect(abandonCooldownMinutes(7)).toBe(60);
  });

  it("pointsForMmr é monotônico e limitado", () => {
    expect(pointsForMmr(0)).toBe(0);
    expect(pointsForMmr(9999)).toBe(RANKS.at(-1)!.minPoints);
    expect(pointsForMmr(1700)).toBeGreaterThan(pointsForMmr(1500));
  });
});

describe("Matchmaking", () => {
  it("a janela de MMR cresce com a espera, até o teto", () => {
    expect(mmrWindow(0)).toBe(100);
    expect(mmrWindow(10_000)).toBe(350);
    expect(mmrWindow(10 * 60_000)).toBe(800);
  });

  it("junta quem tem MMR parecido e não puxa quem acabou de entrar para longe", () => {
    const q = [
      { id: "a", mmr: 1500, waitedMs: 0 },
      { id: "b", mmr: 1900, waitedMs: 0 },
    ];
    expect(pickMatchGroup(q, 2)).toBeNull();
    // Mesmo que "a" espere muito, "b" acabou de chegar e só aceita 100 de diferença.
    expect(pickMatchGroup([{ ...q[0]!, waitedMs: 60_000 }, q[1]!], 2)).toBeNull();
    // Com os dois esperando, a janela abre.
    expect(pickMatchGroup(q.map((c) => ({ ...c, waitedMs: 15_000 })), 2)?.map((c) => c.id).sort()).toEqual(["a", "b"]);
    const close = pickMatchGroup([...q, { id: "c", mmr: 1540, waitedMs: 0 }], 2);
    expect(close?.map((c) => c.id).sort()).toEqual(["a", "c"]);
  });

  it("entre grupos possíveis, atende primeiro quem espera há mais tempo", () => {
    const g = pickMatchGroup(
      [
        { id: "novo1", mmr: 1500, waitedMs: 1000 },
        { id: "novo2", mmr: 1510, waitedMs: 1000 },
        { id: "velho1", mmr: 1700, waitedMs: 30_000 },
        { id: "velho2", mmr: 1720, waitedMs: 20_000 },
      ],
      2,
    );
    expect(g?.map((c) => c.id).sort()).toEqual(["velho1", "velho2"]);
  });

  it("balanceia as equipes pela soma de MMR", () => {
    const players = [2000, 1900, 1500, 1450, 1400, 1350].map((mmr, i) => ({ id: `p${i}`, mmr }));
    const [a, b] = balanceTeams(players);
    expect(a.length).toBe(3);
    expect(b.length).toBe(3);
    const sum = (t: typeof a) => t.reduce((s, p) => s + p.mmr, 0);
    expect(Math.abs(sum(a) - sum(b))).toBeLessThanOrEqual(100);
    // Os dois mais fortes não ficam juntos.
    expect(a.some((p) => p.id === "p0") && a.some((p) => p.id === "p1")).toBe(false);
    const [x, y] = balanceTeams([{ mmr: 1500 }, { mmr: 1600 }]);
    expect(x.length + y.length).toBe(2);
    expect(() => balanceTeams([{ mmr: 1 }, { mmr: 2 }, { mmr: 3 }])).toThrow();
  });
});

describe("Temporadas", () => {
  it("reinício parcial: mantém parte dos PP, aproxima o MMR de 1500 e reabre a classificação", () => {
    const r = seasonSoftReset({ points: 1001, mmr: 1900, rd: 60, vol: 0.06 }, 0.5);
    expect(r.points).toBe(500);
    expect(r.mmr).toBe(1800);
    expect(r.rd).toBe(200);
    expect(r.placementLeft).toBe(RANKED_RULES.placementMatches);
    expect(seasonSoftReset({ points: 100, mmr: 1200, rd: 300, vol: 0.06 }, 2).points).toBe(100);
  });
});
