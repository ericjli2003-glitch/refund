CREATE TABLE "FundedReturnSandbox" (
    "shop" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FundedReturnSandbox_pkey" PRIMARY KEY ("shop", "id")
);
CREATE INDEX "FundedReturnSandbox_shop_createdAt_idx" ON "FundedReturnSandbox"("shop", "createdAt");
