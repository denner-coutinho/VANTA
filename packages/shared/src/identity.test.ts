import { describe, expect, it } from "vitest";
import { canManage, cardStyle, clanPointsDelta, clanTagSchema, createClanSchema, parseClanLogo, updateCardSchema } from "./identity.js";

describe("identidade e clãs", () => {
  it("tag vira maiúscula e só aceita 2 a 5 letras ou números", () => {
    expect(clanTagSchema.parse(" vnt ")).toBe("VNT");
    expect(() => clanTagSchema.parse("A")).toThrow();
    expect(() => clanTagSchema.parse("ABCDEF")).toThrow();
    expect(() => clanTagSchema.parse("A-B")).toThrow();
  });

  it("nome, logo e padrões do clã", () => {
    const c = createClanSchema.parse({ name: "Esquadrão Neon", tag: "neo" });
    expect(c).toMatchObject({ tag: "NEO", logoKey: "shield:blue", isOpen: true });
    expect(() => createClanSchema.parse({ name: "ab", tag: "AB" })).toThrow();
    expect(() => createClanSchema.parse({ name: "Clã <script>", tag: "AB" })).toThrow();
    expect(() => createClanSchema.parse({ name: "Bom nome", tag: "AB", logoKey: "skull:blue" })).toThrow();
    expect(parseClanLogo("hex:red")).toEqual({ shape: "hex", color: "#FF3B6B" });
    expect(parseClanLogo("lixo")).toEqual({ shape: "shield", color: "#287BFF" });
  });

  it("hierarquia: líder manda em todos, oficial só em membro, membro em ninguém", () => {
    expect(canManage("LEADER", "OFFICER")).toBe(true);
    expect(canManage("LEADER", "LEADER")).toBe(false);
    expect(canManage("OFFICER", "MEMBER")).toBe(true);
    expect(canManage("OFFICER", "OFFICER")).toBe(false);
    expect(canManage("MEMBER", "MEMBER")).toBe(false);
  });

  it("pontos de clã e cartões por nível", () => {
    expect([clanPointsDelta("WIN"), clanPointsDelta("LOSS"), clanPointsDelta("DRAW"), clanPointsDelta("ABANDON")]).toEqual([20, -15, 0, -15]);
    expect(cardStyle("nada").key).toBe("default");
    expect(() => updateCardSchema.parse({ playerCardKey: "inexistente", avatarKey: "default" })).toThrow();
    expect(updateCardSchema.parse({ playerCardKey: "circuit", avatarKey: "red" })).toEqual({ playerCardKey: "circuit", avatarKey: "red" });
  });
});
