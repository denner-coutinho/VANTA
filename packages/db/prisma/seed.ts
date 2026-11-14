import { PrismaClient } from "@prisma/client";
import { RANKS } from "@vanta/shared";
import { ACHIEVEMENTS, CHARACTERS, COIN_PACKAGES, MAPS, MISSIONS, WEAPONS } from "./seed-data.js";

const prisma = new PrismaClient();

async function main() {
  for (const r of RANKS) {
    const data = { order: r.order, code: r.code, name: r.name, tier: r.tier, division: r.division, minPoints: r.minPoints, color: r.color, glow: r.glow };
    await prisma.rank.upsert({ where: { code: r.code }, update: data, create: data });
  }

  for (const p of COIN_PACKAGES) {
    await prisma.coinPackage.upsert({ where: { code: p.code }, update: {}, create: { ...p, currency: "BRL" } });
  }

  for (const [i, c] of CHARACTERS.entries()) {
    const data = { ...c, modelKey: `operator_${c.code.toLowerCase()}`, isDefault: i === 0, sortOrder: i };
    await prisma.character.upsert({ where: { code: c.code }, update: data, create: data });
  }

  for (const [i, w] of WEAPONS.entries()) {
    const data = { ...w, modelKey: `weapon_${w.code.toLowerCase()}`, soundKey: `sfx_${w.category.toLowerCase()}`, sortOrder: i };
    await prisma.weapon.upsert({ where: { code: w.code }, update: data, create: data });
  }

  for (const [i, m] of MAPS.entries()) {
    const data = { ...m, sceneKey: m.code.toLowerCase(), sortOrder: i };
    await prisma.gameMap.upsert({ where: { code: m.code }, update: data, create: data });
  }

  for (const m of MISSIONS) {
    await prisma.mission.upsert({ where: { code: m.code }, update: {}, create: m });
  }
  for (const a of ACHIEVEMENTS) {
    await prisma.achievement.upsert({ where: { code: a.code }, update: {}, create: a });
  }

  // Temporada 1. Em produção ela nasce inativa e um administrador a inicia no lançamento
  // (POST /admin/ranked/seasons/start). Fora de produção já começa ativa, para o ranqueado funcionar no dev.
  const dev = process.env.NODE_ENV !== "production";
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + 90 * 24 * 3600 * 1000);
  const existing = await prisma.rankedSeason.findUnique({ where: { number: 1 } });
  if (!existing) {
    await prisma.rankedSeason.create({ data: { number: 1, name: "Temporada 1 — Ignição", startsAt, endsAt, isActive: dev } });
  } else if (dev && !existing.isActive && !existing.closedAt && !(await prisma.rankedSeason.findFirst({ where: { isActive: true } }))) {
    await prisma.rankedSeason.update({ where: { id: existing.id }, data: { isActive: true, startsAt, endsAt } });
  }

  const counts = {
    ranks: await prisma.rank.count(),
    coinPackages: await prisma.coinPackage.count(),
    characters: await prisma.character.count(),
    weapons: await prisma.weapon.count(),
    maps: await prisma.gameMap.count(),
    missions: await prisma.mission.count(),
    achievements: await prisma.achievement.count(),
  };
  console.log("Seed concluído:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
