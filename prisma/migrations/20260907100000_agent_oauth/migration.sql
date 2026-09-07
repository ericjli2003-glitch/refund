ALTER TABLE "CustomerReturnSession" ADD COLUMN "agentRequestId" TEXT;
CREATE TABLE "AgentOAuthClient" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sealedInformation" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "AgentOAuthRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientId" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "redirectUri" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "sealedState" TEXT,
  "codeChallenge" TEXT NOT NULL,
  "browserHash" TEXT NOT NULL,
  "csrfToken" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "codeHash" TEXT,
  "codeExpiresAt" TIMESTAMP(3),
  "grantHash" TEXT,
  "sessionId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AgentOAuthRequest_codeHash_key" ON "AgentOAuthRequest"("codeHash");
CREATE INDEX "AgentOAuthRequest_sessionId_idx" ON "AgentOAuthRequest"("sessionId");
CREATE INDEX "AgentOAuthRequest_shop_idx" ON "AgentOAuthRequest"("shop");
CREATE INDEX "AgentOAuthRequest_expiresAt_idx" ON "AgentOAuthRequest"("expiresAt");
ALTER TABLE "AgentOAuthRequest" ADD CONSTRAINT "AgentOAuthRequest_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "CustomerReturnSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
