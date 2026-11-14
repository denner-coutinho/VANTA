import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { createOperator } from "./operator";

export type GraphicsQuality = "low" | "medium" | "high" | "ultra";

const QUALITY: Record<GraphicsQuality, { pixelRatio: number; bloom: boolean; shadows: boolean; particles: number }> = {
  low: { pixelRatio: 0.75, bloom: false, shadows: false, particles: 60 },
  medium: { pixelRatio: 1, bloom: true, shadows: false, particles: 140 },
  high: { pixelRatio: 1.5, bloom: true, shadows: true, particles: 260 },
  ultra: { pixelRatio: 2, bloom: true, shadows: true, particles: 420 },
};

/** Cena 3D do menu: operador em plataforma holográfica, com bloom, partículas e luz volumétrica. */
export function MenuScene({ accent = "#287BFF", quality = "high" }: { accent?: string; quality?: GraphicsQuality }) {
  const host = useRef<HTMLDivElement>(null);
  const accentRef = useRef<(hex: string) => void>(() => undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = host.current!;
    const q = QUALITY[quality];
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      el.dataset.webgl = "unsupported";
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = q.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x090b12, 0.09);
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 60);
    const camBase = new THREE.Vector3(-0.15, 1.45, 5.2);
    camera.position.copy(camBase);

    // Iluminação
    scene.add(new THREE.HemisphereLight(0x5a6a90, 0x05060a, 1.1));
    const front = new THREE.DirectionalLight(0x9fb8ff, 0.9);
    front.position.set(1.5, 2, 5);
    scene.add(front);
    const key = new THREE.SpotLight(0xdfe8ff, 70, 14, 0.5, 0.6, 1.2);
    key.position.set(-2.5, 4.2, 3.5);
    key.target.position.set(0, 1, 0);
    key.castShadow = q.shadows;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0004;
    scene.add(key, key.target);
    const rimA = new THREE.PointLight(0x823bff, 16, 8, 1.6);
    rimA.position.set(1.8, 2.2, -1.6);
    const rimB = new THREE.PointLight(new THREE.Color(accent), 10, 7, 1.6);
    rimB.position.set(-1.8, 1.2, -1.4);
    scene.add(rimA, rimB);

    // Chão e plataforma
    const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), new THREE.MeshStandardMaterial({ color: 0x0b0e17, metalness: 0.8, roughness: 0.35 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(28, 56, 0x287bff, 0x1a2236);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.22;
    grid.position.y = 0.002;
    scene.add(grid);

    const platform = new THREE.Group();
    scene.add(platform);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.05, 0.12, 64), new THREE.MeshStandardMaterial({ color: 0x161c2a, metalness: 0.85, roughness: 0.3 }));
    base.position.y = 0.06;
    base.receiveShadow = true;
    platform.add(base);
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(accent), transparent: true, opacity: 0.95, toneMapped: false });
    const ringMat2 = new THREE.MeshBasicMaterial({ color: 0x823bff, transparent: true, opacity: 0.8, toneMapped: false });
    const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.012, 8, 128), ringMat);
    ring1.rotation.x = Math.PI / 2;
    ring1.position.y = 0.125;
    const ring2 = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.18, 96, 1, 0, Math.PI * 1.4), ringMat2);
    ring2.rotation.x = -Math.PI / 2;
    ring2.position.y = 0.01;
    const ring3 = new THREE.Mesh(new THREE.RingGeometry(1.32, 1.335, 96, 1, 0, Math.PI * 0.6), ringMat);
    ring3.rotation.x = -Math.PI / 2;
    ring3.position.y = 0.01;
    platform.add(ring1, ring2, ring3);

    // Cone de luz volumétrica (shader aditivo barato).
    const coneMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      uniforms: { uColor: { value: new THREE.Color(accent) }, uTime: { value: 0 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
      fragmentShader:
        "uniform vec3 uColor; uniform float uTime; varying vec2 vUv; void main(){ float a = pow(1.0 - vUv.y, 2.6) * 0.10; a *= 0.85 + 0.15*sin(uTime*2.0 + vUv.y*18.0); gl_FragColor = vec4(uColor, a); }",
    });
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 1.0, 3.2, 48, 1, true), coneMat);
    cone.position.y = 1.7;
    scene.add(cone);

    // Partículas holográficas subindo.
    const pCount = q.particles;
    const pPos = new Float32Array(pCount * 3);
    const pSpeed = new Float32Array(pCount);
    for (let i = 0; i < pCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.3 + Math.random() * 1.6;
      pPos.set([Math.cos(a) * r, Math.random() * 3.5, Math.sin(a) * r], i * 3);
      pSpeed[i] = 0.08 + Math.random() * 0.25;
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    const pMat = new THREE.PointsMaterial({ color: new THREE.Color(accent), size: 0.022, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const particles = new THREE.Points(pGeo, pMat);
    scene.add(particles);

    // Estruturas ao fundo (silhuetas de painéis tecnológicos).
    const backMat = new THREE.MeshStandardMaterial({ color: 0x111624, metalness: 0.7, roughness: 0.5 });
    const stripMat = new THREE.MeshBasicMaterial({ color: 0x287bff, toneMapped: false });
    const backGroup = new THREE.Group();
    for (let i = -4; i <= 4; i++) {
      if (Math.abs(i) < 1) continue;
      const h = 2.5 + ((i * 7919) % 5) * 0.5;
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.7, h, 0.5), backMat);
      pillar.position.set(i * 1.25, h / 2, -4.5 - Math.abs(i) * 0.25);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.025, h * 0.5, 0.02), i % 2 ? stripMat : ringMat2);
      strip.position.set(pillar.position.x + 0.2, h * 0.45, pillar.position.z + 0.26);
      backGroup.add(pillar, strip);
    }
    scene.add(backGroup);

    const operator = createOperator(accent);
    scene.add(operator.root);
    accentRef.current = (hex) => {
      operator.setAccent(hex);
      ringMat.color.set(hex);
      pMat.color.set(hex);
      coneMat.uniforms.uColor!.value.set(hex);
      rimB.color.set(hex);
    };

    // Pós-processamento
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    if (q.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.32));
    composer.addPass(new OutputPass());

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      // Em telas estreitas o personagem fica centralizado; em largas, à direita do menu.
      camera.setViewOffset(w, h, w > 900 ? -w * 0.12 : 0, 0, w, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const look = new THREE.Vector2();
    const targetLook = new THREE.Vector2();
    const onMove = (e: PointerEvent) => targetLook.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
    window.addEventListener("pointermove", onMove);

    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      look.lerp(targetLook, 1 - Math.exp(-dt * 3));
      operator.update(dt, t, look);
      ring1.rotation.z = t * 0.4;
      ring2.rotation.z = -t * 0.25;
      ring3.rotation.z = t * 0.6;
      coneMat.uniforms.uTime!.value = t;
      for (let i = 0; i < pCount; i++) {
        let y = pPos[i * 3 + 1]! + pSpeed[i]! * dt;
        if (y > 3.5) y = 0;
        pPos[i * 3 + 1] = y;
      }
      pGeo.attributes.position!.needsUpdate = true;
      camera.position.set(camBase.x + look.x * 0.18 + Math.sin(t * 0.3) * 0.05, camBase.y + look.y * 0.08, camBase.z);
      camera.lookAt(0, 1.15, 0);
      composer.render();
    };
    // Compila os shaders de forma assíncrona (KHR_parallel_shader_compile) para não travar a interface.
    let disposed = false;
    const compiled = renderer
      .compileAsync(scene, camera)
      .catch(() => undefined)
      .then(() => {
        if (disposed) return;
        tick();
        setReady(true);
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      renderer.domElement.remove();
      // Só libera recursos da GPU depois que a compilação assíncrona terminar (evita corrida no StrictMode).
      void compiled.then(() => {
        operator.dispose();
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          const mat = m.material as THREE.Material | THREE.Material[] | undefined;
          (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
        });
        composer.dispose();
        renderer.dispose();
      });
    };
  }, [quality]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => accentRef.current(accent), [accent]);

  return <div ref={host} className="menu-scene" data-ready={ready} aria-hidden />;
}
