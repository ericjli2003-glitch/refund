-- CreateTable
CREATE TABLE "PersonalDataAccess" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shop" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "customerSubjectHash" TEXT,
    "resource" TEXT,
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalDataAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PersonalDataAccess_shop_occurredAt_idx" ON "PersonalDataAccess"("shop", "occurredAt");

-- CreateIndex
CREATE INDEX "PersonalDataAccess_customerSubjectHash_occurredAt_idx" ON "PersonalDataAccess"("customerSubjectHash", "occurredAt");

-- CreateIndex
CREATE INDEX "PersonalDataAccess_expiresAt_idx" ON "PersonalDataAccess"("expiresAt");
