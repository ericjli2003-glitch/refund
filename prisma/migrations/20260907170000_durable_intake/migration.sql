ALTER TABLE "CustomerReturnSession" ADD COLUMN "draftId" TEXT;
ALTER TABLE "ReturnDraft" ALTER COLUMN "customerSubjectHash" DROP NOT NULL;
ALTER TABLE "ReturnDraft" ADD COLUMN "intakeKeyHash" TEXT;
ALTER TABLE "ReturnDraft" ADD COLUMN "inputHash" TEXT;
ALTER TABLE "ReturnDraft" ADD COLUMN "sealedHints" TEXT;
DROP INDEX "ReturnDraft_shop_customerSubjectHash_key";
CREATE INDEX "ReturnDraft_shop_customerSubjectHash_updatedAt_idx"
ON "ReturnDraft"("shop", "customerSubjectHash", "updatedAt");
CREATE UNIQUE INDEX "ReturnDraft_intakeKeyHash_key" ON "ReturnDraft"("intakeKeyHash");
