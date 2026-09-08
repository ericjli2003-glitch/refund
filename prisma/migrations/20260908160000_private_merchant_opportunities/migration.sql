CREATE TABLE "MerchantOpportunity" (
  "id" TEXT NOT NULL,
  "merchantLabel" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "knownShop" TEXT,
  "source" TEXT NOT NULL,
  "reviewStatus" TEXT NOT NULL DEFAULT 'UNREVIEWED',
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MerchantOpportunity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MerchantOpportunity_lastSeenAt_idx" ON "MerchantOpportunity"("lastSeenAt");
CREATE INDEX "MerchantOpportunity_expiresAt_idx" ON "MerchantOpportunity"("expiresAt");
CREATE INDEX "MerchantOpportunity_knownShop_idx" ON "MerchantOpportunity"("knownShop");
