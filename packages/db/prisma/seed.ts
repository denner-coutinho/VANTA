import { PrismaClient } from "@prisma/client";
import { CHARACTER_SKINS, RANKS, WEAPON_SKINS, priceFor, seasonEmblemCode } from "@vanta/shared";
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

  // Cosméticos (Fase 6): cada skin tem um StoreItem com preço por raridade. Só aparência.
  for (const w of WEAPON_SKINS) {
    const weapon = await prisma.weapon.findUniqueOrThrow({ where: { code: w.weapon } });
    const data = { weaponId: weapon.id, code: w.code, name: w.name, rarity: w.rarity, material: w.material };
    const skin = await prisma.weaponSkin.upsert({ where: { code: w.code }, update: data, create: data });
    const item = { type: "WEAPON_SKIN" as const, name: w.name, description: w.description, rarity: w.rarity, priceVc: priceFor(w.rarity), imageKey: w.code.toLowerCase() };
    await prisma.storeItem.upsert({ where: { code: w.code }, update: item, create: { ...item, code: w.code, weaponSkinId: skin.id } });
  }
  for (const c of CHARACTER_SKINS) {
    const character = await prisma.character.findUniqueOrThrow({ where: { code: c.character } });
    const data = { characterId: character.id, code: c.code, name: c.name, slot: "FULL_SUIT" as const, rarity: c.rarity, material: c.material };
    const skin = await prisma.characterSkin.upsert({ where: { code: c.code }, update: data, create: data });
    const item = { type: "CHARACTER_SKIN" as const, name: c.name, description: c.description, rarity: c.rarity, priceVc: priceFor(c.rarity), imageKey: c.code.toLowerCase() };
    await prisma.storeItem.upsert({ where: { code: c.code }, update: item, create: { ...item, code: c.code, characterSkinId: skin.id } });
  }

  for (const m of MISSIONS) {
    await prisma.mission.upsert({ where: { code: m.code }, update: {}, create: m });
  }
  for (const a of ACHIEVEMENTS) {
    await prisma.achievement.upsert({ where: { code: a.code }, update: {}, create: a });
  }

  // Temporada 1. Em produção ela nasce inativa e um administrador a inicia no lançamento
  // (POST /admin/ranked/seasons/start). Fora de produção, e na instalação local de teste
  // (SEED_ACTIVATE_SEASON=true), já começa ativa para o ranqueado funcionar.
  const dev = process.env.NODE_ENV !== "production" || process.env.SEED_ACTIVATE_SEASON === "true";
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + 90 * 24 * 3600 * 1000);
  const existing = await prisma.rankedSeason.findUnique({ where: { number: 1 } });
  if (!existing) {
    await prisma.rankedSeason.create({ data: { number: 1, name: "Temporada 1 — Ignição", startsAt, endsAt, isActive: dev } });
  } else if (dev && !existing.isActive && !existing.closedAt && !(await prisma.rankedSeason.findFirst({ where: { isActive: true } }))) {
    await prisma.rankedSeason.update({ where: { id: existing.id }, data: { isActive: true, startsAt, endsAt } });
  }

  const season1 = await prisma.rankedSeason.findUniqueOrThrow({ where: { number: 1 } });
  const emblem = { type: "EMBLEM" as const, name: "Emblema · Temporada 1", description: "Entregue a quem terminou a classificação na Temporada 1.", rarity: "SEASONAL" as const, priceVc: null, imageKey: "emblem_season_1", seasonId: season1.id };
  await prisma.storeItem.upsert({ where: { code: seasonEmblemCode(1) }, update: emblem, create: { ...emblem, code: seasonEmblemCode(1) } });

  const counts = {
    ranks: await prisma.rank.count(),
    coinPackages: await prisma.coinPackage.count(),
    storeItems: await prisma.storeItem.count(),
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
