-- CreateTable
CREATE TABLE "ChannelNonce" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelNonce_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "ChannelNonce_expiresAt_idx" ON "ChannelNonce"("expiresAt");
-- CreateIndex
CREATE UNIQUE INDEX "ChannelNonce_keyId_nonce_key" ON "ChannelNonce"("keyId", "nonce");
