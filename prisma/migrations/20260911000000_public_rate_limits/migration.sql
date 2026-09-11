CREATE TABLE "PublicRateLimit" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "hits" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "PublicRateLimit_expiresAt_idx" ON "PublicRateLimit"("expiresAt");

CREATE TABLE "MaintenanceLease" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "owner" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL
);
