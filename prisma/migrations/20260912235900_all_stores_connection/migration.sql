-- One assistant connection covering every Refund store. It grants no purchase
-- access by itself: each store is linked with that store's own Shopify sign-in.
CREATE TABLE "AgentConnection" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "browserHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentConnection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentConnection_expiresAt_idx" ON "AgentConnection"("expiresAt");

CREATE TABLE "AgentStoreLink" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentStoreLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentStoreLink_connectionId_shop_key" ON "AgentStoreLink"("connectionId", "shop");
CREATE INDEX "AgentStoreLink_sessionId_idx" ON "AgentStoreLink"("sessionId");
CREATE INDEX "AgentStoreLink_shop_idx" ON "AgentStoreLink"("shop");
ALTER TABLE "AgentStoreLink" ADD CONSTRAINT "AgentStoreLink_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "AgentConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Signing out, customer redaction and uninstall delete the session, and with it the link.
ALTER TABLE "AgentStoreLink" ADD CONSTRAINT "AgentStoreLink_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "CustomerReturnSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentStoreLinkRequest" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "csrfToken" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentStoreLinkRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentStoreLinkRequest_connectionId_idx" ON "AgentStoreLinkRequest"("connectionId");
CREATE INDEX "AgentStoreLinkRequest_shop_idx" ON "AgentStoreLinkRequest"("shop");
CREATE INDEX "AgentStoreLinkRequest_expiresAt_idx" ON "AgentStoreLinkRequest"("expiresAt");
ALTER TABLE "AgentStoreLinkRequest" ADD CONSTRAINT "AgentStoreLinkRequest_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "AgentConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grants and authorization requests for the all-stores resource belong to a
-- connection instead of one store's customer session.
ALTER TABLE "AgentAccessGrant"
  ALTER COLUMN "sessionId" DROP NOT NULL,
  ALTER COLUMN "shop" DROP NOT NULL,
  ALTER COLUMN "customerSubjectHash" DROP NOT NULL,
  ADD COLUMN "connectionId" TEXT;
CREATE INDEX "AgentAccessGrant_connectionId_idx" ON "AgentAccessGrant"("connectionId");
ALTER TABLE "AgentAccessGrant" ADD CONSTRAINT "AgentAccessGrant_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "AgentConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentOAuthRequest"
  ALTER COLUMN "shop" DROP NOT NULL,
  ADD COLUMN "connectionId" TEXT;

ALTER TABLE "CustomerReturnSession" ADD COLUMN "linkRequestId" TEXT;
