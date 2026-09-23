-- AlterTable
ALTER TABLE "AgentReturn" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AgentReturn_shop_archivedAt_createdAt_idx" ON "AgentReturn"("shop", "archivedAt", "createdAt");
