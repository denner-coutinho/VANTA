import * as THREE from "three";

/**
 * Avatar procedural de outro jogador (asset original gerado em código), com ciclo de caminhada,
 * agachamento, mira (inclinação do tronco) e queda ao morrer. As proporções seguem as hitboxes
 * do servidor (1,8 m em pé, 1,2 m agachado). Na Fase 4 é trocado por modelos rigados.
 */
export class RemoteAvatar {
  readonly root = new THREE.Group();
  private hips = new THREE.Group();
  private upper = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armGroup = new THREE.Group();
  private mats: THREE.Material[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private walkPhase = 0;
  private deathT = 0;
  private nameTag: THREE.Sprite | null = null;
  private lastPos = new THREE.Vector3();
  private flash: THREE.PointLight;

  constructor(color: string, teamColor: string, name: string | null) {
    const armor = this.mat(new THREE.MeshStandardMaterial({ color: 0x56627c, metalness: 0.3, roughness: 0.5 }));
    const fabric = this.mat(new THREE.MeshStandardMaterial({ color: 0x232a3a, metalness: 0.05, roughness: 0.9 }));
    const accent = this.mat(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.4 }));
    const team = this.mat(new THREE.MeshStandardMaterial({ color: teamColor, emissive: teamColor, emissiveIntensity: 2.2, toneMapped: false }));
    const gun = this.mat(new THREE.MeshStandardMaterial({ color: 0x151a24, metalness: 0.7, roughness: 0.35 }));
    const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const g = new THREE.BoxGeometry(w, h, d);
      this.geos.push(g);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      return mesh;
    };

    this.hips.position.y = 0.9;
    this.root.add(this.hips);
    // Pernas (pivô no quadril).
    for (const [leg, x] of [[this.legL, -0.12], [this.legR, 0.12]] as const) {
      leg.position.set(x, 0, 0);
      leg.add(box(0.15, 0.46, 0.18, fabric, 0, -0.23, 0), box(0.16, 0.46, 0.2, armor, 0, -0.67, 0.01), box(0.17, 0.08, 0.28, armor, 0, -0.86, -0.04));
      this.hips.add(leg);
    }
    // Tronco, cabeça e braços.
    this.hips.add(this.upper);
    this.upper.add(box(0.44, 0.56, 0.26, armor, 0, 0.3, 0), box(0.46, 0.08, 0.28, team, 0, 0.36, 0), box(0.12, 0.2, 0.05, accent, 0, 0.3, -0.15));
    const head = new THREE.Group();
    head.position.y = 0.72;
    head.add(box(0.24, 0.27, 0.27, armor, 0, 0, 0), box(0.2, 0.07, 0.04, team, 0, 0.02, -0.14));
    this.upper.add(head);
    this.armGroup.position.set(0, 0.48, 0);
    this.armGroup.add(
      box(0.1, 0.1, 0.42, fabric, -0.2, -0.05, -0.18),
      box(0.1, 0.1, 0.42, fabric, 0.2, -0.05, -0.18),
      box(0.08, 0.12, 0.7, gun, 0.06, -0.02, -0.42),
      box(0.03, 0.03, 0.06, team, 0.06, 0.06, -0.3),
    );
    this.upper.add(this.armGroup);
    this.flash = new THREE.PointLight(0xffd29a, 0, 4);
    this.flash.position.set(0.06, 0.46, -0.85);
    this.upper.add(this.flash);

    if (name) {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 48;
      const g = c.getContext("2d")!;
      g.font = "600 26px Barlow, sans-serif";
      g.textAlign = "center";
      g.fillStyle = teamColor;
      g.fillText(name, 128, 32);
      const tex = new THREE.CanvasTexture(c);
      const sm = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
      this.mats.push(sm);
      this.nameTag = new THREE.Sprite(sm);
      this.nameTag.scale.set(1.2, 0.22, 1);
      this.nameTag.position.y = 2.15;
      this.nameTag.renderOrder = 10;
      this.root.add(this.nameTag);
    }
  }

  private mat<T extends THREE.Material>(m: T) {
    this.mats.push(m);
    return m;
  }

  /** Atualiza pose. `pos` = pés. */
  update(dt: number, pos: THREE.Vector3, yaw: number, pitch: number, crouch: number, alive: boolean) {
    const moved = this.lastPos.distanceTo(pos);
    const speed = dt > 0 ? Math.min(8, Math.hypot(pos.x - this.lastPos.x, pos.z - this.lastPos.z) / dt) : 0;
    this.lastPos.copy(pos);
    this.root.position.copy(pos);
    this.root.rotation.y = yaw;

    if (!alive) {
      this.deathT = Math.min(1, this.deathT + dt * 2.5);
      this.root.rotation.x = 0;
      this.hips.rotation.x = -this.deathT * 1.45;
      this.hips.position.y = 0.9 - this.deathT * 0.72;
      if (this.nameTag) this.nameTag.visible = false;
      return;
    }
    this.deathT = 0;
    if (this.nameTag) this.nameTag.visible = true;
    if (moved > 3) this.walkPhase = 0; // teleporte (novo round)
    this.walkPhase += dt * speed * 2.1;
    const swing = Math.sin(this.walkPhase) * Math.min(1, speed / 4) * 0.6;
    // Agachado: quadril desce 0,4 m (1,8 → ~1,2 m de altura total) e as pernas dobram.
    this.hips.position.y = 0.9 - crouch * 0.4;
    this.hips.rotation.x = 0;
    this.legL.rotation.x = swing - crouch * 0.9;
    this.legR.rotation.x = -swing - crouch * 0.9;
    this.upper.rotation.x = crouch * 0.25;
    this.armGroup.rotation.x = pitch - crouch * 0.25;
    this.upper.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.03 * Math.min(1, speed / 4);
    this.flash.intensity = Math.max(0, this.flash.intensity - dt * 60);
  }

  muzzleFlash() {
    this.flash.intensity = 6;
  }

  dispose() {
    this.geos.forEach((g) => g.dispose());
    this.mats.forEach((m) => {
      (m as THREE.SpriteMaterial).map?.dispose();
      m.dispose();
    });
    this.root.removeFromParent();
  }
}
