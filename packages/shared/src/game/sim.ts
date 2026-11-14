import { CollisionWorld } from "./collision.js";
import { MOVE, TICK_DT, createPlayerState, eyeHeight, stepPlayer, type PlayerState } from "./movement.js";
import { clamp, DEG, viewDir, type Vec3 } from "./math.js";
import {
  beginSwitchTo,
  createWeaponState,
  fireBlockReason,
  fireWeapon,
  isReloading,
  startReload,
  updateWeapon,
  type ShotResult,
  type WeaponState,
  type WeaponStats,
} from "./weapons.js";

/** Duração de um tick em ms. O tempo de um comando é `seq * TICK_MS` (determinístico nos dois lados). */
export const TICK_MS = 1000 / 60;

/**
 * Comando do jogador para UM tick. É tudo que o cliente envia ao servidor:
 * intenções (teclas) e mira. Posição, munição, dano e acertos são sempre calculados pelo servidor.
 */
export interface PlayerCommand {
  /** Sequência contínua, começa em 1 a cada partida. */
  seq: number;
  forward: number;
  right: number;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  aim: boolean;
  fire: boolean;
  /** Pedido de recarga neste tick (borda). */
  reload: boolean;
  /** Slot desejado (0..2). */
  slot: number;
  yaw: number;
  pitch: number;
  /** Tick do servidor que o cliente estava vendo (interpolação), para compensação de latência. */
  viewTick: number;
}

/** Estado completo de um combatente (o que é previsto no cliente e reconciliado com o servidor). */
export interface Combatant {
  move: PlayerState;
  weapons: WeaponState[];
  slot: number;
  health: number;
  alive: boolean;
  /** Último `seq` aplicado. */
  seq: number;
}

export const MAX_HEALTH = 100;

export function createCombatant(spawn: Vec3, loadout: WeaponStats[], seedBase: number): Combatant {
  return {
    move: createPlayerState({ ...spawn, y: spawn.y + 0.05 }),
    weapons: loadout.map((w, i) => createWeaponState(w, 0, (seedBase + i * 7919) >>> 0)),
    slot: 0,
    health: MAX_HEALTH,
    alive: true,
    seq: 0,
  };
}

export function cloneCombatant(c: Combatant): Combatant {
  return {
    move: { ...c.move, pos: { ...c.move.pos }, vel: { ...c.move.vel } },
    weapons: c.weapons.map((w) => ({ ...w })),
    slot: c.slot,
    health: c.health,
    alive: c.alive,
    seq: c.seq,
  };
}

export function combatantEye(c: Combatant): Vec3 {
  return { x: c.move.pos.x, y: c.move.pos.y + eyeHeight(c.move), z: c.move.pos.z };
}

export interface CommandContext {
  world: CollisionWorld;
  loadout: WeaponStats[];
  /** Congelado (início de round): não anda nem atira, só olha. */
  frozen: boolean;
}

export interface CommandOutcome {
  /** Disparo efetuado neste tick (direções já com dispersão), com a origem (olho). */
  shot: (ShotResult & { origin: Vec3; weapon: WeaponStats }) | null;
  reloadStarted: boolean;
  switched: boolean;
  dryFire: boolean;
}

/** Comando sanitizado: valores fora da faixa são cortados; NaN/Infinity viram 0. */
export function sanitizeCommand(cmd: PlayerCommand): PlayerCommand {
  const f = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? clamp(v, lo, hi) : 0);
  return {
    seq: cmd.seq,
    forward: Math.sign(f(cmd.forward, -1, 1)),
    right: Math.sign(f(cmd.right, -1, 1)),
    jump: !!cmd.jump,
    crouch: !!cmd.crouch,
    sprint: !!cmd.sprint,
    aim: !!cmd.aim,
    fire: !!cmd.fire,
    reload: !!cmd.reload,
    slot: Math.trunc(f(cmd.slot, 0, 2)),
    // yaw é livre (gira infinitamente), mas normalizado para não acumular números enormes.
    yaw: Number.isFinite(cmd.yaw) ? Math.atan2(Math.sin(cmd.yaw), Math.cos(cmd.yaw)) : 0,
    pitch: f(cmd.pitch, -89 * DEG, 89 * DEG),
    viewTick: Number.isFinite(cmd.viewTick) ? Math.trunc(cmd.viewTick) : 0,
  };
}

/**
 * Aplica um comando a um combatente. Mesmo código no servidor (autoritativo) e no cliente
 * (predição). Não resolve dano: quem chama faz o raycast contra os outros jogadores.
 */
export function applyCommand(c: Combatant, cmd: PlayerCommand, ctx: CommandContext): CommandOutcome {
  const out: CommandOutcome = { shot: null, reloadStarted: false, switched: false, dryFire: false };
  c.seq = cmd.seq;
  const now = cmd.seq * TICK_MS;
  if (!c.alive) return out;

  const loadout = ctx.loadout;
  // Troca de arma.
  const wantSlot = Math.min(cmd.slot, loadout.length - 1);
  if (wantSlot !== c.slot && wantSlot >= 0) {
    c.slot = wantSlot;
    beginSwitchTo(loadout[wantSlot]!, c.weapons[wantSlot]!, now);
    out.switched = true;
  }
  const stats = loadout[c.slot]!;
  const ws = c.weapons[c.slot]!;

  if (cmd.reload && startReload(stats, ws, now)) out.reloadStarted = true;

  const canAim = !c.move.sprinting && now >= ws.switchEndsAt && !isReloading(ws, now);
  const aiming = cmd.aim && canAim;
  stepPlayer(
    c.move,
    {
      forward: ctx.frozen ? 0 : cmd.forward,
      right: ctx.frozen ? 0 : cmd.right,
      jump: ctx.frozen ? false : cmd.jump,
      crouch: cmd.crouch,
      sprint: ctx.frozen ? false : cmd.sprint,
      aiming,
      yaw: cmd.yaw,
      pitch: cmd.pitch,
      weaponSpeedMult: stats.moveSpeedMult,
    },
    ctx.world,
    TICK_DT,
  );

  for (let i = 0; i < c.weapons.length; i++) updateWeapon(loadout[i]!, c.weapons[i]!, now, TICK_MS);
  if (!cmd.fire) ws.triggerReleased = true;
  if (cmd.fire && !ctx.frozen) {
    const block = fireBlockReason(stats, ws, now, c.move.sprinting);
    if (!block) {
      const speed = Math.hypot(c.move.vel.x, c.move.vel.z);
      const origin = combatantEye(c);
      const shot = fireWeapon(stats, ws, now, viewDir(cmd.yaw, cmd.pitch), {
        aiming,
        moveRatio: Math.min(1, speed / MOVE.sprintSpeed),
        airborne: !c.move.onGround,
        crouched: c.move.crouched,
        sprinting: c.move.sprinting,
      });
      out.shot = { ...shot, origin, weapon: stats };
    } else if (block === "empty" && ws.triggerReleased) {
      ws.triggerReleased = false;
      out.dryFire = true;
      if (startReload(stats, ws, now)) out.reloadStarted = true;
    }
  }
  return out;
}

/** Recoloca o combatente no spawn com vida e munição cheias (início de round). */
export function resetCombatant(c: Combatant, spawn: Vec3, loadout: WeaponStats[]) {
  c.move = createPlayerState({ ...spawn, y: spawn.y + 0.05 });
  c.health = MAX_HEALTH;
  c.alive = true;
  c.slot = 0;
  const now = c.seq * TICK_MS;
  c.weapons.forEach((w, i) => {
    const s = loadout[i]!;
    w.ammo = s.magazineSize;
    w.reserve = s.reserveAmmo;
    w.reloadEndsAt = null;
    w.heat = 0;
    w.switchEndsAt = now;
    w.nextFireAt = now;
    w.triggerReleased = true;
  });
}
