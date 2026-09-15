# Shopify App Store submission

This document separates the repository work from the account-bound work that
must be completed in Shopify, the host, and the assistant platforms.

## Suggested listing copy

**App name:** Gooper.io

**Subtitle:** Customer-confirmed returns in AI assistants

**One-line value:** Let authenticated customers complete eligible returns with
explicit confirmation while you control the return window and refund limit.

**Description:**

Gooper.io connects your Shopify return workflow to compatible AI assistants.
Customers authenticate with their Shopify customer account, choose eligible
items from their own orders, review Shopify's calculated amount, and explicitly
confirm before anything is submitted.

You control which returns can complete automatically with a master enable switch,
return-window limit, maximum automatic refund amount, and currency setting.
Gooper.io rechecks eligibility before execution, prevents duplicate refunds with
idempotency controls, and reconciles status through Shopify webhooks. Attempts
that need human review remain visible in the merchant activity dashboard.

**Feature bullets:**

- Customer Account authentication limits access to the customer's own orders.
- Exact return quote is recalculated before confirmation.
- Merchant-controlled return window and maximum automatic amount.
- Duplicate-safe return and refund execution.
- Activity and privacy-request views inside Shopify admin.

**Pricing recommendation for initial review:** Free. Add billing only after the
core workflow has been validated with real merchants. If paid plans are added,
use Shopify Billing and update the listing, terms, and reviewer instructions.

## Access-scope rationale

| Scope           | Why Gooper.io needs it                                                                    |
| --------------- | -------------------------------------------------------------------------------------- |
| `read_orders`   | Resolve the customer-owned Shopify order and verify line-item details before a return. |
| `write_orders`  | Submit the refund against the original order transaction after explicit confirmation.  |
| `read_returns`  | Read returnable fulfillments, calculate suggestions, and reconcile return status.      |
| `write_returns` | Request, approve, open, and manage the confirmed Shopify return.                       |
| `read_products` | Check whether an item is in a collection the merchant marked final sale, for returns customers make through their assistant. |
| `customer_read_customers` | Verify the signed-in customer's identity in their own account. |
| `customer_read_orders` | Read that customer's purchases and calculate return quotes. |
| `customer_write_customers` | Shopify requires it to request a return in the signed-in customer's account (`orderRequestReturn`). |
| `customer_write_orders` | Request the customer-confirmed return in their own account. |

Request protected customer data access for order and customer fields used in the
workflow, including Level 2 access to the order email: Gooper.io matches the email
a customer gives their assistant against the store's orders before emailing
that address a one-tap confirmation. The app hashes the customer identifier in operational records and does
not store Customer Account access tokens there.
Short-lived portal tokens are encrypted in `CustomerReturnSession`, separate
from operational records, and are purged by redaction and uninstall handlers.
Assistant store links that stay active without a new sign-in keep the verified
Shopify customer ID encrypted; customer redaction, uninstall, disconnecting the
assistant and a year without use delete them.

## Reviewer test instructions

Provide Shopify with a development store and customer account that has a paid,
fulfilled, returnable order. Include credentials only in the private reviewer
fields in Partner Dashboard, never in this repository.

1. Install Gooper.io and open it from Shopify admin.
2. In **Policy**, enable automatic refunds, set a return window that includes the
   test order, set a maximum above the test line-item amount, and save.
3. Open the test assistant connector and authenticate with the provided Shopify
   customer account.
4. Ask the assistant to find returnable items, quote one item, and start a return.
5. Verify that the assistant shows the exact item, quantity, currency, and amount
   before asking for explicit confirmation.
6. Confirm once. Verify the assistant returns the Shopify return/refund status.
7. Repeat with the same request UUID and verify no second refund is created.
8. Return to Gooper.io in Shopify admin and verify the attempt appears in Activity.
9. Demonstrate the disabled state or a quote above the configured maximum to show
   that Gooper.io blocks the automatic action.

If a live refund would create cost or operational risk, use a Shopify test payment
gateway and state that clearly in the reviewer notes.

## End-to-end pre-submission checks

- Install, OAuth callback, embedded navigation, and reauthorization work on a
  clean development store.
- Policy defaults are safe: automatic refunds remain off until the merchant
  enables them.
- Customer Account OAuth metadata and bearer challenges use the final HTTPS host.
- A customer cannot access another customer's order or line items.
- Invalid quantity, expired return window, mixed currency, amount above the limit,
  stale quote, and duplicate UUID are rejected safely.
- A successful return uses Shopify's latest calculated amount and the original
  payment method.
- Partial failures show `NEEDS_ATTENTION` and enough context for merchant support.
- Return and refund webhooks reconcile status and tolerate duplicate delivery.
- Customer data request creates a merchant-downloadable report.
- Customer redact, shop redact, and uninstall delete the relevant local data.
- `/privacy`, `/terms`, `/support`, and `/health` are public over HTTPS.
- The public support email is monitored and matches the listing.
- No placeholder URL, copy, credential, or test store appears in production.
- Mobile and desktop screenshots match the submitted app version.

## Listing assets to prepare

- App icon at Shopify's current required dimensions, with no text too small to
  read and no Shopify trademark misuse.
- At least three screenshots showing Policy, Activity, and the confirmed customer
  flow. Remove or fictionalize personal information.
- Optional short demo video showing authentication, quote, confirmation, and the
  merchant activity result.
- A concise key-benefits image only if it adds information beyond screenshots.

Confirm exact dimensions and count in Partner Dashboard when uploading because
Shopify can change listing asset specifications.

## Account-bound launch sequence

1. Deploy the `main` branch and provision PostgreSQL.
2. Set all production environment variables, including a monitored
   `PUBLIC_SUPPORT_EMAIL`.
3. Replace `https://example.com` in `shopify.app.toml` with the final host.
4. Validate and deploy the Shopify app configuration.
5. Request protected customer data access in Partner Dashboard.
6. Configure the Customer Account OAuth client and assistant callback URLs.
7. Complete the test matrix above on a clean development store.
8. Capture final listing assets, complete the listing fields, and submit for
   review.

## Known manual decisions

- Final production hostname and hosting account
- Legal publisher/entity name and governing-law language, if required
- Monitored support email and support response process
- App Store category, languages, target regions, and final pricing
- Test store, reviewer account, and assistant-host connector configuration
