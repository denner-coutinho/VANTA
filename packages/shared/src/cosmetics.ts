import { z } from "zod";
import type { RankTier } from "./ranks.js";

/**
 * Cosméticos de VANTA: FRONTLINE (Fase 6).
 *
 * Só aparência: nenhum item muda dano, recuo, velocidade, hitbox ou visibilidade.
 * Os materiais são cores e padrões interpretados pelo cliente sobre os modelos procedurais.
 * Este arquivo é a fonte da verdade para o seed (WeaponSkin, CharacterSkin, StoreItem).
 */

export type CosmeticRarity = "COMMON" | "RARE" | "EPIC" | "LEGENDARY" | "SEASONAL";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const weaponSkinMaterialSchema = z.object({
  /** Corpo metálico da arma. */
  body: hex,
  /** Polímero (coronha, empunhadura, guarda-mão). */
  polymer: hex,
  /** Acabamento (peças de cor própria do modelo). */
  trim: hex,
  /** Detalhe emissivo (mira, faixas de luz). */
  glow: hex,
  pattern: z.enum(["solid", "stripes", "camo", "hex", "circuit"]),
  /** Cor do desenho do padrão (sobre o polímero). */
  patternColor: hex.optional(),
  metalness: z.number().min(0).max(1).optional(),
});
export type WeaponSkinMaterial = z.infer<typeof weaponSkinMaterialSchema>;

export const characterSkinMaterialSchema = z.object({
  armor: hex,
  plate: hex,
  fabric: hex,
  trim: hex,
  /** Visor e luzes. */
  glow: hex,
});
export type CharacterSkinMaterial = z.infer<typeof characterSkinMaterialSchema>;

/** Preço em VANTA COINS por raridade. Itens sazonais não são vendidos. */
export const COSMETIC_PRICE_VC: Record<Exclude<CosmeticRarity, "SEASONAL">, number> = {
  COMMON: 300,
  RARE: 600,
  EPIC: 1200,
  LEGENDARY: 2000,
};

export const RARITY_LABEL: Record<CosmeticRarity, string> = {
  COMMON: "Comum",
  RARE: "Rara",
  EPIC: "Épica",
  LEGENDARY: "Lendária",
  SEASONAL: "Sazonal",
};

export const RARITY_COLOR: Record<CosmeticRarity, string> = {
  COMMON: "#9AA6BF",
  RARE: "#287BFF",
  EPIC: "#823BFF",
  LEGENDARY: "#FF9A2E",
  SEASONAL: "#FF2E63",
};

export interface WeaponSkinDef {
  code: string;
  weapon: string;
  name: string;
  rarity: Exclude<CosmeticRarity, "SEASONAL">;
  description: string;
  material: WeaponSkinMaterial;
}

export interface CharacterSkinDef {
  code: string;
  character: string;
  name: string;
  rarity: Exclude<CosmeticRarity, "SEASONAL">;
  description: string;
  material: CharacterSkinMaterial;
}

export const WEAPON_SKINS: readonly WeaponSkinDef[] = [
  { code: "WS_VK7_GELO", weapon: "VK7_LAMINA", name: "VK-7 Lâmina · Gelo Seco", rarity: "COMMON", description: "Acabamento fosco em cinza-azulado.", material: { body: "#3a4a5e", polymer: "#7d90a8", trim: "#c8d6e8", glow: "#8cd8ff", pattern: "solid" } },
  { code: "WS_VK7_CIRCUITO", weapon: "VK7_LAMINA", name: "VK-7 Lâmina · Circuito Vivo", rarity: "EPIC", description: "Trilhas de circuito gravadas no polímero.", material: { body: "#10151f", polymer: "#18243a", trim: "#2ED3E6", glow: "#2ED3E6", pattern: "circuit", patternColor: "#2ED3E6", metalness: 0.9 } },
  { code: "WS_ARX9_SAFARI", weapon: "ARX9_PULSAR", name: "ARX-9 Pulsar · Savana", rarity: "COMMON", description: "Camuflagem de areia e oliva.", material: { body: "#4a4232", polymer: "#a08a5a", trim: "#d9c38f", glow: "#ffb347", pattern: "camo", patternColor: "#5e5a3a" } },
  { code: "WS_ARX9_MAGMA", weapon: "ARX9_PULSAR", name: "ARX-9 Pulsar · Magma", rarity: "LEGENDARY", description: "Rocha vulcânica com veios incandescentes.", material: { body: "#1a1010", polymer: "#2a1612", trim: "#ff5a1f", glow: "#ff7a1f", pattern: "circuit", patternColor: "#ff4a10", metalness: 0.6 } },
  { code: "WS_SPX_VESPA_LISTRA", weapon: "SPX_VESPA", name: "SPX Vespa · Ferrão", rarity: "RARE", description: "Listras de alerta em preto e amarelo.", material: { body: "#151515", polymer: "#2a2a2a", trim: "#ffe14a", glow: "#ffe14a", pattern: "stripes", patternColor: "#ffe14a" } },
  { code: "WS_KR4_MUSGO", weapon: "KR4_FAGULHA", name: "KR-4 Fagulha · Musgo", rarity: "COMMON", description: "Verde de selva com relevo de colmeia.", material: { body: "#26322a", polymer: "#4a6450", trim: "#9fd4a8", glow: "#3fe08f", pattern: "hex", patternColor: "#33473a" } },
  { code: "WS_LR1_DUNA", weapon: "LR1_HORIZONTE", name: "LR-1 Horizonte · Duna", rarity: "RARE", description: "Areia do Desert Protocol em camuflagem digital.", material: { body: "#5a4a32", polymer: "#c9a86a", trim: "#f0dcae", glow: "#ffcf7a", pattern: "camo", patternColor: "#8a7048" } },
  { code: "WS_LR1_ORBITA", weapon: "LR1_HORIZONTE", name: "LR-1 Horizonte · Órbita", rarity: "LEGENDARY", description: "Branco de estação espacial com faixas de sinalização.", material: { body: "#d8dce4", polymer: "#eef1f6", trim: "#ff2e63", glow: "#ff2e63", pattern: "stripes", patternColor: "#ff2e63", metalness: 0.3 } },
  { code: "WS_MK2_NOITE", weapon: "MK2_AGULHA", name: "MK-2 Agulha · Meia-noite", rarity: "RARE", description: "Azul profundo com mira em violeta.", material: { body: "#0f1428", polymer: "#1c2448", trim: "#823BFF", glow: "#a070ff", pattern: "solid" } },
  { code: "WS_SG12_FERRUGEM", weapon: "SG12_TROVAO", name: "SG-12 Trovão · Ferrugem", rarity: "COMMON", description: "Aço envelhecido e madeira escura.", material: { body: "#5a3a26", polymer: "#3a2418", trim: "#c07a4a", glow: "#ff9a2e", pattern: "solid", metalness: 0.4 } },
  { code: "WS_HX3_ALERTA", weapon: "HX3_MARTELO", name: "HX-3 Martelo · Alerta Vermelho", rarity: "EPIC", description: "Vermelho de emergência com listras de perigo.", material: { body: "#2a0e12", polymer: "#7a1622", trim: "#ffd1d6", glow: "#ff3b4e", pattern: "stripes", patternColor: "#111111" } },
  { code: "WS_P9_NEON", weapon: "P9_FAISCA", name: "P-9 Faísca · Neon", rarity: "RARE", description: "Rosa e ciano das ruas do Neon District.", material: { body: "#1a1028", polymer: "#ff2e9a", trim: "#2ed3e6", glow: "#2ed3e6", pattern: "hex", patternColor: "#c01f78" } },
  { code: "WS_DX50_OURO", weapon: "DX50_JUIZA", name: "DX-50 Juíza · Veredito", rarity: "LEGENDARY", description: "Ouro escovado e ônix.", material: { body: "#b8912e", polymer: "#14110a", trim: "#f5d77a", glow: "#ffd34a", pattern: "solid", metalness: 0.95 } },
  { code: "WS_DX50_GELO", weapon: "DX50_JUIZA", name: "DX-50 Juíza · Geada", rarity: "COMMON", description: "Branco de neve com detalhes em gelo.", material: { body: "#9aa8b8", polymer: "#e6edf5", trim: "#8cd8ff", glow: "#8cd8ff", pattern: "solid" } },
];

export const CHARACTER_SKINS: readonly CharacterSkinDef[] = [
  { code: "CS_RAVEN_NOTURNO", character: "RAVEN", name: "RAVEN · Operação Noturna", rarity: "RARE", description: "Armadura negra com visor verde de visão noturna.", material: { armor: "#141820", plate: "#262c38", fabric: "#0c0e14", trim: "#3fe08f", glow: "#3fe08f" } },
  { code: "CS_GHOST_NEVE", character: "GHOST", name: "GHOST · Nevasca", rarity: "RARE", description: "Camuflagem branca da Frost Base.", material: { armor: "#c8d2dc", plate: "#e6edf5", fabric: "#8a96a4", trim: "#8cd8ff", glow: "#8cd8ff" } },
  { code: "CS_NOVA_PRISMA", character: "NOVA", name: "NOVA · Prisma", rarity: "EPIC", description: "Placas iridescentes com núcleo ciano.", material: { armor: "#2a2050", plate: "#5a3aa8", fabric: "#140e28", trim: "#2ed3e6", glow: "#2ed3e6" } },
  { code: "CS_TITAN_ACO", character: "TITAN", name: "TITAN · Aço Bruto", rarity: "COMMON", description: "Blindagem de aço sem pintura.", material: { armor: "#5a5f68", plate: "#3a3e46", fabric: "#22252a", trim: "#c8ccd4", glow: "#ff9a2e" } },
  { code: "CS_ZERO_CARBONO", character: "ZERO", name: "ZERO · Carbono", rarity: "EPIC", description: "Fibra de carbono com mira vermelha.", material: { armor: "#1a1c22", plate: "#2c2f38", fabric: "#0e0f12", trim: "#ff3b4e", glow: "#ff3b4e" } },
  { code: "CS_VIPER_CORAL", character: "VIPER", name: "VIPER · Coral", rarity: "LEGENDARY", description: "Padrão de serpente coral em vermelho, preto e amarelo.", material: { armor: "#8a1a1a", plate: "#141414", fabric: "#2a1a10", trim: "#ffe14a", glow: "#ffe14a" } },
  { code: "CS_ECHO_ABISMO", character: "ECHO", name: "ECHO · Abissal", rarity: "COMMON", description: "Azul de águas profundas.", material: { armor: "#1a3448", plate: "#2a5a78", fabric: "#0e1c28", trim: "#5cc8ff", glow: "#5cc8ff" } },
  { code: "CS_ORION_SOLAR", character: "ORION", name: "ORION · Eclipse Solar", rarity: "LEGENDARY", description: "Ônix com coroa de luz dourada.", material: { armor: "#0e0c0a", plate: "#2a2418", fabric: "#140f08", trim: "#ffd34a", glow: "#ffd34a" } },
];

/** VANTA COINS de fim de temporada por tier da patente final (só quem terminou a classificação). */
export const SEASON_REWARD_VC: Record<RankTier, number> = {
  RECRUTA: 100,
  COMBATENTE: 200,
  ESPECIALISTA: 350,
  ELITE: 500,
  MESTRE: 750,
  SUPREMO: 1000,
};

/** Código do emblema entregue a quem terminou a classificação na temporada `n`. */
export const seasonEmblemCode = (n: number) => `EMB_SEASON_${n}`;

export function priceFor(rarity: CosmeticRarity): number | null {
  return rarity === "SEASONAL" ? null : COSMETIC_PRICE_VC[rarity];
}
