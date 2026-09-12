-- Opaque grant identifier for revoke controls, so no token hash is exposed.
-- The volatile default gives every existing row its own value.
ALTER TABLE "AgentAccessGrant"
ADD COLUMN "publicId" TEXT NOT NULL DEFAULT (gen_random_uuid())::text;

CREATE UNIQUE INDEX "AgentAccessGrant_publicId_key" ON "AgentAccessGrant"("publicId");
