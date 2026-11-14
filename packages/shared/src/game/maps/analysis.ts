import { CollisionWorld } from "../collision.js";
import { createPlayerState, eyeHeight, stepPlayer, MOVE } from "../movement.js";
import { raycastWorld } from "../raycast.js";
import type { Vec3 } from "../math.js";
import { gravityAt } from "../sim.js";
import type { MapDefinition } from "./types.js";

/**
 * Ferramentas de análise de mapa (testes e E2E): caminhar com a física real, linha de visão,
 * grafo de navegação em grade e busca de um ponto de contato entre os times.
 */
export class MapAnalyzer {
  readonly world: CollisionWorld;
  constructor(readonly map: MapDefinition, readonly cell = 2) {
    this.world = new CollisionWorld(map.solids.map((s) => s.box));
  }

  /** Anda em linha reta até `to` (no plano) com a física do jogo; devolve a posição final se chegou. */
  walk(from: Vec3, to: { x: number; z: number }, maxTicks = 240): Vec3 | null {
    const st = createPlayerState({ ...from, y: from.y + 0.05 });
    for (let i = 0; i < maxTicks; i++) {
      const dx = to.x - st.pos.x;
      const dz = to.z - st.pos.z;
      if (Math.hypot(dx, dz) < 0.35) return { ...st.pos };
      stepPlayer(st, { forward: 1, right: 0, jump: false, crouch: false, sprint: false, aiming: false, yaw: Math.atan2(-dx, -dz), pitch: 0, weaponSpeedMult: 1 }, this.world, 1 / 60, gravityAt(this.map.zones, st.pos));
    }
    return null;
  }

  /** Linha de visão entre os olhos de dois jogadores em pé. */
  lineOfSight(a: Vec3, b: Vec3): boolean {
    const ea = { x: a.x, y: a.y + MOVE.eyeStand, z: a.z };
    const eb = { x: b.x, y: b.y + MOVE.eyeStand, z: b.z };
    const d = { x: eb.x - ea.x, y: eb.y - ea.y, z: eb.z - ea.z };
    const L = Math.hypot(d.x, d.y, d.z);
    return !raycastWorld(this.world, ea, { x: d.x / L, y: d.y / L, z: d.z / L }, L);
  }

  /** Linha de visão que se mantém com os jogadores até 0,4 m fora do ponto ou 0,4 m mais baixos (não depende de quina nem de degrau). */
  steadySight(a: Vec3, b: Vec3): boolean {
    const offs = [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]] as const;
    for (const [dx, dz] of offs) {
      if (!this.lineOfSight({ x: a.x + dx, y: a.y, z: a.z + dz }, b)) return false;
      if (!this.lineOfSight(a, { x: b.x + dx, y: b.y, z: b.z + dz })) return false;
    }
    // Também do chão ao lado de um degrau (a exploração pode parar em cima de um).
    return this.lineOfSight({ ...a, y: Math.max(0, a.y - 0.4) }, { ...b, y: Math.max(0, b.y - 0.4) });
  }

  private key(x: number, z: number) {
    return `${x},${z}`;
  }

  /** BFS na grade a partir de `start`: cada aresta é validada caminhando de verdade. */
  explore(start: Vec3) {
    const c = this.cell;
    const b = this.map.bounds;
    const snap = (v: number) => Math.round(v / c) * c;
    const first = this.walk(start, { x: snap(start.x), z: snap(start.z) });
    const nodes = new Map<string, { pos: Vec3; prev: string | null; dist: number }>();
    if (!first) return nodes;
    const k0 = this.key(snap(start.x), snap(start.z));
    nodes.set(k0, { pos: first, prev: null, dist: 0 });
    const queue = [k0];
    while (queue.length) {
      const k = queue.shift()!;
      const n = nodes.get(k)!;
      const [x, z] = k.split(",").map(Number) as [number, number];
      for (const [dx, dz] of [[c, 0], [-c, 0], [0, c], [0, -c]] as const) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx <= b.min.x || nx >= b.max.x || nz <= b.min.z || nz >= b.max.z) continue;
        const nk = this.key(nx, nz);
        if (nodes.has(nk)) continue;
        const p = this.walk(n.pos, { x: nx, z: nz }, 90);
        if (!p || Math.abs(p.y - n.pos.y) > 1.2) continue;
        nodes.set(nk, { pos: p, prev: k, dist: n.dist + 1 });
        queue.push(nk);
      }
    }
    return nodes;
  }

  /** Caminho (lista de pontos) do início até o nó `targetKey` de uma exploração. */
  static path(nodes: ReturnType<MapAnalyzer["explore"]>, targetKey: string): Vec3[] {
    const out: Vec3[] = [];
    let k: string | null = targetKey;
    while (k) {
      const n: { pos: Vec3; prev: string | null } = nodes.get(k)!;
      out.unshift(n.pos);
      k = n.prev;
    }
    return out;
  }

  /**
   * Ponto de contato: um nó alcançável pelo time A e o espelhado (alcançável pelo B, por simetria)
   * com linha de visão entre eles, a 8–30 m. Prefere o caminho mais curto. `keyB` é o nó (no lado A)
   * cujo espelho é a posição de B: o caminho de B é `path(nodes, keyB)` espelhado.
   */
  contactPoint(nodes = this.explore(this.map.spawns.A[0]!)) {
    let best: { key: string; keyB: string; a: Vec3; b: Vec3; dist: number; range: number } | null = null;
    const list = [...nodes.entries()].sort((x, y) => x[1].dist - y[1].dist);
    for (const [k, n] of list) {
      if (best && n.dist >= best.dist) break;
      for (const [k2, n2] of list) {
        // B fica no espelho de algum nó de A.
        const bpos = { x: -n2.pos.x, y: n2.pos.y, z: -n2.pos.z };
        const range = Math.hypot(n.pos.x - bpos.x, n.pos.z - bpos.z);
        if (range < 8 || range > 30) continue;
        const total = n.dist + n2.dist;
        if (best && total >= best.dist) break;
        if (!this.steadySight(n.pos, bpos)) continue;
        best = { key: k, keyB: k2, a: n.pos, b: bpos, dist: total, range };
      }
    }
    return best;
  }

  eye(p: Vec3) {
    const s = createPlayerState(p);
    return { x: p.x, y: p.y + eyeHeight(s), z: p.z };
  }
}
