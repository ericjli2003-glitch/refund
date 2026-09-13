-- Installed stores are listed in Refund's store directory unless the merchant
-- hides them. No hide control existed before, so no explicit choice is lost.
ALTER TABLE "MerchantDirectory" ALTER COLUMN "discoveryPublished" SET DEFAULT true;
UPDATE "MerchantDirectory" SET "discoveryPublished" = true;
