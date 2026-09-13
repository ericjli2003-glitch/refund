-- When refunds are issued: IMMEDIATE on customer confirmation (the existing
-- behavior) or ON_RECEIPT once the merchant marks the returned item received.
ALTER TABLE "StorePolicy" ADD COLUMN "refundTiming" TEXT NOT NULL DEFAULT 'IMMEDIATE';

-- Null on returns submitted before refund timing existed.
ALTER TABLE "AgentReturn"
ADD COLUMN "refundTiming" TEXT,
ADD COLUMN "itemReceivedAt" TIMESTAMP(3);
