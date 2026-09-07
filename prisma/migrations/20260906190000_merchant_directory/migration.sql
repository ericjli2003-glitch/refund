CREATE TABLE "MerchantDirectory" (
    "shop" TEXT NOT NULL,
    "primaryDomain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MerchantDirectory_pkey" PRIMARY KEY ("shop")
);
CREATE UNIQUE INDEX "MerchantDirectory_primaryDomain_key" ON "MerchantDirectory"("primaryDomain");
