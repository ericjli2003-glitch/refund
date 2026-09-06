CREATE TABLE "CustomerReturnSession" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "stateHash" TEXT,
    "sealedState" TEXT,
    "accessToken" TEXT,
    "customerSubjectHash" TEXT,
    "csrfToken" TEXT NOT NULL,
    "orderHint" TEXT,
    "itemHint" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerReturnSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerReturnSession_stateHash_key" ON "CustomerReturnSession"("stateHash");
CREATE INDEX "CustomerReturnSession_shop_customerSubjectHash_idx" ON "CustomerReturnSession"("shop", "customerSubjectHash");
CREATE INDEX "CustomerReturnSession_expiresAt_idx" ON "CustomerReturnSession"("expiresAt");
