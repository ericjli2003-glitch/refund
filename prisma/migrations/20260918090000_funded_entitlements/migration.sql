-- CreateTable
CREATE TABLE "FundedEntitlement" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "shop" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'SANDBOX',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "shopifyReturnId" TEXT,
    "conflictReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundedEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FundedEntitlement_shop_orderId_status_idx" ON "FundedEntitlement"("shop", "orderId", "status");

-- CreateIndex
CREATE INDEX "FundedEntitlement_shop_caseId_idx" ON "FundedEntitlement"("shop", "caseId");

-- CreateIndex
CREATE INDEX "FundedEntitlement_shop_shopifyReturnId_idx" ON "FundedEntitlement"("shop", "shopifyReturnId");


-- Sandbox-only until a funding agreement exists; a live row needs a deliberate
-- future migration. Identifiers must be Shopify GIDs so guards compare exactly.
ALTER TABLE "FundedEntitlement"
    ADD CONSTRAINT "FundedEntitlement_sandbox_only" CHECK ("environment" = 'SANDBOX'),
    ADD CONSTRAINT "FundedEntitlement_status_check" CHECK ("status" IN ('ACTIVE', 'RELEASED', 'CONFLICT')),
    ADD CONSTRAINT "FundedEntitlement_quantity_check" CHECK ("quantity" > 0),
    ADD CONSTRAINT "FundedEntitlement_order_gid" CHECK ("orderId" ~ '^gid://shopify/Order/[0-9]+$'),
    ADD CONSTRAINT "FundedEntitlement_line_item_gid" CHECK ("lineItemId" ~ '^gid://shopify/LineItem/[0-9]+$'),
    ADD CONSTRAINT "FundedEntitlement_return_gid" CHECK ("shopifyReturnId" IS NULL OR "shopifyReturnId" ~ '^gid://shopify/Return/[0-9]+$');
