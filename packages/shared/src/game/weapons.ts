import { DEG, clamp, rng, type Vec3 } from "./math.js";
import type { HitZone } from "./raycast.js";

export type WeaponCategory = "ASSAULT_RIFLE" | "SMG" | "SNIPER" | "SHOTGUN" | "PISTOL";

/** Atributos autoritativos de uma arma (vêm da tabela Weapon). Adicionar arma = nova linha no banco. */
export interface WeaponStats {
  code: string;
  name: string;
  category: WeaponCategory;
  damage: number;
  headshotMult: number;
  fireRateRpm: number;
  magazineSize: number;
  reserveAmmo: number;
  reloadMs: number;
  rangeM: number;
  spreadDeg: number;
  recoil: number;
  moveSpeedMult: number;
  pelletsPerShot: number;
}

/** Comportamento por categoria (o que o banco não precisa guardar). */
export const CATEGORY_TUNING: Record<WeaponCategory, { automatic: boolean; hipMult: number; adsZoom: number; adsTimeMs: number; switchMs: number; maxRange: number; falloffFloor: number; legMult: number }> = {
  ASSAULT_RIFLE: { automatic: true, hipMult: 2.6, adsZoom: 1.35, adsTimeMs: 220, switchMs: 520, maxRange: 300, falloffFloor: 0.6, legMult: 0.8 },
  SMG: { automatic: true, hipMult: 1.6, adsZoom: 1.2, adsTimeMs: 160, switchMs: 420, maxRange: 200, falloffFloor: 0.5, legMult: 0.85 },
  SNIPER: { automatic: false, hipMult: 40, adsZoom: 3.2, adsTimeMs: 340, switchMs: 680, maxRange: 400, falloffFloor: 0.9, legMult: 0.75 },
  SHOTGUN: { automatic: false, hipMult: 1.0, adsZoom: 1.15, adsTimeMs: 200, switchMs: 560, maxRange: 35, falloffFloor: 0.15, legMult: 0.85 },
  PISTOL: { automatic: false, hipMult: 1.8, adsZoom: 1.2, adsTimeMs: 140, switchMs: 300, maxRange: 150, falloffFloor: 0.55, legMult: 0.85 },
};

export const ZONE_MULT = (stats: WeaponStats, zone: HitZone) =>
  zone === "head" ? stats.headshotMult : zone === "legs" ? CATEGORY_TUNING[stats.category].legMult : 1;

/** Dano após queda por distância: integral até `rangeM`, cai linearmente até o piso em 2× o alcance. */
export function damageAt(stats: WeaponStats, distance: number, zone: HitZone): number {
  const t = CATEGORY_TUNING[stats.category];
  if (distance > t.maxRange) return 0;
  let falloff = 1;
  if (distance > stats.rangeM) {
    const k = clamp((distance - stats.rangeM) / stats.rangeM, 0, 1);
    falloff = 1 - (1 - t.falloffFloor) * k;
  }
  return Math.max(1, Math.round(stats.damage * falloff * ZONE_MULT(stats, zone)));
}

export interface WeaponState {
  code: string;
  ammo: number;
  reserve: number;
  /** Momento (ms de simulação) em que o próximo disparo é permitido. */
  nextFireAt: number;
  reloadEndsAt: number | null;
  switchEndsAt: number;
  /** Disparos consecutivos (aumenta dispersão e recuo). Decai sem atirar. */
  heat: number;
  lastShotAt: number;
  /** Para armas semiautomáticas: exige soltar o gatilho entre disparos. */
  triggerReleased: boolean;
  shotSeed: number;
}

export function createWeaponState(stats: WeaponStats, now = 0, seed = 1): WeaponState {
  return { code: stats.code, ammo: stats.magazineSize, reserve: stats.reserveAmmo, nextFireAt: now, reloadEndsAt: null, switchEndsAt: now, heat: 0, lastShotAt: -1e9, triggerReleased: true, shotSeed: seed };
}

export interface SpreadContext {
  aiming: boolean;
  /** 0..1: velocidade horizontal relativa à velocidade de corrida. */
  moveRatio: number;
  airborne: boolean;
  crouched: boolean;
  sprinting: boolean;
}

/** Dispersão atual em graus (meio-ângulo do cone). */
export function currentSpread(stats: WeaponStats, ws: WeaponState, ctx: SpreadContext): number {
  const t = CATEGORY_TUNING[stats.category];
  let s = stats.spreadDeg * (ctx.aiming ? 1 : t.hipMult);
  if (stats.category === "SHOTGUN") s = stats.spreadDeg * (ctx.aiming ? 0.8 : 1);
  s += ctx.moveRatio * (stats.category === "SNIPER" ? 6 : stats.category === "SHOTGUN" ? 0.6 : 2.2) * (ctx.aiming ? 0.6 : 1);
  if (ctx.airborne) s += stats.category === "SNIPER" ? 10 : 4;
  if (ctx.crouched && !ctx.airborne) s *= 0.8;
  if (ctx.sprinting) s += 3;
  // “Bloom”: disparos seguidos abrem o cone, até um teto.
  s += Math.min(ws.heat, 12) * stats.recoil * 0.09;
  return s;
}

export function isReloading(ws: WeaponState, now: number) {
  return ws.reloadEndsAt !== null && now < ws.reloadEndsAt;
}

/** Atualiza temporizadores: termina recarga e esfria o recuo. */
export function updateWeapon(stats: WeaponStats, ws: WeaponState, now: number, dtMs: number): void {
  if (ws.reloadEndsAt !== null && now >= ws.reloadEndsAt) {
    const need = stats.magazineSize - ws.ammo;
    const take = Math.min(need, ws.reserve);
    ws.ammo += take;
    ws.reserve -= take;
    ws.reloadEndsAt = null;
  }
  if (now - ws.lastShotAt > 60000 / stats.fireRateRpm + 60) ws.heat = Math.max(0, ws.heat - dtMs / 55);
}

export type FireBlock = "empty" | "reloading" | "switching" | "cooldown" | "semi" | "sprinting" | null;

export function fireBlockReason(stats: WeaponStats, ws: WeaponState, now: number, sprinting: boolean): FireBlock {
  if (now < ws.switchEndsAt) return "switching";
  if (isReloading(ws, now)) return "reloading";
  if (ws.ammo <= 0) return "empty";
  if (sprinting) return "sprinting";
  if (!CATEGORY_TUNING[stats.category].automatic && !ws.triggerReleased) return "semi";
  if (now < ws.nextFireAt) return "cooldown";
  return null;
}

export interface ShotResult {
  /** Direções de cada projétil (escopetas têm vários). */
  directions: Vec3[];
  /** Recuo aplicado à mira (radianos): positivo = sobe. */
  recoilPitch: number;
  recoilYaw: number;
}

/**
 * Executa um disparo: consome munição, aplica cadência, calcula os projéteis dentro do cone
 * com semente determinística e o recuo. Quem chama já validou com `fireBlockReason`.
 */
export function fireWeapon(stats: WeaponStats, ws: WeaponState, now: number, forward: Vec3, ctx: SpreadContext): ShotResult {
  const spreadRad = currentSpread(stats, ws, ctx) * DEG;
  const rand = rng(ws.shotSeed);
  ws.shotSeed = (ws.shotSeed * 1664525 + 1013904223) >>> 0;
  ws.ammo -= 1;
  // Agenda o próximo disparo a partir do instante permitido (sem perder cadência por jitter de frame).
  const interval = 60000 / stats.fireRateRpm;
  // Fogo contínuo: encadeia a partir do instante agendado (sem perder cadência por jitter de frame).
  ws.nextFireAt = now - ws.nextFireAt < interval ? ws.nextFireAt + interval : now + interval;
  ws.lastShotAt = now;
  ws.heat += 1;
  ws.triggerReleased = false;

  // Base ortonormal em torno da direção de visão.
  const up = Math.abs(forward.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const right = normalize(cross(forward, up));
  const realUp = cross(right, forward);
  const directions: Vec3[] = [];
  for (let i = 0; i < Math.max(1, stats.pelletsPerShot); i++) {
    // Distribuição uniforme no disco (sqrt) → cone circular.
    const r = Math.sqrt(rand()) * Math.tan(spreadRad);
    const a = rand() * Math.PI * 2;
    const ox = Math.cos(a) * r;
    const oy = Math.sin(a) * r;
    directions.push(normalize({ x: forward.x + right.x * ox + realUp.x * oy, y: forward.y + right.y * ox + realUp.y * oy, z: forward.z + right.z * ox + realUp.z * oy }));
  }

  const heatK = 1 + Math.min(ws.heat, 10) * 0.06;
  const recoilPitch = stats.recoil * 0.55 * DEG * heatK * (ctx.aiming ? 0.8 : 1) * (ctx.crouched ? 0.85 : 1);
  // Padrão horizontal: deriva para um lado nos primeiros tiros e depois oscila (aprendível, não puramente aleatório).
  const pattern = Math.sin(ws.heat * 0.9) * 0.6 + (rand() - 0.5) * 0.5;
  const recoilYaw = stats.recoil * 0.22 * DEG * pattern;
  return { directions, recoilPitch, recoilYaw };
}

export function startReload(stats: WeaponStats, ws: WeaponState, now: number): boolean {
  if (ws.reloadEndsAt !== null || ws.ammo >= stats.magazineSize || ws.reserve <= 0 || now < ws.switchEndsAt) return false;
  // Recarga tática (com bala na câmara) é 15% mais rápida.
  const ms = ws.ammo > 0 ? stats.reloadMs * 0.85 : stats.reloadMs;
  ws.reloadEndsAt = now + ms;
  return true;
}

export function cancelReload(ws: WeaponState) {
  ws.reloadEndsAt = null;
}

export function beginSwitchTo(stats: WeaponStats, ws: WeaponState, now: number) {
  ws.reloadEndsAt = null;
  ws.switchEndsAt = now + CATEGORY_TUNING[stats.category].switchMs;
  ws.triggerReleased = false;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

/** Converte a linha do banco (Prisma/API) em WeaponStats. */
export function weaponStatsFromRow(row: Record<string, unknown>): WeaponStats {
  const n = (k: string, d = 0) => (typeof row[k] === "number" ? (row[k] as number) : d);
  return {
    code: String(row.code),
    name: String(row.name),
    category: row.category as WeaponCategory,
    damage: n("damage"),
    headshotMult: n("headshotMult", 2),
    fireRateRpm: n("fireRateRpm", 600),
    magazineSize: n("magazineSize", 30),
    reserveAmmo: n("reserveAmmo", 90),
    reloadMs: n("reloadMs", 2000),
    rangeM: n("rangeM", 30),
    spreadDeg: n("spreadDeg", 1),
    recoil: n("recoil", 1),
    moveSpeedMult: n("moveSpeedMult", 1),
    pelletsPerShot: n("pelletsPerShot", 1),
  };
}
