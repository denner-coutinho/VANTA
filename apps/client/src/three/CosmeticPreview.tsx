import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { CharacterSkinMaterial, StoreItemView, WeaponSkinMaterial, WeaponStats } from "@vanta/shared";
import { CharacterRig } from "./characters";
import { ViewModel } from "../game/viewmodel";

/**
 * Prévia 3D de um cosmético, com os mesmos modelos usados em jogo:
 * skin de operador no CharacterRig animado; skin de arma no modelo do ViewModel (girando).
 */
export function CosmeticPreview({ item, weapons }: { item: StoreItemView | null; weapons: Map<string, WeaponStats> | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const key = item ? `${item.id}:${weapons ? "w" : ""}` : "none";

  useEffect(() => {
    const el = host.current;
    if (!el || !item?.target || !item.material) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0x8899cc, 0x0a0c14, 1.6));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(2, 3, 4);
    scene.add(keyLight);
    const rim = new THREE.DirectionalLight(0x6f9bff, 1.4);
    rim.position.set(-3, 2, -3);
    scene.add(rim);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);

    let rig: CharacterRig | null = null;
    let vm: ViewModel | null = null;
    const pivot = new THREE.Group();
    scene.add(pivot);

    if (item.target.kind === "character") {
      rig = new CharacterRig(item.target.code, { detail: "high", skin: item.material as unknown as CharacterSkinMaterial });
      pivot.add(rig.root);
      camera.position.set(0, 1.15, 4.6);
      camera.lookAt(0, 0.95, 0);
    } else {
      const stats = weapons?.get(item.target.code);
      if (!stats) {
        renderer.dispose();
        el.removeChild(renderer.domElement);
        return;
      }
      vm = new ViewModel();
      vm.setSkins({ [stats.code]: item.material as unknown as WeaponSkinMaterial });
      vm.prepare([stats]);
      const g = vm.getModel(stats.code)!;
      // Esconde as mãos (luvas) do modelo de 1ª pessoa: na prévia só a arma.
      g.traverse((o) => {
        o.renderOrder = 0;
        if (o.name === "hand") o.visible = false;
      });
      const box = new THREE.Box3().setFromObject(g);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      g.position.sub(center);
      const holder = new THREE.Group();
      holder.add(g);
      holder.scale.setScalar(1.6 / Math.max(size.x, size.y, size.z));
      pivot.add(holder);
      camera.position.set(0, 0.25, 2.6);
      camera.lookAt(0, 0, 0);
    }

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      pivot.rotation.y += dt * 0.6;
      rig?.update(dt, { speed: 0, sprinting: false, crouch: 0, onGround: true, alive: true, reloading: false, pitch: 0 });
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    el.dataset.ready = "true";

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      rig?.dispose();
      vm?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      delete el.dataset.ready;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) return <div className="cosmetic-preview muted">Prévia 3D indisponível (WebGL desativado).</div>;
  return <div ref={host} className="cosmetic-preview" data-testid="cosmetic-preview" aria-hidden />;
}

/** Amostra de cores para os cartões da loja (sem 3D). */
export function swatchBackground(item: StoreItemView): string {
  const m = item.material as Record<string, string> | null;
  if (!m) return "linear-gradient(135deg, #1a2030, #2a3248)";
  const [a, b, c] = item.type === "WEAPON_SKIN" ? [m.body, m.polymer, m.glow] : [m.armor, m.plate, m.glow];
  return `linear-gradient(135deg, ${a} 0%, ${b} 62%, ${c} 100%)`;
}
