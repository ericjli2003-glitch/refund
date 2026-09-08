ALTER TABLE "MerchantDirectory" ADD COLUMN "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "MerchantDirectory" ADD COLUMN "discoveryPublished" BOOLEAN NOT NULL DEFAULT false;
UPDATE "MerchantDirectory" SET "aliases" = ARRAY[lower(trim("name")), lower(trim("name")) || ' storefront'];
-- Discovery publishing is limited to the explicitly approved pilot store.
UPDATE "MerchantDirectory" SET "discoveryPublished" = true,
  "aliases" = ARRAY['testing', 'testing storefront']
WHERE "shop" = 'testing-bl7vdfur.myshopify.com';
