-- AlterTable
ALTER TABLE "AgentReturn" ADD COLUMN "labelStatus" TEXT,
ADD COLUMN "labelUrl" TEXT,
ADD COLUMN "labelCarrier" TEXT,
ADD COLUMN "labelCost" TEXT,
ADD COLUMN "labelCostCurrency" TEXT,
ADD COLUMN "labelShipmentId" TEXT,
ADD COLUMN "labelError" TEXT,
ADD COLUMN "labelAttachedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReturnLabelAccount" (
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiKeySealed" TEXT NOT NULL,
    "apiKeyHint" TEXT NOT NULL,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "parcelLength" TEXT NOT NULL DEFAULT '12',
    "parcelWidth" TEXT NOT NULL DEFAULT '9',
    "parcelHeight" TEXT NOT NULL DEFAULT '4',
    "distanceUnit" TEXT NOT NULL DEFAULT 'in',
    "parcelWeight" TEXT NOT NULL DEFAULT '2',
    "massUnit" TEXT NOT NULL DEFAULT 'lb',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnLabelAccount_pkey" PRIMARY KEY ("shop")
);
