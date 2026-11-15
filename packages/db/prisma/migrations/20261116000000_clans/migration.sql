-- AlterTable
ALTER TABLE "Clan" ADD COLUMN     "isOpen" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ClanInvite" (
    "id" TEXT NOT NULL,
    "clanId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClanInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClanMatch" (
    "id" TEXT NOT NULL,
    "clanId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "result" "MatchResult" NOT NULL,
    "pointsDelta" INTEGER NOT NULL,
    "memberIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClanMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClanInvite_userId_idx" ON "ClanInvite"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClanInvite_clanId_userId_key" ON "ClanInvite"("clanId", "userId");

-- CreateIndex
CREATE INDEX "ClanMatch_clanId_createdAt_idx" ON "ClanMatch"("clanId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClanMatch_clanId_matchId_key" ON "ClanMatch"("clanId", "matchId");

-- CreateIndex
CREATE INDEX "Clan_rating_idx" ON "Clan"("rating" DESC);

-- AddForeignKey
ALTER TABLE "ClanInvite" ADD CONSTRAINT "ClanInvite_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "Clan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClanInvite" ADD CONSTRAINT "ClanInvite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClanInvite" ADD CONSTRAINT "ClanInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClanMatch" ADD CONSTRAINT "ClanMatch_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "Clan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClanMatch" ADD CONSTRAINT "ClanMatch_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

