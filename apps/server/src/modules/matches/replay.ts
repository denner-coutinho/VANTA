import { createHash } from "node:crypto";
import type { PrismaClient } from "@vanta/db";
import { REPLAY_RETENTION_DAYS, TICK_MS } from "@vanta/shared";
import type { PendingReplay } from "../../game/replay-recorder.js";

/** Tamanho máximo do replay compactado (uma partida longa de 3v3 fica bem abaixo disso). */
export const REPLAY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Termina a compressão (feita durante a partida, ver ReplayRecorder), calcula o SHA-256 e grava
 * o replay; o hash também vai em Match.replayHash.
 */
export async function saveReplay(db: PrismaClient, pending: PendingReplay) {
  const replay = await pending.recorder.finish(pending.header);
  if (!replay.frameCount) return null;
  const data = new Uint8Array(replay.data);
  if (data.length > REPLAY_MAX_BYTES) throw new Error(`replay grande demais (${data.length} bytes)`);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const first = replay.firstTick;
  const last = replay.lastTick;
  await db.$transaction([
    db.matchReplay.upsert({
      where: { matchId: replay.matchId },
      create: { matchId: replay.matchId, version: replay.version, durationMs: Math.round((last - first) * TICK_MS), frameCount: replay.frameCount, sizeBytes: data.length, sha256, data },
      update: {},
    }),
    db.match.update({ where: { id: replay.matchId }, data: { replayHash: sha256 } }),
  ]);
  return { sizeBytes: data.length, sha256 };
}

/** Apaga replays mais velhos que REPLAY_RETENTION_DAYS (a partida e as estatísticas ficam). */
export async function pruneReplays(db: PrismaClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - REPLAY_RETENTION_DAYS * 86_400_000);
  const r = await db.matchReplay.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (r.count) await db.match.updateMany({ where: { replayHash: { not: null }, replay: null }, data: { replayHash: null } });
  return r.count;
}
