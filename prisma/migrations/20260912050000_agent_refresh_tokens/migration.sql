ALTER TABLE "AgentAccessGrant"
ADD COLUMN "refreshTokenHash" TEXT,
ADD COLUMN "refreshExpiresAt" TIMESTAMP(3),
ADD COLUMN "rotatedToTokenHash" TEXT;

CREATE UNIQUE INDEX "AgentAccessGrant_refreshTokenHash_key"
ON "AgentAccessGrant"("refreshTokenHash");

CREATE INDEX "AgentAccessGrant_refreshExpiresAt_idx"
ON "AgentAccessGrant"("refreshExpiresAt");
