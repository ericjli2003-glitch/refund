-- A customer can link a store by confirming the email on their order instead
-- of signing in with Shopify: Refund emails a one-tap confirmation, and the
-- confirmation page checks a number shown in the customer's chat.
ALTER TABLE "AgentStoreLink"
  ADD COLUMN "sealedEmail" TEXT,
  ADD COLUMN "verifiedBy" TEXT NOT NULL DEFAULT 'SHOPIFY';

CREATE TABLE "EmailVerification" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "sealedEmail" TEXT NOT NULL,
  "emailHash" TEXT NOT NULL,
  "matchNumber" INTEGER NOT NULL,
  "csrfToken" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailVerification_connectionId_createdAt_idx" ON "EmailVerification"("connectionId", "createdAt");
CREATE INDEX "EmailVerification_shop_emailHash_createdAt_idx" ON "EmailVerification"("shop", "emailHash", "createdAt");
CREATE INDEX "EmailVerification_expiresAt_idx" ON "EmailVerification"("expiresAt");
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "AgentConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
