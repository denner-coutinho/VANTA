import type { Prisma, PrismaClient } from "@vanta/db";
import type { CharacterSkinMaterial, StoreItemView, WeaponSkinMaterial } from "@vanta/shared";
import { Errors } from "../../lib/errors.js";
import { postLedger } from "./wallet.js";

type Tx = Prisma.TransactionClient | PrismaClient;

export const STORE_ITEM_INCLUDE = {
  weaponSkin: { select: { material: true, weapon: { select: { code: true, name: true } } } },
  characterSkin: { select: { material: true, character: { select: { code: true, name: true } } } },
} satisfies Prisma.StoreItemInclude;

type ItemRow = Prisma.StoreItemGetPayload<{ include: typeof STORE_ITEM_INCLUDE }>;
type InvRow = { equipped: boolean; acquiredAt: Date; source: StoreItemView["source"] } | undefined;

export function toItemView(i: ItemRow, inv: InvRow): StoreItemView {
  const target = i.weaponSkin
    ? { kind: "weapon" as const, code: i.weaponSkin.weapon.code, name: i.weaponSkin.weapon.name }
    : i.characterSkin
      ? { kind: "character" as const, code: i.characterSkin.character.code, name: i.characterSkin.character.name }
      : null;
  return {
    id: i.id,
    code: i.code,
    type: i.type as StoreItemView["type"],
    name: i.name,
    description: i.description,
    rarity: i.rarity,
    priceVc: i.priceVc,
    owned: !!inv,
    equipped: inv?.equipped ?? false,
    target,
    material: ((i.weaponSkin?.material ?? i.characterSkin?.material) as Record<string, unknown> | undefined) ?? null,
    acquiredAt: inv?.acquiredAt.toISOString() ?? null,
    source: inv?.source ?? null,
  };
}

/** Item à venda agora (ativo, com preço e dentro da janela de disponibilidade). */
export function forSaleWhere(now = new Date()): Prisma.StoreItemWhereInput {
  return {
    isActive: true,
    priceVc: { not: null },
    type: { in: ["WEAPON_SKIN", "CHARACTER_SKIN"] },
    AND: [{ OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] }, { OR: [{ availableUntil: null }, { availableUntil: { gt: now } }] }],
  };
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

/**
 * Compra de item com VANTA COINS. O preço vem do banco, nunca do cliente.
 * Débito e entrega do item acontecem na mesma transação: ou os dois, ou nenhum.
 */
export async function purchaseItem(db: PrismaClient, userId: string, itemId: string) {
  try {
    return await db.$transaction(async (tx) => {
      const item = await tx.storeItem.findFirst({ where: { id: itemId, ...forSaleWhere() }, include: STORE_ITEM_INCLUDE });
      if (!item || item.priceVc === null) throw Errors.notFound("Item indisponível na loja.");
      if (await tx.inventory.findUnique({ where: { userId_storeItemId: { userId, storeItemId: item.id } } })) {
        throw Errors.conflict("ALREADY_OWNED", "Você já possui este item.");
      }
      const debit = await postLedger(tx, {
        userId,
        amount: -item.priceVc,
        type: "STORE_DEBIT",
        idempotencyKey: `store:${userId}:${item.id}`,
        description: `Compra: ${item.name}`,
        meta: { storeItemId: item.id, code: item.code, priceVc: item.priceVc },
      });
      if (!debit.applied) throw Errors.conflict("ALREADY_OWNED", "Você já possui este item.");
      const inv = await tx.inventory.create({ data: { userId, storeItemId: item.id, source: "PURCHASE", walletTxId: debit.transactionId } });
      return { balance: debit.balanceAfter, item: toItemView(item, inv) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw Errors.conflict("ALREADY_OWNED", "Você já possui este item.");
    throw e;
  }
}

/**
 * Equipa um item possuído. Uma skin por operador e uma por arma.
 * `equip=false` volta ao visual padrão daquele operador/arma.
 */
export async function setEquipped(db: PrismaClient, userId: string, itemId: string, equip: boolean) {
  return db.$transaction(async (tx) => {
    const inv = await tx.inventory.findUnique({ where: { userId_storeItemId: { userId, storeItemId: itemId } }, include: { storeItem: { include: STORE_ITEM_INCLUDE } } });
    if (!inv) throw Errors.notFound("Item não está no seu inventário.");
    const item = inv.storeItem;
    // Emblemas são troféus de coleção (aparecem no inventário); não há onde "vestir" um emblema ainda.
    if (item.type !== "WEAPON_SKIN" && item.type !== "CHARACTER_SKIN") throw Errors.badRequest("NOT_EQUIPPABLE", "Este item é de coleção e não pode ser equipado.");
    if (equip) {
      const sameSlot: Prisma.StoreItemWhereInput =
        item.type === "WEAPON_SKIN"
          ? { type: "WEAPON_SKIN", weaponSkin: { weapon: { code: item.weaponSkin!.weapon.code } } }
          : { type: "CHARACTER_SKIN", characterSkin: { character: { code: item.characterSkin!.character.code } } };
      await tx.inventory.updateMany({ where: { userId, equipped: true, storeItem: sameSlot }, data: { equipped: false } });
    }
    const updated = await tx.inventory.update({ where: { id: inv.id }, data: { equipped: equip } });
    return toItemView(item, updated);
  });
}

/** Entrega um item sem cobrança (recompensa). Idempotente: quem já tem, continua com um. */
export async function grantItem(tx: Tx, userId: string, storeItemId: string, source: "REWARD" | "SEASON_REWARD" | "EVENT" | "ADMIN_GRANT") {
  return tx.inventory.upsert({ where: { userId_storeItemId: { userId, storeItemId } }, update: {}, create: { userId, storeItemId, source } });
}

/** Materiais equipados, por operador e por arma (para o menu, o treino e as partidas). */
export async function equippedCosmetics(db: Tx, userId: string) {
  const rows = await db.inventory.findMany({ where: { userId, equipped: true, storeItem: { type: { in: ["WEAPON_SKIN", "CHARACTER_SKIN"] } } }, include: { storeItem: { include: STORE_ITEM_INCLUDE } } });
  const characters: Record<string, CharacterSkinMaterial> = {};
  const weapons: Record<string, WeaponSkinMaterial> = {};
  for (const r of rows) {
    const s = r.storeItem;
    if (s.characterSkin) characters[s.characterSkin.character.code] = s.characterSkin.material as CharacterSkinMaterial;
    if (s.weaponSkin) weapons[s.weaponSkin.weapon.code] = s.weaponSkin.material as WeaponSkinMaterial;
  }
  return { characters, weapons };
}
