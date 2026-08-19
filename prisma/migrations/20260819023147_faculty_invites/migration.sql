-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isFaculty" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "faculty_invites" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faculty_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faculty_invite_redemptions" (
    "id" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faculty_invite_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "faculty_invites_token_key" ON "faculty_invites"("token");

-- CreateIndex
CREATE INDEX "faculty_invites_createdByUserId_idx" ON "faculty_invites"("createdByUserId");

-- CreateIndex
CREATE INDEX "faculty_invite_redemptions_userId_idx" ON "faculty_invite_redemptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "faculty_invite_redemptions_inviteId_userId_key" ON "faculty_invite_redemptions"("inviteId", "userId");

-- AddForeignKey
ALTER TABLE "faculty_invites" ADD CONSTRAINT "faculty_invites_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faculty_invite_redemptions" ADD CONSTRAINT "faculty_invite_redemptions_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "faculty_invites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faculty_invite_redemptions" ADD CONSTRAINT "faculty_invite_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
