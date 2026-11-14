import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CHARACTER_CODES, CharacterRig, type AnimInput } from "./characters";

const base: AnimInput = { speed: 0, sprinting: false, crouch: 0, onGround: true, alive: true, reloading: false, pitch: 0 };

function run(rig: CharacterRig, input: Partial<AnimInput>, seconds = 1) {
  for (let t = 0; t < seconds; t += 1 / 60) rig.update(1 / 60, { ...base, ...input });
  rig.root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(rig.root);
}

/** Assinatura geométrica: quantidade de peças + dimensões da caixa envolvente (em cm). */
function signature(rig: CharacterRig) {
  let meshes = 0;
  const kinds = new Set<string>();
  rig.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      meshes++;
      kinds.add((o as THREE.Mesh).geometry.type);
    }
  });
  const b = run(rig, {}, 0.1);
  const s = b.getSize(new THREE.Vector3());
  return `${meshes}|${[...kinds].sort().join(",")}|${Math.round(s.x * 100)}x${Math.round(s.z * 100)}`;
}

describe("operadores procedurais", () => {
  it("os 8 operadores têm modelos distintos e a mesma altura (hitbox igual)", () => {
    const sigs = new Set<string>();
    for (const code of CHARACTER_CODES) {
      const rig = new CharacterRig(code, { detail: "low" });
      sigs.add(signature(rig));
      const h = run(rig, {}, 0.5).max.y;
      expect(h, code).toBeGreaterThan(1.7);
      expect(h, code).toBeLessThan(1.83);
      rig.dispose();
    }
    expect(sigs.size).toBe(8);
  });

  it("código desconhecido cai no RAVEN em vez de quebrar", () => {
    expect(new CharacterRig("???").code).toBe("RAVEN");
  });

  it("transições de estado: idle, walk, run, crouch, jump, die", () => {
    const rig = new CharacterRig("TITAN", { detail: "low" });
    run(rig, {});
    expect(rig.state).toBe("idle");
    run(rig, { speed: 4.2 });
    expect(rig.state).toBe("walk");
    run(rig, { speed: 6.6, sprinting: true });
    expect(rig.state).toBe("run");
    run(rig, { crouch: 1 });
    expect(rig.state).toBe("crouch");
    run(rig, { onGround: false }, 0.3);
    expect(rig.state).toBe("jump");
    run(rig, { alive: false }, 1);
    expect(rig.state).toBe("die");
    run(rig, {}, 0.5);
    expect(rig.state).toBe("idle"); // renasce no próximo round
  });

  it("os pés ficam no chão em pé e agachado; agachado fica mais baixo", () => {
    for (const code of CHARACTER_CODES) {
      const rig = new CharacterRig(code, { detail: "low" });
      const stand = run(rig, {});
      const crouch = run(rig, { crouch: 1 });
      expect(Math.abs(stand.min.y), code).toBeLessThan(0.06);
      expect(Math.abs(crouch.min.y), code).toBeLessThan(0.08);
      expect(crouch.max.y, code).toBeLessThan(stand.max.y - 0.3);
    }
  });

  it("morto fica deitado (altura total baixa)", () => {
    const rig = new CharacterRig("ORION", { detail: "low" });
    const box = run(rig, { alive: false }, 1.5);
    expect(box.max.y).toBeLessThan(0.9);
  });

  it("sobreposições de disparo e recarga mexem a arma e os braços", () => {
    const rig = new CharacterRig("RAVEN", { detail: "low" });
    run(rig, {});
    const pose = () => {
      rig.root.updateMatrixWorld(true);
      const out: number[] = [];
      rig.root.traverse((o) => out.push(...o.matrixWorld.elements));
      return out;
    };
    const idle = pose();
    rig.shoot();
    rig.update(1 / 60, base);
    expect(rig.overlays.shooting).toBe(true);
    const shot = pose();
    expect(shot.some((v, i) => Math.abs(v - idle[i]!) > 1e-3)).toBe(true);
    run(rig, { reloading: true }, 0.4);
    expect(rig.overlays.reloading).toBe(true);
    const rel = pose();
    expect(rel.some((v, i) => Math.abs(v - idle[i]!) > 0.02)).toBe(true);
  });

  it("anda sem patinar: a frequência da passada cresce com a velocidade", () => {
    const count = (speed: number) => {
      const rig = new CharacterRig("ECHO", { detail: "low" });
      let crossings = 0;
      let prev = 0;
      for (let i = 0; i < 120; i++) {
        rig.update(1 / 60, { ...base, speed, sprinting: speed > 6 });
        rig.root.updateMatrixWorld(true);
        // perna esquerda à frente/atrás
        const thigh = rig.root.children[0]!.children.find((c) => c.type === "Group")!;
        const s = Math.sign(thigh.rotation.x - 0.0);
        if (i > 30 && s !== prev) crossings++;
        prev = s;
      }
      return crossings;
    };
    expect(count(6.6)).toBeGreaterThanOrEqual(count(2.5));
  });
});
