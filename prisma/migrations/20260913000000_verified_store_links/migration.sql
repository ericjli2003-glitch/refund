-- Store links that keep working after the customer's Shopify sign-in ends.
-- Refund then acts for the customer verified at link time through the store's
-- Admin API, applying return rules the merchant confirms in Refund.
ALTER TABLE "StorePolicy"
  ADD COLUMN "verifiedStoreLinks" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "restockingFeePercent" TEXT NOT NULL DEFAULT '0',
  ADD COLUMN "returnShippingFee" TEXT NOT NULL DEFAULT '0.00',
  ADD COLUMN "finalSaleCollectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "returnRulesConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "returnRulesMismatch" TEXT;

ALTER TABLE "AgentStoreLink"
  ADD COLUMN "customerSubjectHash" TEXT,
  ADD COLUMN "sealedCustomerId" TEXT,
  ADD COLUMN "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "sessionId" DROP NOT NULL;
UPDATE "AgentStoreLink" AS link
  SET "customerSubjectHash" = session."customerSubjectHash"
  FROM "CustomerReturnSession" AS session
  WHERE session."id" = link."sessionId";
DELETE FROM "AgentStoreLink" WHERE "customerSubjectHash" IS NULL;
ALTER TABLE "AgentStoreLink" ALTER COLUMN "customerSubjectHash" SET NOT NULL;
CREATE INDEX "AgentStoreLink_shop_customerSubjectHash_idx" ON "AgentStoreLink"("shop", "customerSubjectHash");

-- A link outlives the sign-in that created it. Customer redaction and
-- uninstall delete links directly.
ALTER TABLE "AgentStoreLink" DROP CONSTRAINT "AgentStoreLink_sessionId_fkey";
ALTER TABLE "AgentStoreLink" ADD CONSTRAINT "AgentStoreLink_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "CustomerReturnSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
