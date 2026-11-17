import { describe, expect, it } from "vitest";
import type { ReplayFile, SpecFrame } from "@vanta/shared";
import { ReplayRecorder, decodeReplay } from "../src/game/replay-recorder.js";

const frame = (tick: number, ev: SpecFrame["ev"] = []): SpecFrame => ({ t: "spec", tick, phase: "live", phaseEndsIn: 1000, round: 1, score: [0, 0], players: [["a", tick / 100, 0, 0, 0, 0, 0, 1, 0, 100, 0, 0]], kd: [["a", 0, 0, 0]], ev });
const header: Omit<ReplayFile, "frames"> = { v: 1, matchId: "m1", mode: "1v1", map: "NEON_DISTRICT", roundsToWin: 5, rules: null, players: [], startedAt: "2026-11-17T00:00:00.000Z", endedAt: "2026-11-17T00:10:00.000Z" };

describe("gravador de replay em streaming", () => {
  it("gera o mesmo ReplayFile que o JSON completo, em um gzip só", async () => {
    const frames = Array.from({ length: 1000 }, (_, i) => frame(i * 4, i % 50 === 0 ? [{ k: "kill", killer: "a", victim: "b", weapon: "VK-7", head: false }] : []));
    const { recorder } = ReplayRecorder.fromFile({ ...header, frames });
    const enc = await recorder.finish(header);
    expect(enc).toMatchObject({ matchId: "m1", version: 1, frameCount: 1000, firstTick: 0, lastTick: 3996 });
    expect(decodeReplay(enc)).toEqual({ ...header, frames });
    // Um membro gzip só (o DecompressionStream do navegador não aceita vários).
    expect(enc.data.indexOf(Buffer.from([0x1f, 0x8b, 0x08]), 1)).toBe(-1);
  });

  it("junta dois quadros do mesmo tick e aceita partida sem quadros", async () => {
    const r = new ReplayRecorder();
    r.push(frame(10));
    r.push(frame(20, [{ k: "round_end", winner: 0, round: 1, score: [1, 0], reason: "elimination" } as SpecFrame["ev"][number]]));
    r.push(frame(20, [{ k: "match_end", winner: 0, score: [1, 0], reason: "score", stats: [] }]));
    const file = decodeReplay(await r.finish(header));
    expect(file.frames.map((f) => f.tick)).toEqual([10, 20]);
    expect(file.frames[1]!.ev.map((e) => e.k)).toEqual(["round_end", "match_end"]);
    const empty = await new ReplayRecorder().finish(header);
    expect(empty.frameCount).toBe(0);
    expect(decodeReplay(empty).frames).toEqual([]);
  });
});
