/**
 * Página de desenvolvimento (não entra no build de produção): mostra os 8 operadores lado a lado
 * numa animação escolhida por `?anim=idle|walk|run|crouch|jump|shoot|reload|die`. Usada para
 * inspeção visual e para as capturas em docs/screenshots. `?view=weapons` mostra os 10 modelos de arma
 * em primeira pessoa de perfil.
 */
import * as THREE from "three";
import { WEAPON_CATALOG, weaponStatsFromRow } from "@vanta/shared";
import { CHARACTER_CODES, CharacterRig } from "../three/characters";
import { ViewModel } from "../game/viewmodel";

const params = new URLSearchParams(location.search);
const anim = params.get("anim") ?? "idle";
const view = params.get("view") ?? "front";
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#141a28");
scene.add(new THREE.HemisphereLight("#cfe0ff", "#2a3048", 2.2));
const key = new THREE.DirectionalLight("#ffffff", 2.2);
key.position.set(3, 6, 5);
scene.add(key);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 10), new THREE.MeshStandardMaterial({ color: "#232a3a" }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 100);
const side = view === "side";
camera.position.set(side ? 11 : 0, 1.4, side ? 0 : 12);
camera.lookAt(0, 0.9, 0);

if (view === "weapons") {
  // Os modelos reais do ViewModel (mesma função usada em jogo), dispostos em grade, de perfil.
  scene.remove(floor);
  WEAPON_CATALOG.forEach((row, i) => {
    const vm = new ViewModel();
    const stats = weaponStatsFromRow(row as unknown as Record<string, unknown>);
    vm.prepare([stats]);
    const g = (vm as unknown as { models: Map<string, { group: THREE.Group }> }).models.get(stats.code)!.group;
    g.traverse((o) => (o.renderOrder = 0));
    g.scale.setScalar(2.4);
    g.rotation.y = Math.PI / 2;
    g.position.set(((i % 5) - 2) * 2.6 + 0.7, i < 5 ? 1.75 : 0.35, 0);
    scene.add(g);
    const label = document.createElement("div");
    label.textContent = stats.name;
    label.style.cssText = `position:fixed;left:${(i % 5) * 20}%;top:${i < 5 ? 44 : 88}%;width:20%;text-align:center;font:600 15px Barlow,sans-serif;color:#cdd6ea`;
    document.body.appendChild(label);
  });
  camera.position.set(0, 1.05, 10);
  camera.lookAt(0, 1.05, 0);
}

const rigs = (view === "weapons" ? [] : CHARACTER_CODES).map((code, i) => {
  const r = new CharacterRig(code, { detail: "high", name: code, team: i % 2 ? "#FF3B4E" : "#287BFF" });
  const x = (i - 3.5) * 1.35;
  r.root.position.set(side ? 0 : x, 0, side ? x : 0);
  r.root.rotation.y = side ? 0 : Math.PI;
  scene.add(r.root);
  return r;
});

const clock = new THREE.Clock();
let t = 0;
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  t += dt;
  for (const r of rigs) {
    const input = {
      speed: anim === "walk" ? 4.2 : anim === "run" ? 6.6 : 0,
      sprinting: anim === "run",
      crouch: anim === "crouch" ? 1 : 0,
      onGround: anim !== "jump",
      alive: anim !== "die",
      reloading: anim === "reload",
      pitch: 0,
    };
    if (anim === "shoot" && Math.floor(t * 8) !== Math.floor((t - dt) * 8)) r.shoot();
    r.update(dt, input);
  }
  if (view !== "weapons") (document.getElementById("hud")!).textContent = `anim=${anim} · estados: ${rigs.map((r) => r.state + (r.overlays.reloading ? "+reload" : "") + (r.overlays.shooting ? "+shoot" : "")).join(", ")}`;
  (window as unknown as { __lab: unknown }).__lab = { states: rigs.map((r) => ({ code: r.code, state: r.state, overlays: r.overlays })) };
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
