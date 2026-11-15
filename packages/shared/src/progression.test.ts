import { describe, expect, it } from "vitest";
import { computeMedals, levelFromTotalXp, matchXp, objectiveDelta, periodEndsAt, periodKey, type MedalPlayer } from "./progression.js";

const P = (id: string, team: 0 | 1, over: Partial<MedalPlayer> = {}): MedalPlayer => ({ id, team, kills: 0, deaths: 0, headshots: 0, shots: 0, hits: 0, mvp: false, abandoned: false, ...over });
const kill = (round: number, a: string, t: string, teamKill = false) => ({ round, type: "kill", actorId: a, targetId: t, data: teamKill ? { teamKill: true } : {} });
const end = (round: number, winner: 0 | 1 | null) => ({ round, type: "round_end", data: { winner } });

describe("progressão", () => {
  it("XP por partida: vitória, abates, MVP, teto e abandono", () => {
    expect(matchXp({ kills: 0, assists: 0, headshots: 0, mvp: false }, "LOSS")).toBe(100);
    expect(matchXp({ kills: 5, assists: 2, headshots: 3, mvp: true }, "WIN")).toBe(100 + 150 + 100 + 20 + 15 + 100);
    expect(matchXp({ kills: 500, assists: 0, headshots: 0, mvp: false }, "WIN")).toBe(1500);
    expect(matchXp({ kills: 9, assists: 0, headshots: 0, mvp: true }, "ABANDONED")).toBe(0);
    expect(levelFromTotalXp(500).level).toBe(2);
  });

  it("medalhas: ace, sangue frio, abertura, caçador de cabeças, precisão, impecável; aliado abatido não conta", () => {
    const players = [P("a", 0, { kills: 6, headshots: 5, shots: 30, hits: 15, mvp: true }), P("b", 0, { deaths: 3 }), P("x", 1, { deaths: 3 }), P("y", 1, { deaths: 3, kills: 3 })];
    const events = [
      // Round 1: a abre e faz ace (2 inimigos).
      kill(1, "a", "x"), kill(1, "a", "y"), end(1, 0),
      // Round 2: b morre, a fica sozinho contra 2 e vence (sangue frio + abertura do y não conta para a).
      kill(2, "y", "b"), kill(2, "a", "x"), kill(2, "a", "y"), end(2, 0),
      // Round 3: a abre de novo.
      kill(3, "a", "x"), kill(3, "y", "b"), kill(3, "a", "y"), end(3, 0),
      // Round 4: abate de aliado não abre o round.
      kill(4, "b", "b", true), end(4, 1),
    ];
    const m = computeMedals(players, events, 0);
    expect(new Set(m.get("a"))).toEqual(new Set(["MVP", "ACE", "CLUTCH", "HEADHUNTER", "PRECISION", "FLAWLESS"]));
    expect(m.get("b")).toEqual([]);
    expect(m.get("y")).toEqual([]);
    // Abertura exige 3 rounds abertos; impecável exige vencer sem morrer.
    const m2 = computeMedals([P("a", 0, { kills: 3 }), P("x", 1, { deaths: 3 })], [kill(1, "a", "x"), end(1, 0), kill(2, "a", "x"), end(2, 0), kill(3, "a", "x"), end(3, 0)], 0);
    expect(new Set(m2.get("a"))).toEqual(new Set(["OPENER", "FLAWLESS"]));
    // Quem abandonou não ganha medalha.
    expect(computeMedals([P("a", 0, { abandoned: true, mvp: true })], [], 0).get("a")).toEqual([]);
  });

  it("janelas das missões viram à meia-noite de Brasília; semana começa na segunda", () => {
    // 2026-11-16 02:30 UTC = 15/11 23:30 em Brasília (domingo).
    expect(periodKey("DAILY", new Date("2026-11-16T02:30:00Z"))).toBe("2026-11-15");
    expect(periodKey("DAILY", new Date("2026-11-16T03:00:00Z"))).toBe("2026-11-16");
    expect(periodKey("WEEKLY", new Date("2026-11-16T02:30:00Z"))).toBe("W-2026-11-09");
    expect(periodKey("WEEKLY", new Date("2026-11-16T03:00:00Z"))).toBe("W-2026-11-16");
    expect(periodEndsAt("DAILY", new Date("2026-11-16T02:30:00Z")).toISOString()).toBe("2026-11-16T03:00:00.000Z");
    expect(periodEndsAt("WEEKLY", new Date("2026-11-16T03:00:00Z")).toISOString()).toBe("2026-11-23T03:00:00.000Z");
  });

  it("objetivos contam o que a partida fez", () => {
    const m = { won: true, kills: 4, assists: 1, headshots: 2, mvp: false, medals: ["ACE"] };
    expect(objectiveDelta({ stat: "kills", target: 10 }, m)).toBe(4);
    expect(objectiveDelta({ stat: "wins", target: 1 }, m)).toBe(1);
    expect(objectiveDelta({ stat: "medal:ACE", target: 1 }, m)).toBe(1);
    expect(objectiveDelta({ stat: "medals", target: 3 }, m)).toBe(1);
  });
});
