CREATE TABLE "AgentAccessGrant" (
    "tokenHash" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerSubjectHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentAccessGrant_pkey" PRIMARY KEY ("tokenHash")
);
CREATE INDEX "AgentAccessGrant_sessionId_idx" ON "AgentAccessGrant"("sessionId");
CREATE INDEX "AgentAccessGrant_shop_customerSubjectHash_idx" ON "AgentAccessGrant"("shop", "customerSubjectHash");
CREATE INDEX "AgentAccessGrant_expiresAt_idx" ON "AgentAccessGrant"("expiresAt");
ALTER TABLE "AgentAccessGrant" ADD CONSTRAINT "AgentAccessGrant_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "CustomerReturnSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
