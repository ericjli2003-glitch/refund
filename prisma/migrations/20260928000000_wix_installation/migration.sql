-- CreateTable
CREATE TABLE "WixInstallation" (
    "instanceId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "siteName" TEXT,
    "siteUrl" TEXT,
    "currencyCode" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WixInstallation_pkey" PRIMARY KEY ("instanceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "WixInstallation_shop_key" ON "WixInstallation"("shop");
