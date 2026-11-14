import type { FastifyInstance } from "fastify";

/** Conteúdo público do jogo (catálogo). Leitura apenas; alterações só pelo painel admin. */
export async function contentRoutes(app: FastifyInstance) {

  app.get("/content/ranks", async () => app.prisma.rank.findMany({ orderBy: { order: "asc" }, omit: { rewardStoreItemId: true } }));

  app.get("/content/characters", async () =>
    app.prisma.character.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, code: true, name: true, role: true, lore: true, personality: true, primaryColor: true, modelKey: true },
    }),
  );

  app.get("/content/weapons", async () => app.prisma.weapon.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }));

  app.get("/content/maps", async () =>
    app.prisma.gameMap.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" }, select: { id: true, code: true, name: true, description: true, supportedModes: true } }),
  );

  app.get("/content/events/active", async () => {
    const now = new Date();
    return app.prisma.gameEvent.findMany({
      where: { isPublished: true, startsAt: { lte: now }, endsAt: { gt: now } },
      orderBy: { endsAt: "asc" },
      select: { id: true, name: true, description: true, startsAt: true, endsAt: true },
    });
  });

  app.get("/content/season", async () => app.prisma.rankedSeason.findFirst({ where: { isActive: true }, select: { id: true, number: true, name: true, startsAt: true, endsAt: true } }));
}
