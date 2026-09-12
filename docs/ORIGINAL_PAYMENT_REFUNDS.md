# Original-payment refund workflow

Refund uses the merchant's Shopify installation to submit refunds through the
original payment processor. Customers sign in with the retailer's Shopify
Customer Account. They do not open a separate Refund account or provide a new
card, bank account, or payout destination.

## Merchant setup

In Refund's embedded dashboard, enable automatic refund payments and save the
return window and maximum amount. New installations default to estimates only.
Enabling payments authorizes eligible refunds on customer confirmation, before
the merchant receives or inspects the goods. The merchant bears the risk of
unreturned items and must provide return-shipping instructions.

## Customer flow

1. Open the merchant's return portal and sign in with the retailer.
2. Choose eligible items and quantities.
3. Review Shopify's exact amount, currency, original-payment destination,
   quote expiry, and return-shipping instructions.
4. Explicitly confirm to open the return and submit the refund.
5. View the result or refresh return status. Submission history also survives
   page reloads and is available through the assistant's status tool.

Every submission rechecks ownership, eligibility, merchant policy, and amount.
The signed quote supplies the retry key. Repeating that confirmation returns
the existing attempt, including a failure, without issuing another payment.

## Payment boundary

Shopify's suggested payment allocations must sum exactly to the confirmed
amount in the same currency. Each allocation must reference a distinct original
transaction and its existing gateway. Missing original transactions, manual
payment gateways, replacement gateways, and invalid totals stop payment
submission and require merchant attention. Mixed original payment methods are
supported when all allocations pass these checks.

The implementation uses `returnProcess` after return approval, which transfers
the refund and disposes the return's line items (restocking them at the
resolved location, or not restocking when none resolves) in the same call.
See `docs/PROJECT_STATE.md` for what that migration did and did not resolve.

## Status meaning

- **Refund submitted:** Shopify created a refund record. Processor completion
  has not been confirmed here.
- **Refund processed by Shopify:** All returned refund transactions report
  success. This does not prove the customer's bank has posted the credit.
- **Merchant review needed:** A payment failed or the return needs attention.
  A split refund might have partially succeeded; do not blindly retry.

Status reflects the submission response and recorded Shopify webhooks. Refresh
loads the latest stored evidence; it does not query the customer's bank or
guarantee a fresh processor update. A refund-created webhook alone is not proof
of payment success. Webhooks preserve failed attempts and do not downgrade
successful processor evidence with older pending data.

Refund does not advance money, purchase refund receivables, issue a new card,
promise instant bank settlement, or automatically generate shipping labels.

## Verification

`npm test` covers payment allocation, status interpretation, signed quotes and
consent. `npm run test:proxy`, against an isolated local `refund_ci` database,
exercises customer verification, quotes, confirmation, retry, processor failure,
and signed refund webhooks. Shopify network responses are fixtures; these tests
do not issue live refunds or certify App Store approval.

Before release, exercise a Shopify test-gateway order end to end and verify
that the refund transaction points to its original payment. A live-money test
requires a separately authorized purchase/refund.

References: [OrderTransaction](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/OrderTransaction),
[return-processing migration](https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps/migrate-to-return-processing).
