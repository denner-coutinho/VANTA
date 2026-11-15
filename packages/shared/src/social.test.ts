import { describe, expect, it } from "vitest";
import { packParties, sanitizeChat, CHAT_MAX_LEN } from "./social.js";

const filled = (sizes: number[], r: [number[], number[]] | null, teamSize: number) => {
  expect(r).not.toBeNull();
  const [a, b] = r!;
  expect(a.reduce((s, i) => s + sizes[i]!, 0)).toBe(teamSize);
  expect(b.reduce((s, i) => s + sizes[i]!, 0)).toBe(teamSize);
  expect(new Set([...a, ...b]).size).toBe(a.length + b.length);
};

describe("packParties (fila com grupos)", () => {
  it("solo: os primeiros a chegar formam a partida", () => {
    expect(packParties([1, 1, 1, 1, 1], 2)).toEqual([[0, 1], [2, 3]]);
  });
  it("nunca separa um grupo e pula quem não cabe", () => {
    const sizes = [2, 3, 1, 1, 2];
    const r = packParties(sizes, 3);
    filled(sizes, r, 3);
    expect(r![0]).toContain(0); // o primeiro a chegar sempre entra quando dá
  });
  it("grupo de 3 contra 3 solos", () => {
    const sizes = [3, 1, 1, 1];
    expect(packParties(sizes, 3)).toEqual([[0], [1, 2, 3]]);
  });
  it("não fecha quando faltam jogadores ou os grupos não encaixam", () => {
    expect(packParties([2, 2, 1], 2)).toEqual([[0], [1]]);
    expect(packParties([3, 3], 2)).toBeNull();
    expect(packParties([2, 1], 2)).toBeNull();
    expect(packParties([], 1)).toBeNull();
  });
  it("fila longa sem solução termina rápido (memoização)", () => {
    const sizes = Array.from({ length: 400 }, () => 2);
    const t = performance.now();
    expect(packParties(sizes, 3)).toBeNull();
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("sanitizeChat", () => {
  it("remove controles e caracteres invisíveis, junta espaços e limita o tamanho", () => {
    expect(sanitizeChat("  oi\u0000 \n\t pessoal‮  ")).toBe("oi pessoal");
    expect(sanitizeChat("a".repeat(500))).toHaveLength(CHAT_MAX_LEN);
    expect(sanitizeChat("<b>gg</b>")).toBe("<b>gg</b>"); // HTML não é interpretado: o cliente mostra como texto
  });
});
