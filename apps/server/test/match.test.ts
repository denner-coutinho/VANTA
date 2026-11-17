import { describe, expect, it } from "vitest";
import { ANIM_FLAG, KILLCAM_MS, SPECTATOR_DELAY_MS, MAP_REGISTRY, MAX_HEALTH, WEAPON_CATALOG, eyeHeight, weaponStatsFromRow, type MatchEventWire, type PlayerCommand, type ServerMessage, type Vec3 } from "@vanta/shared";
import { Match, type MatchResult, type MatchSeat } from "../src/game/match.js";
import { decodeReplay } from "../src/game/replay-recorder.js";

const W = (code: string) => weaponStatsFromRow(WEAPON_CATALOG.find((w) => w.code === code)! as unknown as Record<string, unknown>);
const RIFLE = WEAPON_CATALOG.find((w) => w.category === "ASSAULT_RIFLE")!.code;
const SNIPER = WEAPON_CATALOG.find((w) => w.category === "SNIPER")!.code;

function seat(n: number, loadout = [RIFLE]): MatchSeat {
  return { userId: `u${n}`, username: `Jogador${n}`, color: "#287BFF", characterId: null, character: "RAVEN", loadout: loadout.map(W) };
}

interface Harness {
  m: Match;
  inbox: Map<string, ServerMessage[]>;
  results: MatchResult[];
  clock: { t: number };
  seq: Map<string, number>;
}

function setup(teamSize = 1, loadout = [RIFLE], custom?: ConstructorParameters<typeof Match>[0]["custom"]): Harness {
  const clock = { t: 1_000_000 };
  const results: MatchResult[] = [];
  const teams: [MatchSeat[], MatchSeat[]] = [[], []];
  for (let i = 0; i < teamSize * 2; i++) teams[i < teamSize ? 0 : 1].push(seat(i + 1, loadout));
  const m = new Match({ id: "m1", mode: teamSize === 1 ? "1v1" : teamSize === 2 ? "2v2" : "3v3", mapCode: "NEON_DISTRICT", map: MAP_REGISTRY.NEON_DISTRICT!, teams, seed: 42, custom, onEnd: (r) => results.push(r), now: () => clock.t });
  const inbox = new Map<string, ServerMessage[]>();
  for (const p of m.players) {
    inbox.set(p.userId, []);
    m.attach(p.userId, { send: (msg) => inbox.get(p.userId)!.push(msg) });
  }
  return { m, inbox, results, clock, seq: new Map(m.players.map((p) => [p.userId, 0])) };
}

function idle(over: Partial<PlayerCommand> = {}): Omit<PlayerCommand, "seq"> {
  return { forward: 0, right: 0, jump: false, crouch: false, sprint: false, aim: false, fire: false, reload: false, slot: 0, yaw: 0, pitch: 0, viewTick: 0, ...over };
}

/** Envia um comando por jogador e avança um tick. */
function tick(h: Harness, per: Record<string, Partial<PlayerCommand>> = {}) {
  for (const p of h.m.players) {
    if (!p.conn) continue;
    const s = h.seq.get(p.userId)! + 1;
    h.seq.set(p.userId, s);
    const err = h.m.submitCommands(p.userId, [{ seq: s, ...idle({ viewTick: h.m.tick, ...per[p.userId] }) }]);
    expect(err).toBeNull();
  }
  h.m.step();
  h.clock.t += 1000 / 60;
}

function untilLive(h: Harness) {
  for (const p of h.m.players) h.m.setReady(p.userId);
  for (let i = 0; i < 400 && h.m.phase !== "live"; i++) tick(h);
  expect(h.m.phase).toBe("live");
}

function aimAt(from: Vec3, to: Vec3) {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
}

function place(h: Harness, userId: string, pos: Vec3) {
  const p = h.m.player(userId)!;
  p.c.move.pos = { ...pos };
  p.c.move.vel = { x: 0, y: 0, z: 0 };
}

function events(h: Harness, userId: string): MatchEventWire[] {
  return h.inbox.get(userId)!.flatMap((m) => (m.t === "snap" ? m.ev : []));
}

/** Coloca A e B frente a frente numa rua sem obstáculos (x=5, entre os spawns A e o centro). */
function duelPositions(h: Harness) {
  place(h, "u1", { x: 5, y: 0, z: -23 });
  place(h, "u2", { x: 5, y: 0, z: -15 });
  for (let i = 0; i < 10; i++) tick(h); // assenta no chão
}

function headOf(h: Harness, userId: string): Vec3 {
  const p = h.m.player(userId)!.c.move.pos;
  return { x: p.x, y: p.y + 1.6, z: p.z };
}
function eyeOf(h: Harness, userId: string): Vec3 {
  const c = h.m.player(userId)!.c.move;
  return { x: c.pos.x, y: c.pos.y + eyeHeight(c), z: c.pos.z };
}

describe("partida autoritativa", () => {
  it("aquecimento espera todos prontos; congelamento impede andar e atirar", () => {
    const h = setup();
    expect(h.m.phase).toBe("warmup");
    for (let i = 0; i < 30; i++) tick(h);
    expect(h.m.phase).toBe("warmup");
    h.m.setReady("u1");
    h.m.setReady("u2");
    tick(h);
    expect(h.m.phase).toBe("freeze");
    const z0 = h.m.player("u1")!.c.move.pos.z;
    for (let i = 0; i < 60; i++) tick(h, { u1: { forward: 1, fire: true } });
    expect(h.m.player("u1")!.c.move.pos.z).toBeCloseTo(z0, 3);
    expect(h.m.player("u1")!.stats.shots).toBe(0);
    untilLive(h);
    for (let i = 0; i < 60; i++) tick(h, { u1: { forward: 1, yaw: Math.PI } });
    expect(Math.abs(h.m.player("u1")!.c.move.pos.z - z0)).toBeGreaterThan(3);
  });

  it("acerto, dano, eliminação e fim de round por eliminação", () => {
    const h = setup();
    untilLive(h);
    duelPositions(h);
    let killed = false;
    for (let i = 0; i < 300 && !killed; i++) {
      tick(h, { u1: { ...aimAt(eyeOf(h, "u1"), headOf(h, "u2")), fire: true, aim: true } });
      killed = !h.m.player("u2")!.c.alive;
    }
    expect(killed).toBe(true);
    const a = h.m.player("u1")!.stats;
    expect(a.kills).toBe(1);
    expect(a.damage).toBe(MAX_HEALTH);
    expect(a.hits).toBeGreaterThan(0);
    expect(h.m.player("u2")!.stats.deaths).toBe(1);
    tick(h);
    expect(h.m.phase).toBe("round_end");
    expect(h.m.score).toEqual([1, 0]);
    const ev1 = events(h, "u1");
    expect(ev1.some((e) => e.k === "kill" && e.killer === "u1" && e.victim === "u2")).toBe(true);
    expect(ev1.some((e) => e.k === "round_end" && e.winner === 0 && e.reason === "elimination")).toBe(true);
    // O alvo também recebe o evento de dano (indicador de direção).
    expect(events(h, "u2").some((e) => e.k === "hit" && e.target === "u2")).toBe(true);
  });

  it("cadência é imposta pelo servidor mesmo com o gatilho sempre apertado", () => {
    const h = setup(1, [SNIPER]);
    untilLive(h);
    place(h, "u1", { x: 5, y: 0, z: -23 });
    for (let i = 0; i < 120; i++) tick(h, { u1: { fire: true, yaw: 0, pitch: 0.4 } });
    const shots = h.m.player("u1")!.stats.shots;
    const rpm = W(SNIPER).fireRateRpm;
    expect(shots).toBeLessThanOrEqual(Math.ceil((2 * rpm) / 60) + 1);
    // Semiautomática: gatilho segurado não repete.
    expect(shots).toBe(1);
  });

  it("compensação de latência: acerta onde o atirador via o alvo, até o limite de 250 ms", () => {
    const h = setup(1, [SNIPER]);
    untilLive(h);
    duelPositions(h);
    // B anda para o lado durante 12 ticks (200 ms).
    const before = headOf(h, "u2");
    const viewTick = h.m.tick;
    for (let i = 0; i < 12; i++) tick(h, { u2: { right: 1, yaw: 0 } });
    expect(Math.abs(headOf(h, "u2").x - before.x)).toBeGreaterThan(0.5);
    // A atira (mirando com ADS) no lugar antigo, informando que estava vendo o tick antigo.
    tick(h, { u1: { ...aimAt(eyeOf(h, "u1"), before), fire: true, aim: true, viewTick } });
    expect(h.m.player("u1")!.stats.hits).toBe(1);

    // Sem compensação (viewTick atual), o mesmo tiro no lugar antigo erra.
    const h2 = setup(1, [SNIPER]);
    untilLive(h2);
    duelPositions(h2);
    const old = headOf(h2, "u2");
    for (let i = 0; i < 12; i++) tick(h2, { u2: { right: 1, yaw: 0 } });
    tick(h2, { u1: { ...aimAt(eyeOf(h2, "u1"), old), fire: true, aim: true } });
    expect(h2.m.player("u1")!.stats.hits).toBe(0);
  });

  it("anti speed-hack: rajada de comandos não acelera o jogador", () => {
    const h = setup();
    untilLive(h);
    place(h, "u1", { x: 5, y: 0, z: -23 });
    tick(h);
    const z0 = h.m.player("u1")!.c.move.pos.z;
    // Cliente adulterado envia 20 comandos de uma vez (o máximo da fila), a cada tick, por 30 ticks.
    let rejected = 0;
    for (let t = 0; t < 30; t++) {
      for (let k = 0; k < 20; k++) {
        const s = h.seq.get("u1")! + 1;
        const err = h.m.submitCommands("u1", [{ seq: s, ...idle({ forward: 1, sprint: true, yaw: Math.PI }) }]);
        if (err) rejected++;
        else h.seq.set("u1", s);
      }
      h.m.step();
    }
    const dist = Math.abs(h.m.player("u1")!.c.move.pos.z - z0);
    // Em 31 ticks, correndo a 6,6 m/s, o máximo honesto é ~3,4 m; com a folga de 10 comandos, ~4,5 m.
    expect(dist).toBeLessThan(4.8);
    expect(rejected).toBeGreaterThan(0);
  });

  it("rejeita buraco na sequência de comandos", () => {
    const h = setup();
    expect(h.m.submitCommands("u1", [{ seq: 5, ...idle() }])).toBe("sequence");
    expect(h.m.submitCommands("u1", [{ seq: 1, ...idle() }])).toBeNull();
    expect(h.m.submitCommands("u1", [{ seq: 1, ...idle() }])).toBe("sequence");
  });

  it("valores absurdos de mira são saneados", () => {
    const h = setup();
    untilLive(h);
    tick(h, { u1: { pitch: 50, yaw: 1e4 } });
    const snap = h.inbox.get("u2")!.filter((m) => m.t === "snap").at(-1)!;
    if (snap.t !== "snap") throw new Error();
    const other = snap.others.find((o) => o[0] === "u1")!;
    expect(Math.abs(other[5])).toBeLessThanOrEqual(Math.PI / 2);
    expect(Math.abs(other[4])).toBeLessThanOrEqual(Math.PI);
  });

  it("snapshot leva o estado de animação do adversário (chão, corrida, recarga) e o código da arma no tiro", () => {
    const h = setup();
    untilLive(h);
    duelPositions(h);
    const lastOther = () => {
      const snaps = h.inbox.get("u2")!.filter((m) => m.t === "snap");
      const s = snaps.at(-1)!;
      return s.t === "snap" ? s.others[0]! : null;
    };
    for (let i = 0; i < 4; i++) tick(h);
    expect(lastOther()![10] & ANIM_FLAG.onGround).toBe(ANIM_FLAG.onGround);
    // Corrida (para frente com sprint).
    for (let i = 0; i < 20; i++) tick(h, { u1: { forward: 1, sprint: true, yaw: Math.PI } });
    expect(lastOther()![10] & ANIM_FLAG.sprinting).toBe(ANIM_FLAG.sprinting);
    // Pulo: sai do chão.
    tick(h, { u1: { jump: true } });
    for (let i = 0; i < 6; i++) tick(h);
    expect(lastOther()![10] & ANIM_FLAG.onGround).toBe(0);
    for (let i = 0; i < 90; i++) tick(h);
    // Atira para o alto (evento com o código da arma) e recarrega.
    h.inbox.get("u2")!.length = 0;
    tick(h, { u1: { fire: true, pitch: 1.4 } });
    for (let i = 0; i < 3; i++) tick(h);
    const shotEv = events(h, "u2").find((e) => e.k === "shot");
    expect(shotEv && shotEv.k === "shot" && shotEv.w).toBe(RIFLE);
    tick(h, { u1: { reload: true } });
    for (let i = 0; i < 4; i++) tick(h);
    expect(lastOther()![10] & ANIM_FLAG.reloading).toBe(ANIM_FLAG.reloading);
  });

  it("vida dos inimigos não é enviada (só a dos aliados)", () => {
    const h = setup(2);
    untilLive(h);
    const snap = h.inbox.get("u1")!.filter((m) => m.t === "snap").at(-1)!;
    if (snap.t !== "snap") throw new Error();
    const ally = snap.others.find((o) => o[0] === "u2")!;
    const enemy = snap.others.find((o) => o[0] === "u3")!;
    expect(ally[9]).toBe(100);
    expect(enemy[9]).toBe(-1);
  });

  it("partida termina ao atingir os rounds necessários e reporta MVP", () => {
    const h = setup();
    for (let r = 0; r < h.m.roundsToWin; r++) {
      untilLive(h);
      duelPositions(h);
      for (let i = 0; i < 300 && h.m.player("u2")!.c.alive; i++) tick(h, { u1: { ...aimAt(eyeOf(h, "u1"), headOf(h, "u2")), fire: true, aim: true, reload: i % 90 === 89 } });
      expect(h.m.player("u2")!.c.alive).toBe(false);
      for (let i = 0; i < 260 && h.m.phase !== "freeze" && !h.m.isEnded; i++) tick(h);
    }
    expect(h.m.isEnded).toBe(true);
    expect(h.results).toHaveLength(1);
    const r = h.results[0]!;
    expect(r.winner).toBe(0);
    expect(r.score).toEqual([5, 0]);
    expect(r.players.find((p) => p.id === "u1")).toMatchObject({ kills: 5, mvp: true });
    expect(r.events.filter((e) => e.type === "kill")).toHaveLength(5);
  });

  it("reconexão dentro do prazo mantém a vaga; depois do prazo vira abandono e o time perde", () => {
    const h = setup();
    untilLive(h);
    h.m.detach("u2");
    for (let i = 0; i < 30; i++) tick(h);
    expect(h.m.player("u2")!.abandoned).toBe(false);
    const box: ServerMessage[] = [];
    expect(h.m.attach("u2", { send: (m) => box.push(m) })).toBe(true);
    const info = box.find((m) => m.t === "match");
    expect(info && info.t === "match" && info.info.lastSeq).toBe(h.m.player("u2")!.c.seq);
    h.seq.set("u2", h.m.player("u2")!.c.seq);
    tick(h);

    h.m.detach("u2");
    h.clock.t += 61_000;
    tick(h);
    expect(h.m.player("u2")!.abandoned).toBe(true);
    expect(h.m.isEnded).toBe(true);
    expect(h.results[0]).toMatchObject({ winner: 0, reason: "forfeit" });
    expect(h.results[0]!.players.find((p) => p.id === "u2")!.abandoned).toBe(true);
  });
});

const RULES = { roundTimeSec: 100, friendlyFire: false, headshotsOnly: false };

describe("partida personalizada (sala)", () => {
  it("rounds para vencer e tempo de round vêm da sala", () => {
    const h = setup(1, [RIFLE], { roomId: "r1", roundsToWin: 2, rules: { ...RULES, roundTimeSec: 30 } });
    expect(h.m.info("u1").roundsToWin).toBe(2);
    expect(h.m.info("u1").rules).toEqual({ ...RULES, roundTimeSec: 30 });
    untilLive(h);
    const start = h.m.tick;
    for (let i = 0; i < 31 * 60 && h.m.phase === "live"; i++) tick(h);
    expect(h.m.phase).toBe("round_end");
    expect((h.m.tick - start) / 60).toBeGreaterThan(29);
    expect((h.m.tick - start) / 60).toBeLessThan(31);
    tick(h);
    tick(h);
    expect(events(h, "u1").some((e) => e.k === "round_end" && e.reason === "time")).toBe(true);
  });

  it("sem fogo amigo, tiro no aliado não causa dano; com fogo amigo mata e não conta abate", () => {
    for (const ff of [false, true]) {
      const h = setup(2, [RIFLE], { roomId: "r1", roundsToWin: 3, rules: { ...RULES, friendlyFire: ff } });
      untilLive(h);
      // u1 e u2 são do mesmo time (A).
      place(h, "u1", { x: 5, y: 0, z: -23 });
      place(h, "u2", { x: 5, y: 0, z: -15 });
      place(h, "u3", { x: -30, y: 0, z: 30 });
      place(h, "u4", { x: -32, y: 0, z: 30 });
      for (let i = 0; i < 10; i++) tick(h);
      for (let i = 0; i < 240 && h.m.player("u2")!.c.alive; i++) tick(h, { u1: { ...aimAt(eyeOf(h, "u1"), headOf(h, "u2")), fire: true, aim: true } });
      const u2 = h.m.player("u2")!;
      if (!ff) {
        expect(u2.c.alive).toBe(true);
        expect(u2.c.health).toBe(MAX_HEALTH);
      } else {
        expect(u2.c.alive).toBe(false);
        expect(h.m.player("u1")!.stats.kills).toBe(0);
        expect(u2.stats.deaths).toBe(1);
      }
    }
  });

  it("só headshot: tiro no corpo não tira vida; na cabeça mata", () => {
    const h = setup(1, [RIFLE], { roomId: "r1", roundsToWin: 3, rules: { ...RULES, headshotsOnly: true } });
    untilLive(h);
    duelPositions(h);
    const chest = () => {
      const p = h.m.player("u2")!.c.move.pos;
      return { x: p.x, y: p.y + 1.1, z: p.z };
    };
    for (let i = 0; i < 90; i++) tick(h, { u1: { ...aimAt(eyeOf(h, "u1"), chest()), fire: true, aim: true } });
    expect(h.m.player("u1")!.stats.shots).toBeGreaterThan(3);
    expect(h.m.player("u2")!.c.health).toBe(MAX_HEALTH);
    for (let i = 0; i < 30; i++) tick(h, { u1: { reload: true } });
    for (let i = 0; i < 300 && h.m.player("u2")!.c.alive; i++) tick(h, { u1: { ...aimAt(eyeOf(h, "u1"), headOf(h, "u2")), fire: true, aim: true } });
    expect(h.m.player("u2")!.c.alive).toBe(false);
  });

  it("espectador recebe tudo com atraso; jogador da partida não pode assistir; partida da fila não aceita", () => {
    const h = setup(1, [RIFLE], { roomId: "r1", roundsToWin: 3, rules: RULES });
    const got: ServerMessage[] = [];
    expect(h.m.addSpectator("u1", { send: () => {} })).toBe(false);
    expect(h.m.addSpectator("s1", { send: (m) => got.push(m) })).toBe(true);
    expect(got[0]!.t).toBe("spec_start");
    const delayTicks = Math.round(SPECTATOR_DELAY_MS / (1000 / 60));
    for (let i = 0; i < delayTicks + 60; i++) {
      tick(h);
      const frames = got.filter((m) => m.t === "spec");
      const last = frames.at(-1);
      // Nunca chega um quadro mais novo que (agora - atraso).
      if (last && last.t === "spec") expect(last.tick).toBeLessThanOrEqual(h.m.tick - delayTicks);
    }
    const frames = got.filter((m): m is Extract<ServerMessage, { t: "spec" }> => m.t === "spec");
    expect(frames.length).toBeGreaterThan(20);
    // O espectador vê vida e time de todos (inclusive adversários).
    expect(frames.at(-1)!.players.map((p) => [p[0], p[9], p[11]])).toEqual([["u1", MAX_HEALTH, 0], ["u2", MAX_HEALTH, 1]]);
    // Quem joga sabe que há gente assistindo.
    const snap = h.inbox.get("u1")!.filter((m) => m.t === "snap").at(-1);
    expect(snap && snap.t === "snap" && snap.spec).toBe(1);
    const queue = setup();
    expect(queue.m.addSpectator("s1", { send: () => {} })).toBe(false);
  });

  it("o espectador recebe o fim da partida mesmo depois que ela acabou no servidor", () => {
    const h = setup(1, [RIFLE], { roomId: "r1", roundsToWin: 1, rules: RULES });
    const got: ServerMessage[] = [];
    h.m.addSpectator("s1", { send: (m) => got.push(m) });
    untilLive(h);
    h.m.forfeit("u2");
    expect(h.m.isEnded).toBe(true);
    expect(h.results[0]!.roomId).toBe("r1");
    const hasEnd = () => got.some((m) => m.t === "spec" && m.ev.some((e) => e.k === "match_end"));
    expect(hasEnd()).toBe(false);
    for (let i = 0; i < 400 && !hasEnd(); i++) h.m.step();
    expect(hasEnd()).toBe(true);
  });

  it("kill cam: a vítima recebe só o abatedor e ela mesma, nos últimos 4 s até o abate; os outros não recebem", () => {
    const h = setup(2);
    untilLive(h);
    place(h, "u1", { x: 5, y: 0, z: -23 });
    place(h, "u3", { x: 5, y: 0, z: -15 });
    place(h, "u2", { x: -20, y: 0, z: -23 });
    place(h, "u4", { x: -20, y: 0, z: 20 });
    for (let i = 0; i < 10; i++) tick(h);
    let killTick = -1;
    for (let i = 0; i < 300 && h.m.player("u3")!.c.alive; i++) {
      tick(h, { u1: { ...aimAt(eyeOf(h, "u1"), headOf(h, "u3")), fire: true, aim: true } });
      if (!h.m.player("u3")!.c.alive) killTick = h.m.tick;
    }
    expect(killTick).toBeGreaterThan(0);
    tick(h);
    tick(h);
    const cams = (id: string) => h.inbox.get(id)!.filter((m): m is Extract<ServerMessage, { t: "killcam" }> => m.t === "killcam");
    expect(cams("u1")).toHaveLength(0);
    expect(cams("u2")).toHaveLength(0);
    expect(cams("u4")).toHaveLength(0);
    const [cam] = cams("u3");
    expect(cam).toMatchObject({ killer: "u1", victim: "u3" });
    const ids = new Set(cam!.frames.flatMap((f) => f.players.map((p) => p[0])));
    expect([...ids].sort()).toEqual(["u1", "u3"]);
    const ticks = cam!.frames.map((f) => f.tick);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(killTick + 2);
    expect((Math.max(...ticks) - Math.min(...ticks)) * (1000 / 60)).toBeLessThanOrEqual(KILLCAM_MS + 40);
    expect(cam!.frames.length).toBeGreaterThan(30);
  });

  it("replay: quadros de todos os jogadores a ~15 Hz, sem aquecimento, com abates, rounds e fim", async () => {
    const h = setup();
    for (let r = 0; r < h.m.roundsToWin; r++) {
      untilLive(h);
      duelPositions(h);
      for (let i = 0; i < 300 && h.m.player("u2")!.c.alive; i++) tick(h, { u1: { ...aimAt(eyeOf(h, "u1"), headOf(h, "u2")), fire: true, aim: true, reload: i % 90 === 89 } });
      for (let i = 0; i < 260 && h.m.phase !== "freeze" && !h.m.isEnded; i++) tick(h);
    }
    const pending = h.results[0]!.replay!;
    const encoded = await pending.recorder.finish(pending.header);
    const rep = decodeReplay(encoded);
    expect(encoded.frameCount).toBe(rep.frames.length);
    expect(rep).toMatchObject({ v: 1, matchId: "m1", mode: "1v1", map: "NEON_DISTRICT", roundsToWin: 5 });
    expect(rep.players.map((p) => p.id)).toEqual(["u1", "u2"]);
    const f = rep.frames;
    expect(f.every((x) => x.phase !== "warmup" && x.players.length === 2)).toBe(true);
    expect(f.every((x, i) => i === 0 || x.tick > f[i - 1]!.tick)).toBe(true);
    const evs = f.flatMap((x) => x.ev);
    expect(evs.filter((e) => e.k === "kill")).toHaveLength(5);
    expect(evs.filter((e) => e.k === "round_end")).toHaveLength(5);
    expect(evs.some((e) => e.k === "match_end")).toBe(true);
    expect(evs.filter((e) => e.k === "shot").every((e) => e.k === "shot" && e.ends.length <= 1)).toBe(true);
    const seconds = (f[f.length - 1]!.tick - f[0]!.tick) / 60;
    const hz = f.length / seconds;
    expect(hz).toBeGreaterThan(13);
    expect(hz).toBeLessThan(18);
  });
});
