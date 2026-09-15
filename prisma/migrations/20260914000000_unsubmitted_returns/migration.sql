-- Return requests Shopify refused for a missing permission never created a
-- return, but were marked as needing merchant review, which told customers not
-- to try again. Mark them not submitted so they can.
UPDATE "AgentReturn"
SET "status" = 'NOT_SUBMITTED'
WHERE "status" = 'NEEDS_ATTENTION'
  AND "returnId" IS NULL
  AND "refundId" IS NULL
  AND ("failureReason" ILIKE '%access denied%' OR "failureReason" ILIKE '%customer_write_customers%');
