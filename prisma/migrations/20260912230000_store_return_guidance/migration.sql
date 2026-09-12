-- Merchant-authored public return guidance for quotes, agents.md and the manifest.
ALTER TABLE "StorePolicy"
ADD COLUMN "returnInstructions" TEXT,
ADD COLUMN "returnPolicyUrl" TEXT;
