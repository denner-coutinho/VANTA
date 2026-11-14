import { describe, expect, it } from "vitest";
import { MAP_REGISTRY, MAP_ROTATION, MapAnalyzer } from "./maps/index.js";
import { playerBox } from "./collision.js";
import { createPlayerState, stepPlayer, type MoveInput } from "./movement.js";
import { gravityAt } from "./sim.js";

const idle: MoveInput = { forward: 0, right: 0, jump: false, crouch: false, sprint: false, aiming: false, yaw: 0, pitch: 0, weaponSpeedMult: 1 };

describe("os 5 mapas", () => {
  it("existem 5 mapas na rotação, cada um com tema próprio", () => {
    expect(MAP_ROTATION).toHaveLength(5);
    const themes = new Set(MAP_ROTATION.map((c) => MAP_REGISTRY[c]!.atmosphere.theme));
    expect(themes.size).toBe(5);
  });

  for (const code of MAP_ROTATION) {
    describe(code, () => {
      const map = MAP_REGISTRY[code]!;
      const an = new MapAnalyzer(map);
      const nodes = an.explore(map.spawns.A[0]!);

      it("é simétrico por rotação de 180° (sólidos e spawns)", () => {
        const key = (b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => v.toFixed(2)).join();
        const set = new Set(map.solids.map((s) => key(s.box)));
        for (const s of map.solids) {
          const m = { min: { x: -s.box.max.x, y: s.box.min.y, z: -s.box.max.z }, max: { x: -s.box.min.x, y: s.box.max.y, z: -s.box.min.z } };
          expect(set.has(key(m)), `espelho de ${key(s.box)}`).toBe(true);
        }
        map.spawns.A.forEach((a, i) => expect(map.spawns.B[i]).toEqual({ x: -a.x, y: a.y, z: -a.z }));
      });

      it("3 spawns livres por time, no chão", () => {
        for (const p of [...map.spawns.A, ...map.spawns.B]) {
          expect(an.world.collides(playerBox({ ...p, y: p.y + 0.05 }, 0.3, 1.8))).toBe(false);
          const s = createPlayerState({ ...p, y: p.y + 0.05 });
          for (let i = 0; i < 30; i++) stepPlayer(s, idle, an.world);
          expect(s.onGround).toBe(true);
        }
        expect(map.spawns.A).toHaveLength(3);
      });

      it("nenhum spawn enxerga um spawn inimigo", () => {
        for (const a of map.spawns.A) for (const b of map.spawns.B) expect(an.lineOfSight(a, b)).toBe(false);
      });

      it("o time A consegue andar até a base B (mapa conectado)", () => {
        const b = map.spawns.B[0]!;
        const k = `${Math.round(b.x / 2) * 2},${Math.round(b.z / 2) * 2}`;
        expect(nodes.has(k)).toBe(true);
        expect(nodes.size).toBeGreaterThan(300);
      });

      it("existe ponto de contato com linha de visão a distância de combate", () => {
        const c = an.contactPoint(nodes);
        expect(c).not.toBeNull();
        expect(c!.range).toBeGreaterThanOrEqual(8);
      });
    });
  }

  it("Orbital Zero: pulo no setor de gravidade reduzida alcança a plataforma; fora dele, não", () => {
    const map = MAP_REGISTRY.ORBITAL_ZERO!;
    const an = new MapAnalyzer(map);
    const apex = (x: number, z: number) => {
      const s = createPlayerState({ x, y: 0.05, z });
      for (let i = 0; i < 20; i++) stepPlayer(s, idle, an.world, 1 / 60, gravityAt(map.zones, s.pos));
      let top = 0;
      stepPlayer(s, { ...idle, jump: true }, an.world, 1 / 60, gravityAt(map.zones, s.pos));
      for (let i = 0; i < 200; i++) {
        stepPlayer(s, idle, an.world, 1 / 60, gravityAt(map.zones, s.pos));
        top = Math.max(top, s.pos.y);
      }
      return top;
    };
    expect(apex(-5, -8.5)).toBeGreaterThan(2.3); // perto da plataforma de 2,3 m, dentro da zona
    expect(apex(-14, -8)).toBeLessThan(1.3); // fora da zona
  });
});
