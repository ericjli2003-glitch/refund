-- CreateTable
CREATE TABLE "StorePolicy" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "automaticRefundsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "returnWindowDays" INTEGER NOT NULL DEFAULT 30,
    "maxAutoRefundAmount" TEXT NOT NULL DEFAULT '100.00',
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
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
    "returnStatus" TEXT,
    "refundStatus" TEXT,
    "amount" TEXT,
    "currencyCode" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestedLineItems" JSONB NOT NULL,
    "customerSubjectHash" TEXT NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentReturn_shop_idempotencyKey_key" ON "AgentReturn"("shop", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentReturn_shop_status_createdAt_idx" ON "AgentReturn"("shop", "status", "createdAt");

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "WebhookReceipt_shop_processedAt_idx" ON "WebhookReceipt"("shop", "processedAt");

-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "customerSubjectHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reportData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3)
);

-- CreateIndex
CREATE INDEX "PrivacyRequest_shop_status_createdAt_idx" ON "PrivacyRequest"("shop", "status", "createdAt");
