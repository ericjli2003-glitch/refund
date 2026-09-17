-- CreateTable
CREATE TABLE "FundedPaymentIntent" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "shop" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'SANDBOX',
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "providerReference" TEXT,
    "submissions" INTEGER NOT NULL DEFAULT 0,
    "lookups" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewReason" TEXT,
    "lastError" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundedPaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundedPaymentEvent" (
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "shop" TEXT,
    "intentId" TEXT,
    "status" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "detail" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundedPaymentEvent_pkey" PRIMARY KEY ("provider","providerEventId")
);

-- CreateTable
CREATE TABLE "FundedSandboxProviderPayment" (
    "idempotencyKey" TEXT NOT NULL,
    "reference" TEXT,
    "shop" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "events" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundedSandboxProviderPayment_pkey" PRIMARY KEY ("idempotencyKey")
);

-- CreateIndex
CREATE INDEX "FundedPaymentIntent_status_nextCheckAt_idx" ON "FundedPaymentIntent"("status", "nextCheckAt");

-- CreateIndex
CREATE INDEX "FundedPaymentIntent_shop_caseId_idx" ON "FundedPaymentIntent"("shop", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "FundedPaymentIntent_shop_caseId_operation_attempt_key" ON "FundedPaymentIntent"("shop", "caseId", "operation", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "FundedPaymentIntent_provider_providerReference_key" ON "FundedPaymentIntent"("provider", "providerReference");

-- CreateIndex
CREATE INDEX "FundedPaymentEvent_shop_intentId_receivedAt_idx" ON "FundedPaymentEvent"("shop", "intentId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FundedSandboxProviderPayment_reference_key" ON "FundedSandboxProviderPayment"("reference");

-- CreateIndex
CREATE INDEX "FundedSandboxProviderPayment_shop_createdAt_idx" ON "FundedSandboxProviderPayment"("shop", "createdAt");


-- Structural sandbox separation and value guards. Prisma does not model CHECK
-- constraints; they are enforced by PostgreSQL. A live environment requires a
-- deliberate future migration, not a configuration flag.
ALTER TABLE "FundedPaymentIntent"
    ADD CONSTRAINT "FundedPaymentIntent_sandbox_only" CHECK ("environment" = 'SANDBOX'),
    ADD CONSTRAINT "FundedPaymentIntent_operation_check" CHECK ("operation" IN ('PAYOUT', 'COLLECTION')),
    ADD CONSTRAINT "FundedPaymentIntent_status_check" CHECK ("status" IN ('QUEUED', 'SUBMITTING', 'PENDING', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'REVIEW')),
    ADD CONSTRAINT "FundedPaymentIntent_amount_check" CHECK ("amountMinor" > 0),
    ADD CONSTRAINT "FundedPaymentIntent_attempt_check" CHECK ("attempt" > 0),
    ADD CONSTRAINT "FundedPaymentIntent_currency_check" CHECK ("currency" IN ('CAD', 'USD'));

ALTER TABLE "FundedPaymentEvent"
    ADD CONSTRAINT "FundedPaymentEvent_source_check" CHECK ("source" IN ('WEBHOOK', 'SUBMIT', 'LOOKUP'));

ALTER TABLE "FundedSandboxProviderPayment"
    ADD CONSTRAINT "FundedSandboxProviderPayment_amount_check" CHECK ("amountMinor" > 0);
