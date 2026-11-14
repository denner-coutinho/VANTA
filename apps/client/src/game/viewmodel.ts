import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { CATEGORY_TUNING, type WeaponStats } from "@vanta/shared";

/**
 * Arma em primeira pessoa: modelos procedurais por categoria e animações
 * (balanço ao andar, corrida, mira, disparo com recuo físico, recarga e troca de arma).
 * Renderizada numa cena própria por cima do mundo, para não atravessar paredes.
 */
export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
  private root = new THREE.Group();
  private gun = new THREE.Group();
  private mag: THREE.Object3D | null = null;
  private flash: THREE.Mesh;
  private flashLight: THREE.PointLight;
  private models = new Map<string, { group: THREE.Group; mag: THREE.Object3D; muzzle: THREE.Vector3; adsOffset: THREE.Vector3 }>();
  private current: string | null = null;
  private mats: THREE.Material[] = [];
  private geos: THREE.BufferGeometry[] = [];

  // Estado de animação
  private kick = 0;
  private kickVel = 0;
  private kickYaw = 0;
  private bobT = 0;
  private sway = new THREE.Vector2();
  private adsBlend = 0;
  private sprintBlend = 0;
  private flashT = 0;

  constructor(accent = "#287BFF") {
    this.scene.add(this.root);
    this.root.add(this.gun);
    this.scene.add(new THREE.HemisphereLight(0x8899cc, 0x111122, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(-1, 2, 1);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(accent, 1.2);
    rim.position.set(1, 0.5, -1);
    this.scene.add(rim);

    const flashTex = this.flashTexture();
    const flashMat = new THREE.MeshBasicMaterial({ map: flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), flashMat);
    this.flash.visible = false;
    this.flashLight = new THREE.PointLight(0xffb070, 0, 3);
    this.gun.add(this.flash, this.flashLight);
    this.mats.push(flashMat);
    this.geos.push(this.flash.geometry);
    this.accent = accent;
  }
  private accent: string;

  private flashTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(64, 64, 2, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,230,1)");
    grd.addColorStop(0.25, "rgba(255,190,90,.9)");
    grd.addColorStop(1, "rgba(255,120,40,0)");
    g.fillStyle = grd;
    for (let i = 0; i < 6; i++) {
      g.save();
      g.translate(64, 64);
      g.rotate((i / 6) * Math.PI * 2);
      g.beginPath();
      g.moveTo(0, -6); g.lineTo(60, 0); g.lineTo(0, 6);
      g.fill();
      g.restore();
    }
    g.beginPath(); g.arc(64, 64, 26, 0, Math.PI * 2); g.fill();
    return new THREE.CanvasTexture(c);
  }

  /** Cria (uma vez) o modelo de cada arma do loadout. */
  prepare(weapons: WeaponStats[]) {
    for (const w of weapons) if (!this.models.has(w.code)) this.models.set(w.code, this.buildModel(w));
  }

  private buildModel(w: WeaponStats) {
    const metal = new THREE.MeshStandardMaterial({ color: 0x1e2433, metalness: 0.8, roughness: 0.35 });
    const polymer = new THREE.MeshStandardMaterial({ color: 0x2c3448, metalness: 0.2, roughness: 0.7 });
    const accent = new THREE.MeshStandardMaterial({ color: this.accent, emissive: this.accent, emissiveIntensity: 1.4 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a1020, metalness: 0.9, roughness: 0.05, emissive: this.accent, emissiveIntensity: 0.25 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x151821, roughness: 0.9 });
    this.mats.push(metal, polymer, accent, glass, glove);
    const g = new THREE.Group();
    const b = (w_: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, r = 0.006) => {
      const geo = new RoundedBoxGeometry(w_, h, d, 2, r);
      this.geos.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    const cyl = (r: number, len: number, mat: THREE.Material, x: number, y: number, z: number) => {
      const geo = new THREE.CylinderGeometry(r, r, len, 14);
      this.geos.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = Math.PI / 2;
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };

    let mag: THREE.Object3D;
    let muzzleZ: number;
    let sightY = 0.06;
    switch (w.category) {
      case "PISTOL": {
        b(0.035, 0.04, 0.2, metal, 0, 0.03, -0.05);
        b(0.032, 0.11, 0.045, polymer, 0, -0.035, 0.02).rotation.x = -0.25;
        b(0.036, 0.006, 0.17, accent, 0, 0.052, -0.05, 0.002);
        mag = b(0.026, 0.06, 0.03, metal, 0, -0.09, 0.03);
        muzzleZ = -0.16;
        sightY = 0.055;
        break;
      }
      case "SMG": {
        b(0.045, 0.07, 0.3, metal, 0, 0.02, -0.08);
        b(0.04, 0.1, 0.045, polymer, 0, -0.05, 0.02).rotation.x = -0.2;
        b(0.03, 0.05, 0.16, polymer, 0, 0.0, 0.16);
        cyl(0.012, 0.08, metal, 0, 0.03, -0.27);
        b(0.047, 0.008, 0.2, accent, 0, 0.058, -0.08, 0.002);
        b(0.025, 0.03, 0.06, glass, 0, 0.075, -0.04);
        mag = b(0.03, 0.14, 0.04, metal, 0, -0.08, -0.08);
        muzzleZ = -0.31;
        sightY = 0.09;
        break;
      }
      case "SNIPER": {
        b(0.05, 0.08, 0.5, metal, 0, 0.02, -0.12);
        cyl(0.013, 0.42, metal, 0, 0.03, -0.55);
        b(0.045, 0.1, 0.05, polymer, 0, -0.05, 0.06).rotation.x = -0.25;
        b(0.04, 0.09, 0.22, polymer, 0, -0.005, 0.24);
        cyl(0.024, 0.24, metal, 0, 0.1, -0.12);
        cyl(0.026, 0.01, glass, 0, 0.1, -0.245);
        b(0.052, 0.008, 0.3, accent, 0, 0.062, -0.15, 0.002);
        mag = b(0.035, 0.07, 0.07, metal, 0, -0.05, -0.08);
        muzzleZ = -0.77;
        sightY = 0.1;
        break;
      }
      case "SHOTGUN": {
        b(0.05, 0.07, 0.4, metal, 0, 0.02, -0.1);
        cyl(0.016, 0.34, metal, 0, 0.04, -0.42);
        cyl(0.017, 0.3, polymer, 0, 0.0, -0.36);
        b(0.045, 0.1, 0.05, polymer, 0, -0.05, 0.05).rotation.x = -0.25;
        b(0.04, 0.08, 0.2, polymer, 0, -0.005, 0.22);
        b(0.052, 0.008, 0.25, accent, 0, 0.058, -0.1, 0.002);
        mag = b(0.042, 0.04, 0.12, polymer, 0, -0.01, -0.3);
        muzzleZ = -0.6;
        sightY = 0.065;
        break;
      }
      default: {
        // Rifle de assalto
        b(0.05, 0.075, 0.42, metal, 0, 0.02, -0.1);
        cyl(0.012, 0.18, metal, 0, 0.03, -0.39);
        b(0.055, 0.06, 0.2, polymer, 0, 0.015, -0.26);
        b(0.042, 0.1, 0.045, polymer, 0, -0.055, 0.04).rotation.x = -0.25;
        b(0.04, 0.075, 0.2, polymer, 0, 0.0, 0.2);
        b(0.03, 0.035, 0.08, glass, 0, 0.08, -0.06);
        b(0.057, 0.008, 0.26, accent, 0, 0.06, -0.12, 0.002);
        mag = b(0.03, 0.15, 0.055, metal, 0, -0.09, -0.12);
        mag.rotation.x = 0.2;
        muzzleZ = -0.49;
        sightY = 0.098;
      }
    }
    // Mãos/luvas segurando.
    b(0.05, 0.05, 0.1, glove, 0.0, -0.06, 0.05).rotation.x = -0.4;
    if (w.category !== "PISTOL") b(0.05, 0.045, 0.1, glove, -0.01, -0.025, -0.25);
    g.traverse((o) => (o.renderOrder = 1));
    return { group: g, mag, muzzle: new THREE.Vector3(0, 0.03, muzzleZ), adsOffset: new THREE.Vector3(0, -sightY, 0) };
  }

  equip(code: string) {
    const m = this.models.get(code);
    if (!m) return;
    if (this.current) this.gun.remove(this.models.get(this.current)!.group);
    this.gun.add(m.group);
    this.mag = m.mag;
    this.current = code;
    this.flash.position.copy(m.muzzle);
    this.flashLight.position.copy(m.muzzle);
  }

  onShot(recoil: number) {
    this.kickVel += 0.6 + recoil * 0.35;
    this.kickYaw = (Math.random() - 0.5) * recoil * 0.02;
    this.flashT = 0.05;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
  }

  setAspect(a: number) {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param reloadP progresso da recarga 0..1 (ou null)
   * @param switchP progresso da troca 0..1 (ou null)
   */
  update(dt: number, s: { speed: number; onGround: boolean; aiming: boolean; sprinting: boolean; reloadP: number | null; switchP: number | null; mouse: { x: number; y: number }; category: WeaponStats["category"]; hideForScope: boolean }) {
    const ads = CATEGORY_TUNING[s.category];
    this.adsBlend += ((s.aiming ? 1 : 0) - this.adsBlend) * Math.min(1, dt * (1000 / ads.adsTimeMs) * 2.2);
    this.sprintBlend += ((s.sprinting ? 1 : 0) - this.sprintBlend) * Math.min(1, dt * 8);

    // Recuo como mola amortecida.
    // Integra em sub-passos fixos: estável mesmo com FPS baixo.
    for (let left = dt; left > 0; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240);
      this.kickVel += (-this.kick * 260 - this.kickVel * 22) * h;
      this.kick += this.kickVel * h;
    }

    // Balanço ao andar.
    const moving = s.onGround ? Math.min(1, s.speed / 6.6) : 0;
    this.bobT += dt * (6 + s.speed * 1.4) * (moving > 0.05 ? 1 : 0);
    const bobAmp = moving * (1 - this.adsBlend * 0.85);
    const bobX = Math.sin(this.bobT) * 0.012 * bobAmp;
    const bobY = Math.abs(Math.cos(this.bobT)) * 0.012 * bobAmp;

    // Atraso de mira ao mover o mouse (sway).
    this.sway.x += (-s.mouse.x * 0.0004 - this.sway.x) * Math.min(1, dt * 10);
    this.sway.y += (s.mouse.y * 0.0004 - this.sway.y) * Math.min(1, dt * 10);

    const m = this.current ? this.models.get(this.current) : null;
    const hip = new THREE.Vector3(0.16, -0.15, -0.42);
    const adsPos = new THREE.Vector3(0, (m?.adsOffset.y ?? -0.08) , -0.3);
    const pos = hip.lerp(adsPos, this.adsBlend);

    let rotX = 0, rotY = 0, rotZ = 0, lower = 0;
    rotX += this.kick * 0.9;
    pos.z += this.kick * 0.12;
    rotY += this.kickYaw * this.kick * 10;
    // Corrida: arma abaixada e girada.
    rotX -= this.sprintBlend * 0.35;
    rotY += this.sprintBlend * 0.6;
    pos.x -= this.sprintBlend * 0.05;
    pos.y -= this.sprintBlend * 0.04;
    // Recarga: inclina a arma e derruba/reencaixa o carregador.
    if (s.reloadP !== null) {
      const p = s.reloadP;
      const tilt = Math.sin(Math.min(1, p * 1.2) * Math.PI);
      rotZ += tilt * 0.6;
      rotX += tilt * 0.25;
      pos.y -= tilt * 0.04;
      if (this.mag) {
        const out = p < 0.5 ? Math.min(1, p / 0.25) : Math.max(0, 1 - (p - 0.5) / 0.3);
        this.mag.position.y = this.magBaseY() - out * 0.18;
        (this.mag as THREE.Mesh).visible = !(p > 0.25 && p < 0.5);
      }
    } else if (this.mag) {
      this.mag.position.y = this.magBaseY();
      this.mag.visible = true;
    }
    // Troca: abaixa e sobe.
    if (s.switchP !== null) lower = Math.sin((1 - s.switchP) * Math.PI * 0.5);

    this.root.position.set(pos.x + bobX + this.sway.x, pos.y - bobY + this.sway.y - lower * 0.3, pos.z);
    this.root.rotation.set(rotX - lower * 0.8, rotY, rotZ + bobX * 2);
    this.root.visible = !s.hideForScope;

    this.flashT -= dt;
    this.flash.visible = this.flashT > 0 && !s.hideForScope;
    this.flashLight.intensity = this.flashT > 0 ? 4 : 0;
  }

  private magBaseY() {
    const m = this.current ? this.models.get(this.current) : null;
    return m ? (m.mag.userData.baseY ??= m.mag.position.y) : 0;
  }

  dispose() {
    this.mats.forEach((m) => m.dispose());
    this.geos.forEach((g) => g.dispose());
  }
}
