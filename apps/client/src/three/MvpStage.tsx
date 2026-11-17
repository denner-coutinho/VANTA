import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { CharacterSkinMaterial } from "@vanta/shared";
import { CharacterRig } from "./characters";

/**
 * Palco do MVP: o operador do MVP (o mesmo rig animado da partida, com a skin equipada)
 * girando devagar, com disparos de comemoração. Nada de modelo estático.
 */
export function MvpStage({ character, skin, accent }: { character: string; skin: CharacterSkinMaterial | null; accent: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
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
    scene.add(new THREE.HemisphereLight(0x8899cc, 0x0a0c14, 1.5));
    const key = new THREE.DirectionalLight(0xffe2a8, 2.4);
    key.position.set(2, 3, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(accent, 2);
    rim.position.set(-3, 2, -3);
    scene.add(rim);
    const disc = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 48), new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.01;
    scene.add(disc);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
    camera.position.set(0, 1.2, 4.4);
    camera.lookAt(0, 0.95, 0);
    const rig = new CharacterRig(character, { detail: "high", skin, accent });
    const pivot = new THREE.Group();
    pivot.add(rig.root);
    scene.add(pivot);

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    let raf = 0;
    let last = performance.now();
    let t = 0;
    let nextShot = 1.2;
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt;
      pivot.rotation.y = Math.sin(t * 0.5) * 0.6 + 0.3;
      if (t > nextShot) {
        rig.shoot();
        nextShot = t + (Math.floor(t) % 3 === 0 ? 0.15 : 1.4);
      }
      disc.scale.setScalar(1 + Math.sin(t * 3) * 0.05);
      rig.update(dt, { speed: 0, sprinting: false, crouch: 0, onGround: true, alive: true, reloading: false, pitch: Math.sin(t * 0.8) * 0.1 });
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    el.dataset.ready = "true";
    return () => {
      cancelAnimationFrame(raf);
      rig.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [character, skin, accent]);

  if (failed) return <div className="mvp-stage muted small">Prévia 3D indisponível.</div>;
  return <div ref={host} className="mvp-stage" data-testid="mvp-stage" aria-hidden />;
}
