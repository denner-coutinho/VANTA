import { describe, expect, it } from "vitest";
import { CHARACTER_SKINS, COSMETIC_PRICE_VC, SEASON_REWARD_VC, WEAPON_SKINS, characterSkinMaterialSchema, priceFor, weaponSkinMaterialSchema } from "./cosmetics.js";
import { WEAPON_CATALOG } from "./game/weapon-catalog.js";
import { RANKS } from "./ranks.js";

const OPERATORS = ["RAVEN", "GHOST", "NOVA", "TITAN", "ZERO", "VIPER", "ECHO", "ORION"];

describe("cosméticos", () => {
  it("todas as skins têm material válido e código único", () => {
    for (const s of WEAPON_SKINS) expect(weaponSkinMaterialSchema.safeParse(s.material).success, s.code).toBe(true);
    for (const s of CHARACTER_SKINS) expect(characterSkinMaterialSchema.safeParse(s.material).success, s.code).toBe(true);
    const codes = [...WEAPON_SKINS, ...CHARACTER_SKINS].map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("cada skin aponta para uma arma ou operador que existe; todo operador tem pelo menos uma skin", () => {
    const weapons = new Set(WEAPON_CATALOG.map((w) => w.code));
    for (const s of WEAPON_SKINS) expect(weapons.has(s.weapon), s.code).toBe(true);
    for (const s of CHARACTER_SKINS) expect(OPERATORS).toContain(s.character);
    for (const op of OPERATORS) expect(CHARACTER_SKINS.some((s) => s.character === op), op).toBe(true);
  });

  it("preço cresce com a raridade e itens sazonais não são vendidos", () => {
    expect(COSMETIC_PRICE_VC.COMMON).toBeLessThan(COSMETIC_PRICE_VC.RARE);
    expect(COSMETIC_PRICE_VC.RARE).toBeLessThan(COSMETIC_PRICE_VC.EPIC);
    expect(COSMETIC_PRICE_VC.EPIC).toBeLessThan(COSMETIC_PRICE_VC.LEGENDARY);
    expect(priceFor("SEASONAL")).toBeNull();
  });

  it("recompensa de temporada existe para todos os tiers e cresce com eles", () => {
    const tiers = [...new Set(RANKS.map((r) => r.tier))];
    const values = tiers.map((t) => SEASON_REWARD_VC[t]);
    expect(values.every((v) => v > 0)).toBe(true);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });
});
