import { describe, expect, it } from "vitest";
import { CollisionWorld, aabbFromCenter, overlaps, playerBox } from "./collision.js";
import { createPlayerState, MOVE, stepPlayer, TICK_DT, type MoveInput } from "./movement.js";
import { humanoidHitboxes, raycastEntities, raycastWorld } from "./raycast.js";
import { CATEGORY_TUNING, createWeaponState, currentSpread, damageAt, fireBlockReason, fireWeapon, startReload, updateWeapon, weaponStatsFromRow, type WeaponStats } from "./weapons.js";
import { NEON_DISTRICT } from "./maps/neon-district.js";
import { viewDir } from "./math.js";
import { WEAPON_CATALOG as WEAPON_FIXTURES } from "./weapon-catalog.js";

const flat = new CollisionWorld([aabbFromCenter(0, -0.5, 0, 200, 1, 200)]);
const idle: MoveInput = { forward: 0, right: 0, jump: false, crouch: false, sprint: false, aiming: false, yaw: 0, pitch: 0, weaponSpeedMult: 1 };
const run = (s: ReturnType<typeof createPlayerState>, input: Partial<MoveInput>, seconds: number, world = flat) => {
  for (let i = 0; i < Math.round(seconds / TICK_DT); i++) stepPlayer(s, { ...idle, ...input }, world);
};
const hspeed = (s: ReturnType<typeof createPlayerState>) => Math.hypot(s.vel.x, s.vel.z);

describe("movimento", () => {
  it("cai, pousa no chão e fica parado", () => {
    const s = createPlayerState({ x: 0, y: 3, z: 0 });
    run(s, {}, 2);
    expect(s.onGround).toBe(true);
    expect(s.pos.y).toBeCloseTo(0, 2);
  });

  it("anda, corre e agacha nas velocidades definidas", () => {
    const s = createPlayerState({ x: 0, y: 0, z: 0 });
    run(s, {}, 0.2);
    run(s, { forward: 1 }, 1);
    expect(hspeed(s)).toBeCloseTo(MOVE.walkSpeed, 1);
    run(s, { forward: 1, sprint: true }, 1);
    expect(hspeed(s)).toBeCloseTo(MOVE.sprintSpeed, 1);
    run(s, { forward: 1, crouch: true }, 1);
    expect(hspeed(s)).toBeCloseTo(MOVE.crouchSpeed, 1);
    run(s, { forward: 1, aiming: true }, 1);
    expect(hspeed(s)).toBeCloseTo(MOVE.walkSpeed * MOVE.adsSpeedMult, 1);
  });

  it("não corre de lado nem para trás, e a diagonal não é mais rápida", () => {
    const s = createPlayerState({ x: 0, y: 0, z: 0 });
    run(s, {}, 0.2);
    run(s, { right: 1, sprint: true }, 1);
    expect(s.sprinting).toBe(false);
    expect(hspeed(s)).toBeCloseTo(MOVE.walkSpeed, 1);
    run(s, { forward: 1, right: 1 }, 1);
    expect(hspeed(s)).toBeLessThanOrEqual(MOVE.walkSpeed + 0.01);
  });

  it("anda na direção da visão (yaw 0 = −Z)", () => {
    const s = createPlayerState({ x: 0, y: 0, z: 0 });
    run(s, { forward: 1 }, 0.5);
    expect(s.pos.z).toBeLessThan(-1);
    expect(Math.abs(s.pos.x)).toBeLessThan(0.01);
    const s2 = createPlayerState({ x: 0, y: 0, z: 0 });
    run(s2, { forward: 1, yaw: Math.PI / 2 }, 0.5);
    expect(s2.pos.x).toBeLessThan(-1);
  });

  it("pula ~1 m e não ganha velocidade pulando sem parar (anti bunny hop)", () => {
    const s = createPlayerState({ x: 0, y: 0, z: 0 });
    run(s, {}, 0.2);
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      stepPlayer(s, { ...idle, jump: i === 0 }, flat);
      peak = Math.max(peak, s.pos.y);
    }
    expect(peak).toBeGreaterThan(0.9);
    expect(peak).toBeLessThan(1.2);
    const b = createPlayerState({ x: 0, y: 0, z: 0 });
    run(b, {}, 0.2);
    run(b, { forward: 1, sprint: true, jump: true }, 5);
    expect(hspeed(b)).toBeLessThanOrEqual(MOVE.sprintSpeed * 1.15 + 1e-6);
  });

  it("colide com paredes sem atravessar, mesmo em alta velocidade", () => {
    const world = new CollisionWorld([aabbFromCenter(0, -0.5, 0, 200, 1, 200), aabbFromCenter(0, 2, -5, 10, 4, 0.2)]);
    const s = createPlayerState({ x: 0, y: 0, z: 0 });
    run(s, { forward: 1, sprint: true }, 3, world);
    expect(s.pos.z).toBeGreaterThan(-5 + 0.1 + MOVE.halfWidth - 0.01);
    s.vel.z = -200; // velocidade absurda (teleporte) também não atravessa
    stepPlayer(s, idle, world);
    expect(world.collides(playerBox(s.pos, MOVE.halfWidth, MOVE.standHeight))).toBe(false);
    expect(s.pos.z).toBeGreaterThan(-5);
  });

  it("sobe degraus pequenos mas não muros", () => {
    const world = new CollisionWorld([aabbFromCenter(0, -0.5, 0, 200, 1, 200), aabbFromCenter(0, 0.19, -6, 4, 0.38, 8), aabbFromCenter(5, 0.5, -6, 4, 1, 8)]);
    const a = createPlayerState({ x: 0, y: 0, z: 0 });
    run(a, { forward: 1 }, 1, world);
    expect(a.pos.y).toBeCloseTo(0.38, 1);
    const b = createPlayerState({ x: 5, y: 0, z: 0 });
    run(b, { forward: 1 }, 1, world);
    expect(b.pos.y).toBeLessThan(0.05);
    expect(b.pos.z).toBeGreaterThan(-2);
  });

  it("não levanta do agachamento embaixo de teto baixo", () => {
    const world = new CollisionWorld([aabbFromCenter(0, -0.5, 0, 200, 1, 200), aabbFromCenter(0, 1.6, 0, 4, 0.4, 4)]);
    const s = createPlayerState({ x: 0, y: 0, z: 0 });
    s.crouched = true;
    run(s, {}, 0.5, world);
    expect(s.crouched).toBe(true);
  });
});

describe("tiros e hitboxes", () => {
  it("diferencia cabeça, corpo e pernas", () => {
    const target = { entity: "alvo", hitboxes: humanoidHitboxes({ x: 0, y: 0, z: -10 }) };
    const shoot = (y: number) => raycastEntities([target], { x: 0, y, z: 0 }, { x: 0, y: 0, z: -1 }, 100)?.zone;
    expect(shoot(1.7)).toBe("head");
    expect(shoot(1.2)).toBe("body");
    expect(shoot(0.4)).toBe("legs");
    expect(shoot(2.0)).toBeUndefined();
  });

  it("parede entre atirador e alvo bloqueia o tiro", () => {
    const world = new CollisionWorld([aabbFromCenter(0, 1, -5, 4, 2, 0.4)]);
    const origin = { x: 0, y: 1.2, z: 0 };
    const dir = { x: 0, y: 0, z: -1 };
    const wall = raycastWorld(world, origin, dir, 100);
    const hit = raycastEntities([{ entity: 1, hitboxes: humanoidHitboxes({ x: 0, y: 0, z: -10 }) }], origin, dir, wall?.t ?? 100);
    expect(wall?.t).toBeCloseTo(4.8, 3);
    expect(hit).toBeNull();
  });

  it("viewDir segue a convenção da câmera", () => {
    expect(viewDir(0, 0).z).toBeCloseTo(-1);
    expect(viewDir(Math.PI / 2, 0).x).toBeCloseTo(-1);
    expect(viewDir(0, Math.PI / 2).y).toBeCloseTo(1);
  });
});

describe("armas", () => {
  const all = WEAPON_FIXTURES.map(weaponStatsFromRow);
  const get = (code: string) => all.find((w) => w.code === code)!;
  const still = { aiming: false, moveRatio: 0, airborne: false, crouched: false, sprinting: false };

  it("respeita a cadência (RPM) e o modo semiautomático", () => {
    const rifle = get("VK7_LAMINA");
    const ws = createWeaponState(rifle);
    let shots = 0;
    for (let t = 0; t <= 1000; t += 1) {
      updateWeapon(rifle, ws, t, 1);
      if (!fireBlockReason(rifle, ws, t, false)) {
        fireWeapon(rifle, ws, t, { x: 0, y: 0, z: -1 }, still);
        ws.triggerReleased = true;
        shots++;
      }
    }
    expect(shots).toBe(Math.floor(rifle.fireRateRpm / 60) + 1);
    const pistol = get("P9_FAISCA");
    const ps = createWeaponState(pistol);
    fireWeapon(pistol, ps, 0, { x: 0, y: 0, z: -1 }, still);
    expect(fireBlockReason(pistol, ps, 5000, false)).toBe("semi");
  });

  it("consome munição, bloqueia vazia e recarrega da reserva", () => {
    const w = get("DX50_JUIZA");
    const ws = createWeaponState(w);
    for (let i = 0; i < w.magazineSize; i++) {
      ws.triggerReleased = true;
      fireWeapon(w, ws, i * 1000, { x: 0, y: 0, z: -1 }, still);
    }
    expect(ws.ammo).toBe(0);
    expect(fireBlockReason(w, ws, 99999, false)).toBe("empty");
    expect(startReload(w, ws, 100000)).toBe(true);
    expect(fireBlockReason(w, ws, 100001, false)).toBe("reloading");
    updateWeapon(w, ws, 100000 + w.reloadMs, 16);
    expect(ws.ammo).toBe(w.magazineSize);
    expect(ws.reserve).toBe(w.reserveAmmo - w.magazineSize);
  });

  it("dispersão: mirar < quadril < andando < pulando; sniper sem mira é imprecisa", () => {
    const r = get("VK7_LAMINA");
    const ws = createWeaponState(r);
    const ads = currentSpread(r, ws, { ...still, aiming: true });
    const hip = currentSpread(r, ws, still);
    const moving = currentSpread(r, ws, { ...still, moveRatio: 1 });
    const air = currentSpread(r, ws, { ...still, airborne: true });
    expect(ads).toBeLessThan(hip);
    expect(hip).toBeLessThan(moving);
    expect(hip).toBeLessThan(air);
    const sn = get("LR1_HORIZONTE");
    expect(currentSpread(sn, createWeaponState(sn), still)).toBeGreaterThan(1.5);
    expect(currentSpread(sn, createWeaponState(sn), { ...still, aiming: true })).toBeLessThan(0.1);
  });

  it("os projéteis ficam dentro do cone e a semente é determinística", () => {
    const sg = get("SG12_TROVAO");
    const a = fireWeapon(sg, createWeaponState(sg, 0, 42), 0, { x: 0, y: 0, z: -1 }, still);
    const b = fireWeapon(sg, createWeaponState(sg, 0, 42), 0, { x: 0, y: 0, z: -1 }, still);
    expect(a.directions).toHaveLength(9);
    expect(a.directions).toEqual(b.directions);
    const maxAngle = Math.tan((currentSpread(sg, createWeaponState(sg), still) * Math.PI) / 180) + 1e-6;
    for (const d of a.directions) expect(Math.hypot(d.x, d.y) / -d.z).toBeLessThanOrEqual(maxAngle);
  });

  it("recuo sobe a mira e cresce com disparos seguidos", () => {
    const r = get("ARX9_PULSAR");
    const ws = createWeaponState(r);
    const first = fireWeapon(r, ws, 0, { x: 0, y: 0, z: -1 }, still).recoilPitch;
    let last = first;
    for (let i = 1; i < 8; i++) last = fireWeapon(r, ws, i * 200, { x: 0, y: 0, z: -1 }, still).recoilPitch;
    expect(first).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(first);
  });

  it("dano: headshot multiplica, distância reduz, escopeta some de longe", () => {
    const r = get("VK7_LAMINA");
    expect(damageAt(r, 10, "body")).toBe(28);
    expect(damageAt(r, 10, "head")).toBe(56);
    expect(damageAt(r, 10, "legs")).toBeLessThan(28);
    expect(damageAt(r, 80, "body")).toBeLessThan(28);
    const sg = get("SG12_TROVAO");
    expect(damageAt(sg, 5, "body") * 9).toBeGreaterThanOrEqual(100);
    expect(damageAt(sg, 40, "body")).toBe(0);
    const sn = get("LR1_HORIZONTE");
    expect(damageAt(sn, 50, "head")).toBeGreaterThanOrEqual(100);
    expect(damageAt(sn, 50, "body")).toBeLessThan(100);
  });

  it("equilíbrio: nenhuma arma automática elimina absurdamente mais rápido que as outras a 15 m", () => {
    const ttk = (w: WeaponStats, d: number) => (Math.ceil(100 / (damageAt(w, d, "body") * w.pelletsPerShot)) - 1) * (60000 / w.fireRateRpm);
    const autos = all.filter((w) => CATEGORY_TUNING[w.category].automatic);
    const v = autos.map((w) => ttk(w, 15));
    expect(Math.max(...v) / Math.min(...v)).toBeLessThan(2);
  });
});

describe("Neon District", () => {
  const world = new CollisionWorld(NEON_DISTRICT.solids.map((s) => s.box));
  it("spawns livres e simétricos entre os times", () => {
    for (const team of ["A", "B"] as const) {
      for (const p of NEON_DISTRICT.spawns[team]) expect(world.collides(playerBox({ ...p, y: 0.01 }, MOVE.halfWidth, MOVE.standHeight))).toBe(false);
    }
    NEON_DISTRICT.spawns.A.forEach((a) => expect(NEON_DISTRICT.spawns.B.some((b) => b.x === -a.x && b.z === -a.z)).toBe(true));
  });
  it("geometria é simétrica (rotação de 180°): cada caixa tem um par espelhado", () => {
    const key = (b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((n) => n.toFixed(3)).join(",");
    const keys = new Set(NEON_DISTRICT.solids.map((s) => key(s.box)));
    for (const s of NEON_DISTRICT.solids) {
      const m = { min: { x: -s.box.max.x, y: s.box.min.y, z: -s.box.max.z }, max: { x: -s.box.min.x, y: s.box.max.y, z: -s.box.min.z } };
      expect(keys.has(key(m))).toBe(true);
    }
  });
  it("jogador consegue subir a escada até a passarela", () => {
    const s = createPlayerState({ x: -1, y: 0, z: -8.75 });
    run(s, {}, 0.3, world);
    run(s, { forward: 1, yaw: -Math.PI / 2 }, 2.5, world); // yaw −90° = olhando para +X
    expect(s.pos.y).toBeGreaterThan(2.9);
    expect(s.pos.x).toBeGreaterThan(6);
  });
  it("alvos de treinamento não estão dentro de paredes", () => {
    for (const t of NEON_DISTRICT.training.targets) {
      const feet = { ...t.pos, y: t.pos.y + 0.01 };
      expect(humanoidHitboxes(feet).some((h) => world.query(h.box).some((b) => overlaps(h.box, b, 1e-3)))).toBe(false);
    }
  });
});
