-- Null means restock to the order's fulfillment location.
ALTER TABLE "StorePolicy"
ADD COLUMN "returnLocationId" TEXT;
