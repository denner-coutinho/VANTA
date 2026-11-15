-- AlterTable
ALTER TABLE "MatchPlayer" ADD COLUMN     "medals" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "UserMedal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UserMedal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XpGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "levelAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XpGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserMedal_userId_code_key" ON "UserMedal"("userId", "code");

-- CreateIndex
CREATE INDEX "XpGrant_userId_createdAt_idx" ON "XpGrant"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "XpGrant_userId_source_refId_key" ON "XpGrant"("userId", "source", "refId");

-- AddForeignKey
ALTER TABLE "UserMedal" ADD CONSTRAINT "UserMedal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XpGrant" ADD CONSTRAINT "XpGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

