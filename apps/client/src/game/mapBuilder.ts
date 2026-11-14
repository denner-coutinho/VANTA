import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MapDefinition, MapTheme, Solid } from "@vanta/shared";

/** Texturas procedurais (canvas): janelas de prédio, painéis metálicos, piso. Nada baixado. */
function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, repeat = true) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d")!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

const windowsEmissive = () =>
  canvasTexture(256, (g, s) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, s, s);
    const cols = 8, rows = 8;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const r = Math.random();
        if (r < 0.62) continue;
        g.fillStyle = r > 0.93 ? "#823BFF" : r > 0.8 ? "#5C9BFF" : "#22305a";
        g.fillRect(x * (s / cols) + 6, y * (s / rows) + 8, s / cols - 12, s / rows - 18);
      }
  });

const panelColor = () =>
  canvasTexture(256, (g, s) => {
    g.fillStyle = "#808080";
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      const v = 110 + Math.random() * 40;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    g.strokeStyle = "rgba(20,20,30,.6)";
    g.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      g.beginPath(); g.moveTo(0, (i * s) / 4); g.lineTo(s, (i * s) / 4); g.stroke();
      g.beginPath(); g.moveTo((i * s) / 2, 0); g.lineTo((i * s) / 2, s); g.stroke();
    }
  });

/** Piso por tema: asfalto (neon), areia (deserto), neve (gelo), ladrilho (lab), chapas (estação). */
const groundTexture = (theme: MapTheme) =>
  theme === "neon"
    ? groundColor()
    : canvasTexture(512, (g, s) => {
        const base = { desert: [196, 160, 118], frost: [236, 242, 248], lab: [120, 126, 134], orbital: [130, 138, 156], neon: [0, 0, 0] }[theme];
        g.fillStyle = `rgb(${base.join(",")})`;
        g.fillRect(0, 0, s, s);
        for (let i = 0; i < 12000; i++) {
          const k = 0.86 + Math.random() * 0.2;
          g.fillStyle = `rgb(${base.map((c) => Math.min(255, c * k)).join(",")})`;
          g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
        }
        if (theme === "desert") {
          // Ondulações da areia.
          g.strokeStyle = "rgba(120,86,50,.18)";
          g.lineWidth = 3;
          for (let y = 0; y < s; y += 22) {
            g.beginPath();
            for (let x = 0; x <= s; x += 16) g.lineTo(x, y + Math.sin(x / 40 + y) * 6);
            g.stroke();
          }
        } else if (theme === "lab" || theme === "orbital") {
          g.strokeStyle = theme === "lab" ? "rgba(40,44,52,.7)" : "rgba(30,36,52,.8)";
          g.lineWidth = theme === "lab" ? 3 : 5;
          const n = theme === "lab" ? 8 : 4;
          for (let i = 0; i <= n; i++) {
            g.beginPath(); g.moveTo(0, (i * s) / n); g.lineTo(s, (i * s) / n); g.stroke();
            g.beginPath(); g.moveTo((i * s) / n, 0); g.lineTo((i * s) / n, s); g.stroke();
          }
          if (theme === "orbital") {
            g.fillStyle = "rgba(255,181,71,.35)";
            for (let i = 0; i < 4; i++) g.fillRect(0, (i * s) / 4 + 6, s, 4);
          }
        }
      });

const groundColor = () =>
  canvasTexture(512, (g, s) => {
    g.fillStyle = "#6a6f7a";
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 9000; i++) {
      const v = 80 + Math.random() * 50;
      g.fillStyle = `rgb(${v},${v},${v + 6})`;
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    g.strokeStyle = "rgba(25,30,40,.8)";
    g.lineWidth = 4;
    for (let i = 0; i <= 2; i++) {
      g.beginPath(); g.moveTo(0, (i * s) / 2); g.lineTo(s, (i * s) / 2); g.stroke();
      g.beginPath(); g.moveTo((i * s) / 2, 0); g.lineTo((i * s) / 2, s); g.stroke();
    }
  });

const crateColor = () =>
  canvasTexture(128, (g, s) => {
    g.fillStyle = "#3a4258";
    g.fillRect(0, 0, s, s);
    g.strokeStyle = "#1a1f2c";
    g.lineWidth = 8;
    g.strokeRect(4, 4, s - 8, s - 8);
    g.beginPath(); g.moveTo(8, 8); g.lineTo(s - 8, s - 8); g.stroke();
    g.fillStyle = "#FF9A2E";
    g.fillRect(s * 0.1, s * 0.82, s * 0.8, s * 0.06);
  }, false);

/** Ajusta UVs da caixa para que a textura tenha escala de mundo (1 repetição a cada `unit` metros). */
function boxGeometry(s: Solid, unit: number, perFace = false) {
  const sx = s.box.max.x - s.box.min.x, sy = s.box.max.y - s.box.min.y, sz = s.box.max.z - s.box.min.z;
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  if (!perFace) {
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    // Ordem das faces do BoxGeometry: +x, −x, +y, −y, +z, −z (4 vértices cada).
    const dims: Array<[number, number]> = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
    for (let f = 0; f < 6; f++)
      for (let v = 0; v < 4; v++) {
        const i = f * 4 + v;
        uv.setXY(i, (uv.getX(i) * dims[f]![0]) / unit, (uv.getY(i) * dims[f]![1]) / unit);
      }
  }
  geo.translate((s.box.min.x + s.box.max.x) / 2, (s.box.min.y + s.box.max.y) / 2, (s.box.min.z + s.box.max.z) / 2);
  return geo;
}

function neonTexture(text: string | undefined, color: string, w: number, h: number) {
  const ratio = w / h;
  const cw = 512, ch = Math.max(32, Math.round(512 / ratio));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(0,0,0,0)";
  g.fillRect(0, 0, cw, ch);
  g.strokeStyle = color;
  g.lineWidth = Math.max(4, ch * 0.06);
  g.shadowColor = color;
  g.shadowBlur = 18;
  if (text) {
    g.font = `700 ${Math.min(ch * 0.7, (cw / text.length) * 1.4)}px "Chakra Petch", sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#ffffff";
    g.fillText(text, cw / 2, ch / 2);
    g.strokeRect(g.lineWidth, g.lineWidth, cw - g.lineWidth * 2, ch - g.lineWidth * 2);
  } else {
    g.fillStyle = color;
    g.fillRect(0, 0, cw, ch);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface BuiltMap {
  group: THREE.Group;
  /** Animações do cenário (luzes piscando, neve, estrelas). */
  update(dt: number): void;
  dispose(): void;
}

const KIND_DEFAULT: Record<string, string> = { ground: "#808080", building: "#6a7080", wall: "#7a8090", roof: "#3a4050", walkway: "#8a90a0", stair: "#8a90a0", cover: "#9098a8", crate: "#808080" };

/**
 * Constrói a cena do mapa. Geometrias da mesma categoria são mescladas
 * (poucas draw calls, mesmo com centenas de caixas).
 */
export function buildMap(map: MapDefinition, quality: { shadows: boolean }): BuiltMap {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];

  const texWindows = windowsEmissive();
  const texPanel = panelColor();
  const theme = map.atmosphere.theme;
  const neonTheme = theme === "neon";
  const texGround = groundTexture(theme);
  const texCrate = crateColor();
  disposables.push(texWindows, texPanel, texGround, texCrate);

  // Fora do tema neon, cada sólido usa a própria cor (cores de vértice) sobre a textura neutra.
  const vc = !neonTheme;
  const mats: Record<string, THREE.MeshStandardMaterial> = vc
    ? {
        ground: new THREE.MeshStandardMaterial({ map: texGround, roughness: theme === "frost" ? 0.9 : 0.75, metalness: 0.05 }),
        building: new THREE.MeshStandardMaterial({ map: texPanel, vertexColors: true, roughness: 0.75, metalness: theme === "orbital" ? 0.45 : 0.15 }),
        wall: new THREE.MeshStandardMaterial({ map: texPanel, vertexColors: true, roughness: 0.7, metalness: theme === "orbital" ? 0.45 : 0.15 }),
        roof: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.1 }),
        walkway: new THREE.MeshStandardMaterial({ map: texPanel, vertexColors: true, roughness: 0.55, metalness: 0.35 }),
        stair: new THREE.MeshStandardMaterial({ map: texPanel, vertexColors: true, roughness: 0.6, metalness: 0.3 }),
        cover: new THREE.MeshStandardMaterial({ map: texPanel, vertexColors: true, roughness: 0.65, metalness: 0.2 }),
        crate: new THREE.MeshStandardMaterial({ map: texCrate, roughness: 0.6, metalness: 0.15 }),
      }
    : {
    ground: new THREE.MeshStandardMaterial({ map: texGround, color: "#5a6070", roughness: 0.6, metalness: 0.15 }),
    building: new THREE.MeshStandardMaterial({ map: texPanel, color: "#4a5470", emissiveMap: texWindows, emissive: "#ffffff", emissiveIntensity: 1.1, roughness: 0.7, metalness: 0.15 }),
    wall: new THREE.MeshStandardMaterial({ map: texPanel, color: "#5a6480", roughness: 0.65, metalness: 0.15 }),
    roof: new THREE.MeshStandardMaterial({ color: "#2a3142", roughness: 0.8, metalness: 0.1 }),
    walkway: new THREE.MeshStandardMaterial({ map: texPanel, color: "#64708e", roughness: 0.5, metalness: 0.25 }),
    stair: new THREE.MeshStandardMaterial({ map: texPanel, color: "#647090", roughness: 0.6, metalness: 0.2 }),
    cover: new THREE.MeshStandardMaterial({ map: texPanel, color: "#76809c", roughness: 0.5, metalness: 0.2 }),
    crate: new THREE.MeshStandardMaterial({ map: texCrate, roughness: 0.6, metalness: 0.15 }),
      };
  Object.values(mats).forEach((m) => disposables.push(m));
  const unitFor: Record<string, number> = { ground: 8, building: 6, wall: 3, roof: 6, walkway: 2, stair: 1, cover: 2, crate: 1 };

  const byKind = new Map<string, THREE.BufferGeometry[]>();
  for (const s of map.solids) {
    // O teto de contenção (y ≥ 18) não é desenhado.
    if (s.kind === "roof" && s.box.min.y >= 17) continue;
    const list = byKind.get(s.kind) ?? [];
    const geo = boxGeometry(s, unitFor[s.kind] ?? 2, s.kind === "crate");
    if (vc && s.kind !== "ground" && s.kind !== "crate") {
      const c = new THREE.Color(s.color ?? KIND_DEFAULT[s.kind] ?? "#808080");
      const n = geo.attributes.position!.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
      geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    }
    list.push(geo);
    byKind.set(s.kind, list);
  }
  for (const [kind, geos] of byKind) {
    const merged = mergeGeometries(geos, false)!;
    geos.forEach((g) => g.dispose());
    disposables.push(merged);
    const mesh = new THREE.Mesh(merged, mats[kind] ?? mats.wall);
    mesh.castShadow = quality.shadows && kind !== "ground";
    mesh.receiveShadow = quality.shadows;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }

  // Faixas de luz no topo dos prédios (silhueta da cidade).
  const stripMat = new THREE.MeshBasicMaterial({ color: "#287BFF", toneMapped: false });
  const stripGeos: THREE.BufferGeometry[] = [];
  for (const s of neonTheme ? map.solids.filter((x) => x.kind === "building") : []) {
    const g = new THREE.BoxGeometry(s.box.max.x - s.box.min.x + 0.05, 0.08, s.box.max.z - s.box.min.z + 0.05);
    g.translate((s.box.min.x + s.box.max.x) / 2, s.box.max.y - 0.3, (s.box.min.z + s.box.max.z) / 2);
    stripGeos.push(g);
  }
  if (stripGeos.length) {
    const merged = mergeGeometries(stripGeos)!;
    stripGeos.forEach((g) => g.dispose());
    disposables.push(merged, stripMat);
    group.add(new THREE.Mesh(merged, stripMat));
  }

  // Letreiros neon.
  for (const n of map.neon) {
    const tex = neonTexture(n.text, n.color, n.size[0], n.size[1]);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.DoubleSide, depthWrite: false });
    const geo = new THREE.PlaneGeometry(n.size[0], n.size[1]);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(n.pos.x, n.pos.y, n.pos.z);
    mesh.rotation.y = n.rotY;
    group.add(mesh);
    disposables.push(tex, mat, geo);
  }

  // Luzes do mapa (as do lado oposto também existem: iluminação simétrica).
  const flicker: Array<{ light: THREE.PointLight; base: number; phase: number }> = [];
  map.lights.forEach((l, i) => {
    const light = new THREE.PointLight(l.color, l.intensity, l.distance, 1.6);
    light.position.set(l.pos.x, l.pos.y, l.pos.z);
    group.add(light);
    // Blackout Lab: luz de emergência instável (metade das luzes pisca).
    if (theme === "lab" && i % 2 === 0) flicker.push({ light, base: l.intensity, phase: Math.random() * 10 });
  });

  // Partículas do ambiente: neve (Frost Base), poeira (Desert Protocol), estrelas (Orbital Zero).
  let particles: THREE.Points | null = null;
  let fall = 0;
  const b = map.bounds;
  if (theme === "frost" || theme === "desert") {
    const n = theme === "frost" ? 2500 : 900;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pos.set([b.min.x + Math.random() * (b.max.x - b.min.x), Math.random() * 14, b.min.z + Math.random() * (b.max.z - b.min.z)], i * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: theme === "frost" ? "#ffffff" : "#e8c9a0", size: theme === "frost" ? 0.07 : 0.04, transparent: true, opacity: theme === "frost" ? 0.85 : 0.5, depthWrite: false });
    particles = new THREE.Points(geo, mat);
    fall = theme === "frost" ? 1.2 : 0.15;
    group.add(particles);
    disposables.push(geo, mat);
  } else if (theme === "orbital") {
    const n = 1800;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = 150;
      pos.set([Math.sqrt(1 - u * u) * Math.cos(a) * r, Math.abs(u) * r * 0.9 + 10, Math.sqrt(1 - u * u) * Math.sin(a) * r], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: "#ffffff", size: 0.6, sizeAttenuation: true, fog: false });
    group.add(new THREE.Points(geo, mat));
    // Planeta ao longe.
    const pg = new THREE.SphereGeometry(40, 32, 16);
    const pm = new THREE.MeshBasicMaterial({ color: "#3a2a6a", fog: false });
    const planet = new THREE.Mesh(pg, pm);
    planet.position.set(-90, 60, -120);
    group.add(planet);
    disposables.push(geo, mat, pg, pm);
  }
  let t = 0;

  return {
    group,
    update(dt: number) {
      t += dt;
      for (const f of flicker) {
        const n = Math.sin(t * 13 + f.phase) + Math.sin(t * 31 + f.phase * 2);
        f.light.intensity = n > 1.6 ? 0 : f.base * (0.75 + 0.25 * Math.sin(t * 3 + f.phase));
      }
      if (particles && fall) {
        const arr = particles.geometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < arr.count; i++) {
          let y = arr.getY(i) - fall * dt * (0.6 + (i % 7) * 0.08);
          if (y < 0) y += 14;
          arr.setY(i, y);
          arr.setX(i, arr.getX(i) + Math.sin(t + i) * dt * 0.2);
        }
        arr.needsUpdate = true;
      }
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}
