import { describe, expect, it } from "vitest";
import { RANKS, rankForPoints, rankProgress } from "./ranks.js";
import { levelFromTotalXp } from "./progression.js";

describe("patentes", () => {
  it("possui exatamente 15 patentes em ordem crescente de pontos", () => {
    expect(RANKS).toHaveLength(15);
    expect(RANKS[0]!.name).toBe("Recruta I");
    expect(RANKS[14]!.name).toBe("VANTA Supremo");
    for (let i = 1; i < RANKS.length; i++) expect(RANKS[i]!.minPoints).toBeGreaterThan(RANKS[i - 1]!.minPoints);
    expect(new Set(RANKS.map((r) => r.code)).size).toBe(15);
  });
  it("resolve a patente pelos pontos", () => {
    expect(rankForPoints(0).order).toBe(1);
    expect(rankForPoints(RANKS[5]!.minPoints).order).toBe(6);
    expect(rankForPoints(RANKS[5]!.minPoints - 1).order).toBe(5);
    expect(rankForPoints(999999).order).toBe(15);
  });
  it("calcula progresso dentro da patente", () => {
    expect(rankProgress(50).progress).toBeCloseTo(0.5);
    expect(rankProgress(999999).next).toBeNull();
  });
});

describe("níveis", () => {
  it("converte XP total em nível", () => {
    expect(levelFromTotalXp(0)).toEqual({ level: 1, xpIntoLevel: 0, xpForNext: 500 });
    expect(levelFromTotalXp(500).level).toBe(2);
    expect(levelFromTotalXp(500 + 650 + 10)).toEqual({ level: 3, xpIntoLevel: 10, xpForNext: 800 });
  });
});
