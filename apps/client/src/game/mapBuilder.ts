import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MapDefinition, Solid } from "@vanta/shared";

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
  dispose(): void;
}

/**
 * Constrói a cena do mapa. Geometrias da mesma categoria são mescladas
 * (poucas draw calls, mesmo com centenas de caixas).
 */
export function buildMap(map: MapDefinition, quality: { shadows: boolean }): BuiltMap {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];

  const texWindows = windowsEmissive();
  const texPanel = panelColor();
  const texGround = groundColor();
  const texCrate = crateColor();
  disposables.push(texWindows, texPanel, texGround, texCrate);

  const mats: Record<string, THREE.Material> = {
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
    list.push(boxGeometry(s, unitFor[s.kind] ?? 2, s.kind === "crate"));
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
  for (const s of map.solids.filter((x) => x.kind === "building")) {
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
  for (const l of map.lights) {
    const light = new THREE.PointLight(l.color, l.intensity, l.distance, 1.6);
    light.position.set(l.pos.x, l.pos.y, l.pos.z);
    group.add(light);
  }

  return {
    group,
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}
