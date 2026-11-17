-- CreateTable
CREATE TABLE "MatchReplay" (
    "matchId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "frameCount" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchReplay_pkey" PRIMARY KEY ("matchId")
);

-- CreateIndex
CREATE INDEX "MatchReplay_createdAt_idx" ON "MatchReplay"("createdAt");

-- AddForeignKey
ALTER TABLE "MatchReplay" ADD CONSTRAINT "MatchReplay_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

