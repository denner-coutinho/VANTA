import { describe, expect, it } from "vitest";
import { ROOM_CODE_ALPHABET, defaultRoomSettings, makeRoomCode, normalizeRoomCode, roomMaxPlayers, roomSettingsSchema } from "./rooms.js";

describe("salas", () => {
  it("código curto sem caracteres ambíguos e normalização do que o jogador digita", () => {
    for (let i = 0; i < 200; i++) {
      const c = makeRoomCode();
      expect(c).toHaveLength(6);
      for (const ch of c) expect(ROOM_CODE_ALPHABET).toContain(ch);
      expect(c).not.toMatch(/[01OIL]/);
    }
    expect(normalizeRoomCode(" ab-c 23x ")).toBe("ABC23X");
  });

  it("regras válidas e inválidas", () => {
    const s = defaultRoomSettings("Raven");
    expect(roomSettingsSchema.parse(s)).toEqual(s);
    expect(roomSettingsSchema.safeParse({ ...s, map: "NAO_EXISTE" }).success).toBe(false);
    expect(roomSettingsSchema.safeParse({ ...s, weapons: [] }).success).toBe(false);
    expect(roomSettingsSchema.safeParse({ ...s, roundsToWin: 0 }).success).toBe(false);
    expect(roomSettingsSchema.safeParse({ ...s, roundTimeSec: 10 }).success).toBe(false);
    expect(roomSettingsSchema.safeParse({ ...s, name: "ab" }).success).toBe(false);
    expect(roomMaxPlayers("3v3")).toBe(6);
  });
});
