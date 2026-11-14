import { CollisionWorld, playerBox } from "./collision.js";
import { clamp, type Vec3 } from "./math.js";

/** Frequência fixa da simulação. Cliente e servidor avançam exatamente nos mesmos passos. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

export const MOVE = {
  halfWidth: 0.3,
  standHeight: 1.8,
  crouchHeight: 1.2,
  eyeStand: 1.62,
  eyeCrouch: 1.05,
  walkSpeed: 4.8,
  sprintSpeed: 6.6,
  crouchSpeed: 2.4,
  adsSpeedMult: 0.62,
  groundAccel: 70,
  airAccel: 14,
  friction: 11,
  gravity: 21,
  jumpVelocity: 6.6,
  maxFallSpeed: 40,
  stepHeight: 0.42,
  /** Sprint só para frente (ângulo máximo em relação à direção da visão). */
  sprintMaxAngle: 0.8,
} as const;

export interface MoveInput {
  /** −1..1 (W/S) */
  forward: number;
  /** −1..1 (D/A) */
  right: number;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  aiming: boolean;
  yaw: number;
  pitch: number;
  /** Multiplicador de velocidade da arma em mãos (do banco: Weapon.moveSpeedMult). */
  weaponSpeedMult: number;
}

export interface PlayerState {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  crouched: boolean;
  /** 0 (em pé) → 1 (agachado), suaviza a altura dos olhos. */
  crouchBlend: number;
  sprinting: boolean;
  /** Tempo restante em que um novo pulo é bloqueado (evita “bunny hop” abusivo). */
  jumpCooldown: number;
}

export function createPlayerState(pos: Vec3): PlayerState {
  return { pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, onGround: false, crouched: false, crouchBlend: 0, sprinting: false, jumpCooldown: 0 };
}

export function eyeHeight(s: PlayerState): number {
  return MOVE.eyeStand + (MOVE.eyeCrouch - MOVE.eyeStand) * s.crouchBlend;
}

export function playerHeight(s: PlayerState): number {
  return s.crouched ? MOVE.crouchHeight : MOVE.standHeight;
}

/** Velocidade horizontal máxima permitida para o estado atual (usada também pela validação anti speed hack). */
export function maxGroundSpeed(input: Pick<MoveInput, "sprint" | "crouch" | "aiming" | "weaponSpeedMult">, crouched: boolean, sprinting: boolean): number {
  let speed: number = MOVE.walkSpeed;
  if (crouched) speed = MOVE.crouchSpeed;
  else if (sprinting) speed = MOVE.sprintSpeed;
  if (input.aiming && !sprinting) speed *= MOVE.adsSpeedMult;
  return speed * clamp(input.weaponSpeedMult, 0.7, 1.15);
}

/**
 * Avança o jogador um tick. Função pura sobre o estado (muta `s`), determinística:
 * o servidor autoritativo (Fase 3) roda exatamente este código com os inputs recebidos.
 */
export function stepPlayer(s: PlayerState, input: MoveInput, world: CollisionWorld, dt = TICK_DT): void {
  s.jumpCooldown = Math.max(0, s.jumpCooldown - dt);

  // Agachar / levantar (só levanta se houver espaço acima).
  if (input.crouch) s.crouched = true;
  else if (s.crouched && !world.collides(playerBox(s.pos, MOVE.halfWidth - 0.01, MOVE.standHeight))) s.crouched = false;
  s.crouchBlend += ((s.crouched ? 1 : 0) - s.crouchBlend) * Math.min(1, dt * 14);

  // Direção desejada no plano.
  const fwd = clamp(input.forward, -1, 1);
  const rgt = clamp(input.right, -1, 1);
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  let wx = -sin * fwd + cos * rgt;
  let wz = -cos * fwd - sin * rgt;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) {
    wx /= wl;
    wz /= wl;
  }
  const moveAngle = wl > 0 ? Math.atan2(rgt, fwd) : 0;
  s.sprinting = input.sprint && !s.crouched && !input.aiming && fwd > 0 && Math.abs(moveAngle) <= MOVE.sprintMaxAngle;
  const target = maxGroundSpeed(input, s.crouched, s.sprinting);

  // Atrito no chão.
  if (s.onGround) {
    const sp = Math.hypot(s.vel.x, s.vel.z);
    if (sp > 0) {
      const drop = sp * MOVE.friction * dt;
      const k = Math.max(0, sp - drop) / sp;
      s.vel.x *= k;
      s.vel.z *= k;
    }
  }

  // Aceleração (estilo “accelerate” clássico de FPS: sem ultrapassar a velocidade alvo).
  const wishLen = Math.min(1, Math.hypot(wx, wz));
  if (wishLen > 0) {
    const dx = wx / (Math.hypot(wx, wz) || 1);
    const dz = wz / (Math.hypot(wx, wz) || 1);
    const wishSpeed = target * wishLen;
    const current = s.vel.x * dx + s.vel.z * dz;
    const addSpeed = wishSpeed - current;
    if (addSpeed > 0) {
      const accel = (s.onGround ? MOVE.groundAccel : MOVE.airAccel) * dt * wishSpeed;
      const a = Math.min(accel, addSpeed);
      s.vel.x += dx * a;
      s.vel.z += dz * a;
    }
  }
  // Limite duro de velocidade horizontal (nada de acumular velocidade no ar).
  const hs = Math.hypot(s.vel.x, s.vel.z);
  const hardCap = MOVE.sprintSpeed * 1.15;
  if (hs > hardCap) {
    s.vel.x *= hardCap / hs;
    s.vel.z *= hardCap / hs;
  }

  // Pulo.
  if (input.jump && s.onGround && s.jumpCooldown <= 0 && !s.crouched) {
    s.vel.y = MOVE.jumpVelocity;
    s.onGround = false;
    s.jumpCooldown = 0.25;
    // Pular penaliza levemente a velocidade horizontal (desestimula pular atirando).
    s.vel.x *= 0.92;
    s.vel.z *= 0.92;
  }

  s.vel.y = Math.max(-MOVE.maxFallSpeed, s.vel.y - MOVE.gravity * dt);

  moveAndCollide(s, world, dt);
}

/** Move eixo por eixo resolvendo colisões; inclui subida de degraus pequenos. */
function moveAndCollide(s: PlayerState, world: CollisionWorld, dt: number) {
  const h = playerHeight(s);
  const hw = MOVE.halfWidth;
  // Sub-passos evitam atravessar paredes finas em alta velocidade.
  const maxMove = Math.max(Math.abs(s.vel.x), Math.abs(s.vel.y), Math.abs(s.vel.z)) * dt;
  const steps = Math.max(1, Math.ceil(maxMove / 0.2));
  const sdt = dt / steps;
  const wasOnGround = s.onGround;
  s.onGround = false;

  for (let i = 0; i < steps; i++) {
    for (const axis of ["x", "z"] as const) {
      const delta = s.vel[axis] * sdt;
      if (delta === 0) continue;
      s.pos[axis] += delta;
      if (world.collides(playerBox(s.pos, hw, h))) {
        // Tenta subir degrau.
        const lifted = { ...s.pos, y: s.pos.y + MOVE.stepHeight };
        if ((wasOnGround || s.onGround) && !world.collides(playerBox(lifted, hw, h))) {
          s.pos.y = lifted.y;
          continue;
        }
        s.pos[axis] -= delta;
        s.vel[axis] = 0;
      }
    }
    const dy = s.vel.y * sdt;
    s.pos.y += dy;
    if (world.collides(playerBox(s.pos, hw, h))) {
      s.pos.y -= dy;
      if (s.vel.y < 0) s.onGround = true;
      s.vel.y = 0;
    }
  }
  // Assenta no chão após degrau (snap curto para não “flutuar” descendo rampas de degraus).
  if (!s.onGround && wasOnGround && s.vel.y <= 0) {
    const probe = { ...s.pos, y: s.pos.y - MOVE.stepHeight };
    if (!world.collides(playerBox(probe, hw, h))) {
      // nada abaixo: está caindo de verdade
    } else {
      let lo = probe.y;
      let hi = s.pos.y;
      for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) / 2;
        if (world.collides(playerBox({ ...s.pos, y: mid }, hw, h))) lo = mid;
        else hi = mid;
      }
      s.pos.y = hi;
      s.onGround = true;
    }
  }
  if (!s.onGround) {
    // Verificação de chão com tolerância mínima.
    if (world.collides(playerBox({ ...s.pos, y: s.pos.y - 0.02 }, hw, h)) && s.vel.y <= 0) s.onGround = true;
  }
}
