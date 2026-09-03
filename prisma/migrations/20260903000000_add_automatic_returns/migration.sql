-- CreateTable
CREATE TABLE "StorePolicy" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "automaticRefundsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "returnWindowDays" INTEGER NOT NULL DEFAULT 30,
    "maxAutoRefundAmount" TEXT NOT NULL DEFAULT '100.00',
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentReturn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "returnId" TEXT,
    "refundId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "amount" TEXT,
    "currencyCode" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestedLineItems" JSONB NOT NULL,
    "customerSubjectHash" TEXT NOT NULL,
    "failureReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentReturn_shop_idempotencyKey_key" ON "AgentReturn"("shop", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentReturn_shop_status_createdAt_idx" ON "AgentReturn"("shop", "status", "createdAt");
