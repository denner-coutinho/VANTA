import * as THREE from "three";
import type { Vec3 } from "@vanta/shared";

/** Efeitos com pool fixo (sem alocar durante o combate): faíscas de impacto, marcas de tiro e rastros. */
export class Effects {
  readonly group = new THREE.Group();
  private sparks: Array<{ mesh: THREE.Points; vel: Float32Array; life: number }> = [];
  private decals: THREE.Mesh[] = [];
  private decalIdx = 0;
  private tracers: Array<{ line: THREE.Line; life: number }> = [];
  private sparkMat = new THREE.PointsMaterial({ color: 0xffc070, size: 0.05, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  private decalMat: THREE.MeshBasicMaterial;
  private decalGeo = new THREE.CircleGeometry(0.045, 10);
  private tracerMat = new THREE.LineBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.8, toneMapped: false });
  private enemyTracerMat = new THREE.LineBasicMaterial({ color: 0xff3b4e, transparent: true, opacity: 0.9, toneMapped: false });

  constructor(maxDecals = 80) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grd.addColorStop(0, "rgba(0,0,0,1)");
    grd.addColorStop(0.5, "rgba(10,10,15,.8)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    this.decalMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    for (let i = 0; i < maxDecals; i++) {
      const d = new THREE.Mesh(this.decalGeo, this.decalMat);
      d.visible = false;
      this.decals.push(d);
      this.group.add(d);
    }
    for (let i = 0; i < 24; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
      const p = new THREE.Points(geo, this.sparkMat);
      p.visible = false;
      p.frustumCulled = false;
      this.sparks.push({ mesh: p, vel: new Float32Array(8 * 3), life: 0 });
      this.group.add(p);
    }
    for (let i = 0; i < 16; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geo, this.tracerMat);
      line.visible = false;
      line.frustumCulled = false;
      this.tracers.push({ line, life: 0 });
      this.group.add(line);
    }
  }

  impact(point: Vec3, normal: Vec3, decal = true) {
    const s = this.sparks.find((x) => x.life <= 0) ?? this.sparks[0]!;
    const pos = s.mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < 8; i++) {
      pos.setXYZ(i, point.x, point.y, point.z);
      s.vel[i * 3] = normal.x * 2 + (Math.random() - 0.5) * 4;
      s.vel[i * 3 + 1] = normal.y * 2 + Math.random() * 3;
      s.vel[i * 3 + 2] = normal.z * 2 + (Math.random() - 0.5) * 4;
    }
    pos.needsUpdate = true;
    s.life = 0.35;
    s.mesh.visible = true;
    if (!decal) return;
    const d = this.decals[this.decalIdx++ % this.decals.length]!;
    d.position.set(point.x + normal.x * 0.005, point.y + normal.y * 0.005, point.z + normal.z * 0.005);
    d.lookAt(point.x + normal.x, point.y + normal.y, point.z + normal.z);
    d.rotation.z = Math.random() * Math.PI;
    d.visible = true;
  }

  tracer(from: Vec3, to: Vec3, enemy = false) {
    const t = this.tracers.find((x) => x.life <= 0) ?? this.tracers[0]!;
    const pos = t.line.geometry.attributes.position as THREE.BufferAttribute;
    pos.setXYZ(0, from.x, from.y, from.z);
    pos.setXYZ(1, to.x, to.y, to.z);
    pos.needsUpdate = true;
    t.line.material = enemy ? this.enemyTracerMat : this.tracerMat;
    t.life = enemy ? 0.12 : 0.05;
    t.line.visible = true;
  }

  update(dt: number) {
    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const pos = s.mesh.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < 8; i++) {
        s.vel[i * 3 + 1]! -= 12 * dt;
        pos.setXYZ(i, pos.getX(i) + s.vel[i * 3]! * dt, pos.getY(i) + s.vel[i * 3 + 1]! * dt, pos.getZ(i) + s.vel[i * 3 + 2]! * dt);
      }
      pos.needsUpdate = true;
      if (s.life <= 0) s.mesh.visible = false;
    }
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.line.visible = false;
    }
  }

  dispose() {
    this.sparks.forEach((s) => s.mesh.geometry.dispose());
    this.tracers.forEach((t) => t.line.geometry.dispose());
    this.decalGeo.dispose();
    this.decalMat.map?.dispose();
    [this.sparkMat, this.decalMat, this.tracerMat, this.enemyTracerMat].forEach((m) => m.dispose());
  }
}
