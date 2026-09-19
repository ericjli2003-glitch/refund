-- DropIndex
DROP INDEX "FundedEntitlement_shop_caseId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "FundedEntitlement_shop_caseId_lineItemId_key" ON "FundedEntitlement"("shop", "caseId", "lineItemId");

