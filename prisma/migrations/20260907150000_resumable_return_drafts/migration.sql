CREATE TABLE "ReturnDraft" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerSubjectHash" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'PURCHASES_FOUND',
    "orderId" TEXT,
    "orderName" TEXT,
    "selectedItems" JSONB,
    "quoteSnapshot" JSONB,
    "sealedQuoteToken" TEXT,
    "quoteId" TEXT,
    "quoteExpiresAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReturnDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReturnDraft_shop_customerSubjectHash_key"
ON "ReturnDraft"("shop", "customerSubjectHash");
CREATE INDEX "ReturnDraft_expiresAt_idx" ON "ReturnDraft"("expiresAt");
CREATE INDEX "ReturnDraft_shop_quoteId_idx" ON "ReturnDraft"("shop", "quoteId");
