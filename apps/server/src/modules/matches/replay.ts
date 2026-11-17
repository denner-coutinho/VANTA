import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { PrismaClient } from "@vanta/db";
import { REPLAY_RETENTION_DAYS, TICK_MS, type ReplayFile } from "@vanta/shared";

/** Tamanho máximo do replay compactado (uma partida longa de 3v3 fica bem abaixo disso). */
export const REPLAY_MAX_BYTES = 8 * 1024 * 1024;

/** Compacta (gzip), calcula o SHA-256 e grava o replay; o hash também vai em Match.replayHash. */
export async function saveReplay(db: PrismaClient, replay: ReplayFile) {
  if (!replay.frames.length) return null;
  const data = gzipSync(Buffer.from(JSON.stringify(replay)), { level: 6 });
  if (data.length > REPLAY_MAX_BYTES) throw new Error(`replay grande demais (${data.length} bytes)`);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const first = replay.frames[0]!.tick;
  const last = replay.frames[replay.frames.length - 1]!.tick;
  await db.$transaction([
    db.matchReplay.upsert({
      where: { matchId: replay.matchId },
      create: { matchId: replay.matchId, version: replay.v, durationMs: Math.round((last - first) * TICK_MS), frameCount: replay.frames.length, sizeBytes: data.length, sha256, data },
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
