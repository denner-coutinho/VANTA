import type { WeaponCategory } from "./weapons.js";

export type WeaponSeed = {
  code: string; name: string; category: WeaponCategory; description: string; damage: number; headshotMult?: number;
  fireRateRpm: number; magazineSize: number; reserveAmmo: number; reloadMs: number; rangeM: number; spreadDeg: number;
  recoil: number; moveSpeedMult?: number; pelletsPerShot?: number;
};

/**
 * Arsenal inicial. Balanceamento por "tempo para eliminar" (TTK) contra 100 de vida:
 * rifles ~0,28–0,32 s no corpo, SMGs mais rápidas de perto e fracas de longe,
 * snipers recompensam precisão, escopetas dominam só a curta distância.
 */
export const WEAPON_CATALOG: WeaponSeed[] = [
  { code: "VK7_LAMINA", name: "VK-7 Lâmina", category: "ASSAULT_RIFLE", description: "Rifle versátil de cadência alta e recuo controlável.", damage: 28, fireRateRpm: 650, magazineSize: 30, reserveAmmo: 90, reloadMs: 2300, rangeM: 40, spreadDeg: 0.6, recoil: 1.0 },
  { code: "ARX9_PULSAR", name: "ARX-9 Pulsar", category: "ASSAULT_RIFLE", description: "Rifle pesado: mais dano por disparo, recuo mais exigente.", damage: 33, fireRateRpm: 560, magazineSize: 25, reserveAmmo: 75, reloadMs: 2500, rangeM: 45, spreadDeg: 0.5, recoil: 1.3, moveSpeedMult: 0.97 },
  { code: "SPX_VESPA", name: "SPX Vespa", category: "SMG", description: "Submetralhadora de cadência extrema para curta distância.", damage: 21, fireRateRpm: 880, magazineSize: 32, reserveAmmo: 128, reloadMs: 1900, rangeM: 18, spreadDeg: 1.1, recoil: 0.7, moveSpeedMult: 1.05 },
  { code: "KR4_FAGULHA", name: "KR-4 Fagulha", category: "SMG", description: "SMG equilibrada, boa em movimento e em média-curta distância.", damage: 25, fireRateRpm: 750, magazineSize: 28, reserveAmmo: 112, reloadMs: 2000, rangeM: 22, spreadDeg: 0.9, recoil: 0.8, moveSpeedMult: 1.03 },
  { code: "LR1_HORIZONTE", name: "LR-1 Horizonte", category: "SNIPER", description: "Sniper de ferrolho. Headshot elimina; no corpo, exige um segundo acerto.", damage: 95, headshotMult: 2.5, fireRateRpm: 45, magazineSize: 5, reserveAmmo: 20, reloadMs: 3200, rangeM: 120, spreadDeg: 0.05, recoil: 4.0, moveSpeedMult: 0.85 },
  { code: "MK2_AGULHA", name: "MK-2 Agulha", category: "SNIPER", description: "Rifle de precisão semiautomático para pressão constante a distância.", damage: 60, fireRateRpm: 140, magazineSize: 10, reserveAmmo: 30, reloadMs: 2700, rangeM: 80, spreadDeg: 0.15, recoil: 2.2, moveSpeedMult: 0.92 },
  { code: "SG12_TROVAO", name: "SG-12 Trovão", category: "SHOTGUN", description: "Escopeta de bombeamento: devastadora a até 10 metros.", damage: 14, fireRateRpm: 75, magazineSize: 6, reserveAmmo: 24, reloadMs: 3000, rangeM: 10, spreadDeg: 4.5, recoil: 3.0, pelletsPerShot: 9, headshotMult: 1.5 },
  { code: "HX3_MARTELO", name: "HX-3 Martelo", category: "SHOTGUN", description: "Escopeta semiautomática: menos dano por disparo, mais disparos.", damage: 10, fireRateRpm: 200, magazineSize: 8, reserveAmmo: 32, reloadMs: 2800, rangeM: 8, spreadDeg: 5.0, recoil: 2.4, pelletsPerShot: 8, headshotMult: 1.5 },
  { code: "P9_FAISCA", name: "P-9 Faísca", category: "PISTOL", description: "Pistola padrão, precisa e rápida de sacar.", damage: 24, fireRateRpm: 400, magazineSize: 15, reserveAmmo: 45, reloadMs: 1500, rangeM: 25, spreadDeg: 0.7, recoil: 0.9, moveSpeedMult: 1.08 },
  { code: "DX50_JUIZA", name: "DX-50 Juíza", category: "PISTOL", description: "Pistola pesada: dois headshots eliminam.", damage: 48, fireRateRpm: 170, magazineSize: 7, reserveAmmo: 28, reloadMs: 1900, rangeM: 30, spreadDeg: 0.5, recoil: 2.0, moveSpeedMult: 1.06 },
];

