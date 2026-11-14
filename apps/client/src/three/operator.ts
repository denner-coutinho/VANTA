import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/**
 * Operador procedural (asset original, gerado em código) com esqueleto hierárquico simples.
 * É o modelo provisório do menu na Fase 1; na Fase 4 ele é substituído por modelos
 * rigados (glTF) que usam o mesmo contrato `OperatorRig` (update(dt, lookTarget)).
 */
export interface OperatorRig {
  root: THREE.Group;
  update(dt: number, t: number, look: THREE.Vector2): void;
  setAccent(hex: string): void;
  dispose(): void;
}

export function createOperator(accentHex = "#287BFF"): OperatorRig {
  const geos: THREE.BufferGeometry[] = [];
  const g = <T extends THREE.BufferGeometry>(geo: T) => (geos.push(geo), geo);

  const armor = new THREE.MeshStandardMaterial({ color: 0x323c52, metalness: 0.65, roughness: 0.36 });
  const armorLight = new THREE.MeshStandardMaterial({ color: 0x56627c, metalness: 0.5, roughness: 0.42 });
  const fabric = new THREE.MeshStandardMaterial({ color: 0x1c2232, metalness: 0.1, roughness: 0.85 });
  const accent = new THREE.MeshStandardMaterial({ color: accentHex, emissive: accentHex, emissiveIntensity: 1.6, metalness: 0.2, roughness: 0.3 });
  const visor = new THREE.MeshPhysicalMaterial({ color: 0x0a0f1c, emissive: accentHex, emissiveIntensity: 0.9, metalness: 0.9, roughness: 0.08, clearcoat: 1 });
  const gun = new THREE.MeshStandardMaterial({ color: 0x151a26, metalness: 0.85, roughness: 0.3 });
  const mats = [armor, armorLight, fabric, accent, visor, gun];

  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const box = (w: number, h: number, d: number, r = 0.03) => g(new RoundedBoxGeometry(w, h, d, 3, r));

  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.98;
  root.add(hips);
  hips.add(mesh(box(0.36, 0.16, 0.22), armor));
  hips.add(mesh(box(0.38, 0.03, 0.235, 0.01), accent, 0, 0.05, 0));

  // Pernas
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const thigh = new THREE.Group();
    thigh.position.set(side * 0.11, -0.06, 0);
    thigh.add(mesh(box(0.15, 0.44, 0.17), fabric, 0, -0.22, 0));
    thigh.add(mesh(box(0.16, 0.2, 0.06), armorLight, 0, -0.18, 0.08));
    const shin = new THREE.Group();
    shin.position.y = -0.45;
    shin.add(mesh(box(0.13, 0.42, 0.15), fabric, 0, -0.21, 0));
    shin.add(mesh(box(0.15, 0.13, 0.07), armor, 0, -0.02, 0.07));
    shin.add(mesh(box(0.15, 0.1, 0.27), armor, 0, -0.43, 0.04));
    shin.add(mesh(box(0.01, 0.2, 0.012, 0.004), accent, side * 0.068, -0.2, 0.05));
    thigh.add(shin);
    hips.add(thigh);
    legs.push(thigh);
  }

  // Tronco
  const spine = new THREE.Group();
  spine.position.y = 0.08;
  hips.add(spine);
  spine.add(mesh(box(0.34, 0.2, 0.2), fabric, 0, 0.1, 0));
  const chest = new THREE.Group();
  chest.position.y = 0.22;
  spine.add(chest);
  chest.add(mesh(box(0.46, 0.34, 0.27, 0.05), armor, 0, 0.14, 0));
  chest.add(mesh(box(0.38, 0.22, 0.06), armorLight, 0, 0.13, 0.15));
  chest.add(mesh(box(0.24, 0.018, 0.012, 0.005), accent, 0, 0.2, 0.185));
  chest.add(mesh(box(0.14, 0.012, 0.012, 0.004), accent, 0, 0.165, 0.185));
  chest.add(mesh(box(0.36, 0.3, 0.12), armor, 0, 0.12, -0.17));
  chest.add(mesh(box(0.05, 0.22, 0.02, 0.008), accent, 0.1, 0.12, -0.235));

  // Cabeça e capacete
  const neck = new THREE.Group();
  neck.position.y = 0.33;
  chest.add(neck);
  neck.add(mesh(g(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 12)), fabric, 0, 0.03, 0));
  const head = new THREE.Group();
  head.position.y = 0.09;
  neck.add(head);
  head.add(mesh(box(0.23, 0.25, 0.26, 0.09), armor, 0, 0.11, 0));
  head.add(mesh(box(0.25, 0.08, 0.27, 0.03), armorLight, 0, 0.21, -0.01));
  head.add(mesh(box(0.2, 0.075, 0.05, 0.025), visor, 0, 0.12, 0.125));
  head.add(mesh(box(0.012, 0.11, 0.06, 0.004), accent, 0.12, 0.12, 0.02));
  head.add(mesh(box(0.05, 0.04, 0.05, 0.01), armorLight, -0.13, 0.1, 0));
  const antenna = mesh(g(new THREE.CylinderGeometry(0.004, 0.006, 0.18, 6)), armorLight, -0.13, 0.22, -0.02);
  head.add(antenna);

  // Braços segurando o rifle
  const arms: Array<{ upper: THREE.Group; fore: THREE.Group }> = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.29, 0.25, 0);
    chest.add(shoulder);
    shoulder.add(mesh(box(0.17, 0.12, 0.2, 0.05), armor, side * 0.02, 0.04, 0));
    shoulder.add(mesh(box(0.012, 0.09, 0.012, 0.004), accent, side * 0.105, 0.04, 0.06));
    const upper = new THREE.Group();
    shoulder.add(upper);
    upper.add(mesh(box(0.1, 0.3, 0.11), fabric, 0, -0.15, 0));
    const fore = new THREE.Group();
    fore.position.y = -0.3;
    upper.add(fore);
    fore.add(mesh(box(0.095, 0.28, 0.1), armorLight, 0, -0.14, 0));
    fore.add(mesh(box(0.08, 0.08, 0.09, 0.03), fabric, 0, -0.31, 0));
    arms.push({ upper, fore });
  }
  // Pose de “low ready”: rifle diagonal à frente do peito.
  arms[0]!.upper.rotation.set(-0.55, 0, -0.35);
  arms[0]!.fore.rotation.set(-1.1, 0, 0.25);
  arms[1]!.upper.rotation.set(-0.35, 0, 0.18);
  arms[1]!.fore.rotation.set(-1.25, 0, -0.65);

  const rifle = new THREE.Group();
  rifle.position.set(0.02, -0.02, 0.32);
  rifle.rotation.set(0.25, 0.15, 0.95);
  chest.add(rifle);
  rifle.add(mesh(box(0.07, 0.11, 0.5, 0.015), gun, 0, 0, 0));
  rifle.add(mesh(box(0.05, 0.05, 0.36, 0.01), gun, 0, 0.015, 0.4));
  rifle.add(mesh(box(0.06, 0.13, 0.06, 0.012), gun, 0, -0.1, 0.06));
  rifle.add(mesh(box(0.065, 0.1, 0.2, 0.015), armorLight, 0, -0.01, -0.32));
  rifle.add(mesh(box(0.04, 0.05, 0.12, 0.01), gun, 0, 0.085, 0.05));
  rifle.add(mesh(box(0.072, 0.012, 0.3, 0.004), accent, 0, 0.02, 0.05));
  rifle.add(mesh(box(0.035, 0.02, 0.02, 0.006), visor, 0, 0.085, 0.115));

  root.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = true) : null));

  const headBase = head.rotation.clone();
  return {
    root,
    update(dt, t, look) {
      // Respiração e transferência de peso (idle real, contínuo).
      const breathe = Math.sin(t * 1.6);
      chest.position.y = 0.22 + breathe * 0.006;
      chest.rotation.x = breathe * 0.012;
      hips.position.y = 0.98 + Math.sin(t * 0.55) * 0.008;
      hips.rotation.z = Math.sin(t * 0.55) * 0.02;
      spine.rotation.z = -Math.sin(t * 0.55) * 0.025;
      legs[0]!.rotation.z = 0.02 + Math.sin(t * 0.55) * 0.012;
      legs[1]!.rotation.z = -0.02 + Math.sin(t * 0.55) * 0.012;
      rifle.rotation.x = 0.25 + Math.sin(t * 1.6 + 0.6) * 0.012;
      antenna.rotation.z = Math.sin(t * 3.1) * 0.05;
      // Cabeça segue o cursor suavemente.
      const k = 1 - Math.exp(-dt * 4);
      head.rotation.y += (headBase.y + look.x * 0.45 - head.rotation.y) * k;
      head.rotation.x += (headBase.x - look.y * 0.18 - head.rotation.x) * k;
      chest.rotation.y += (look.x * 0.08 - chest.rotation.y) * k;
      accent.emissiveIntensity = 1.5 + Math.sin(t * 2.4) * 0.3;
    },
    setAccent(hex) {
      accent.color.set(hex);
      accent.emissive.set(hex);
      visor.emissive.set(hex);
    },
    dispose() {
      geos.forEach((x) => x.dispose());
      mats.forEach((m) => m.dispose());
    },
  };
}
