import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RANKS } from "@vanta/shared";
import { closeTestContext, createTestContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => closeTestContext(ctx));

describe("conteúdo do jogo (seed)", () => {
  it("tem as 15 patentes iguais às definições compartilhadas", async () => {
    const ranks = (await ctx.app.inject({ method: "GET", url: "/content/ranks" })).json();
    expect(ranks).toHaveLength(15);
    expect(ranks.map((r: { code: string }) => r.code)).toEqual(RANKS.map((r) => r.code));
  });
  it("tem 8 personagens, 10 armas das 5 categorias e 5 mapas", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/content/characters" })).json()).toHaveLength(8);
    const weapons = (await ctx.app.inject({ method: "GET", url: "/content/weapons" })).json();
    expect(weapons).toHaveLength(10);
    expect(new Set(weapons.map((w: { category: string }) => w.category)).size).toBe(5);
    expect((await ctx.app.inject({ method: "GET", url: "/content/maps" })).json()).toHaveLength(5);
  });
  it("pacotes de VC seguem a tabela sugerida", async () => {
    const pkgs = await ctx.prisma.coinPackage.findMany({ orderBy: { sortOrder: "asc" } });
    expect(pkgs.map((p) => [p.coins, p.priceCents])).toEqual([[500, 990], [1200, 1990], [2800, 3990], [6000, 7990], [13000, 14990]]);
  });
  it("nenhuma arma tem TTK no corpo absurdamente menor que as outras da mesma categoria", async () => {
    const weapons = await ctx.prisma.weapon.findMany();
    const ttk = (w: (typeof weapons)[number]) => (Math.ceil(100 / (w.damage * w.pelletsPerShot)) - 1) * (60000 / w.fireRateRpm);
    for (const cat of ["ASSAULT_RIFLE", "SMG", "PISTOL"]) {
      const v = weapons.filter((w) => w.category === cat).map(ttk);
      expect(Math.max(...v) / Math.max(1, Math.min(...v))).toBeLessThan(2.5);
    }
  });
});

describe("integridade do banco", () => {
  it("o razão de carteira é somente-inserção e o saldo não fica negativo", async () => {
    const user = await ctx.prisma.user.create({
      data: { username: "Integridade", usernameLower: "integridade", email: "integ@teste.vanta", passwordHash: "x", birthDate: new Date("2000-01-01"), termsAcceptedAt: new Date(), wallet: { create: {} } },
    });
    await expect(ctx.prisma.wallet.update({ where: { userId: user.id }, data: { balance: -1 } })).rejects.toThrow();
    const tx = await ctx.prisma.walletTransaction.create({
      data: { walletUserId: user.id, type: "ADMIN_ADJUSTMENT", amount: 10, balanceAfter: 10, idempotencyKey: `test:${user.id}`, description: "teste" },
    });
    await expect(ctx.prisma.walletTransaction.update({ where: { id: tx.id }, data: { amount: 99999 } })).rejects.toThrow(/somente-inserção/);
    await expect(ctx.prisma.walletTransaction.delete({ where: { id: tx.id } })).rejects.toThrow(/somente-inserção/);
    await expect(
      ctx.prisma.walletTransaction.create({ data: { walletUserId: user.id, type: "ADMIN_ADJUSTMENT", amount: 10, balanceAfter: 20, idempotencyKey: `test:${user.id}`, description: "duplicado" } }),
    ).rejects.toThrow();
    await ctx.prisma.$executeRawUnsafe(`TRUNCATE "User","Wallet","WalletTransaction","UserProfile" CASCADE`);
  });
});
