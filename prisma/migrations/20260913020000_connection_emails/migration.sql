-- Confirmed emails belong to an all-stores connection, so one confirmation
-- finds the customer's orders at every Refund store.
CREATE TABLE "ConnectionEmail" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "sealedEmail" TEXT NOT NULL,
  "emailHash" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "sourceShop" TEXT,
  "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectionEmail_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConnectionEmail_connectionId_emailHash_key" ON "ConnectionEmail"("connectionId", "emailHash");
CREATE INDEX "ConnectionEmail_emailHash_idx" ON "ConnectionEmail"("emailHash");
CREATE INDEX "ConnectionEmail_sourceShop_idx" ON "ConnectionEmail"("sourceShop");
ALTER TABLE "ConnectionEmail" ADD CONSTRAINT "ConnectionEmail_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "AgentConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Email confirmation on the all-stores consent page. Bound to the
-- authorization request, and so to the browser approving it; emptied when the
-- connection is created and deleted with the request.
CREATE TABLE "ConsentEmailCheck" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "sealedEmail" TEXT NOT NULL,
  "emailHash" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "matchNumber" INTEGER NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentEmailCheck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConsentEmailCheck_requestId_idx" ON "ConsentEmailCheck"("requestId");
CREATE INDEX "ConsentEmailCheck_emailHash_createdAt_idx" ON "ConsentEmailCheck"("emailHash", "createdAt");
ALTER TABLE "ConsentEmailCheck" ADD CONSTRAINT "ConsentEmailCheck_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "AgentOAuthRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A store link found through a confirmed email is removed with that email.
-- Email links made before this change had no connection email; drop them so
-- the next request finds the store through the connection instead.
ALTER TABLE "AgentStoreLink" ADD COLUMN "connectionEmailId" TEXT;
DELETE FROM "AgentStoreLink" WHERE "verifiedBy" = 'EMAIL';
CREATE INDEX "AgentStoreLink_connectionEmailId_idx" ON "AgentStoreLink"("connectionEmailId");
ALTER TABLE "AgentStoreLink" ADD CONSTRAINT "AgentStoreLink_connectionEmailId_fkey"
  FOREIGN KEY ("connectionEmailId") REFERENCES "ConnectionEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
