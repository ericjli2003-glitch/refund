# Shopify App Store submission

This document separates the repository work from the account-bound work that
must be completed in Shopify, the host, and the assistant platforms.

## Suggested listing copy

**App name:** Gooper.io

**Subtitle:** Customer-confirmed returns in AI assistants

**One-line value:** Let verified customers return items across their orders with
explicit confirmation, while you control the return window, refund limit and
return fees.

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

**Pricing: paid, through Shopify App Pricing. Decided 2026-10-28, after a
second rejection.**

History. On 2026-10-09 Shopify paused the submission on requirement **1.2.1
(Use Shopify App Pricing or the Shopify Billing API)** because the listing showed
subscription plans while the app had no way to subscribe. The first fix was to
make the listing free. On 2026-10-28 Shopify paused it again on 1.2.1 ("We were
unable to find the option to subscribe within the app"), because the listing
still showed a subscription. The merchant decided to charge at launch, so the
app now bills through Shopify instead.

How it works (`app/services/app-plan.server.ts`, `app/routes/app.tsx`):

- The plans are defined in the Partner Dashboard under Shopify App Pricing.
  Shopify hosts the plan selection page and creates the subscription; Gooper.io
  never calls `appSubscriptionCreate` or the framework's `billing.request`.
- Every embedded admin page reads `currentAppInstallation.activeSubscriptions`.
  A store with no `ACTIVE` subscription is sent, top frame, to
  `https://admin.shopify.com/store/<store>/charges/<app handle>/pricing_plans`.
  The app handle comes from the same query, so there is no handle to configure.
- A reinstall cancels the old subscription, so the merchant picks a plan again
  (**1.2.2**). Declining leaves them on the plan page and out of the app.
- The dashboard's "Your plan" section names the plan and links to the same
  Shopify page to upgrade or downgrade, with no support contact or reinstall
  (**1.2.3**). Charges appear in the merchant's Shopify bill.
- Development stores get test subscriptions, which Shopify doesn't bill. The
  dashboard says "test charge, not billed" for them.
- The customer connection, return portal and Wix stores don't check the plan.
  Customer returns through an assistant stay off until the merchant turns them
  on in the dashboard, which needs a plan.

**Partner Dashboard setup** (Apps > Gooper.io > Distribution > Manage listing >
Pricing, or the app's Pricing page):

1. Choose **Shopify App Pricing** (formerly "Managed pricing"), not manual
   pricing.
2. Add the plans, monthly, each with a **display name** (the hosted page can
   404 without one): Starter $49 and Growth $199, with the 60-day trial.
3. Describe each plan by its features only. Do **not** list the per-return
   percentage fees: they apply only to funded returns, which are not live, and
   nothing charges them. Listing a charge the app can't make is what caused
   both rejections.
4. Shopify App Pricing charges in USD. The CAD prices in the funded-returns docs
   need either a USD equivalent or Shopify's confirmation that CAD is possible.
5. Save, then install on a clean development store and confirm the plan page
   appears, a plan can be chosen, and the dashboard shows it.

**Still to build before the per-return fees can be charged:** usage charges
through Shopify (App Events API under Shopify App Pricing, or a Billing API
usage line item), then the listing, `/terms` and reviewer instructions updated
to name them. Off-platform billing is prohibited (1.2.1).

## Access-scope rationale

| Scope           | Why Gooper.io needs it                                                                    |
| --------------- | -------------------------------------------------------------------------------------- |
| `read_orders`   | Resolve the customer-owned Shopify order and verify line-item details before a return. |
| `write_orders`  | Submit the refund against the original order transaction after explicit confirmation.  |
| `read_returns`  | Read returnable fulfillments, calculate suggestions, and reconcile return status.      |
| `write_returns` | Request, approve, open, and manage the confirmed Shopify return.                       |
| `read_customers` | Confirm each order belongs to the verified customer before quoting or requesting a return through their assistant. |
| `read_locations` | List the store's locations so the merchant can choose where returned items restock, and find where an order was fulfilled. |
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

Shopify requires working credentials for every login the review needs
(**4.5.4, 4.5.5**). Put them only in the private testing-instructions field in
Partner Dashboard, never in this repository, and re-check each one on the day
you submit. The review needs:

- **The test store** (Pied Piper, `testing-bl7vdfur.myshopify.com`): its
  storefront password if one is set, so the reviewer can reach the store and its
  return page.
- **A customer account on that store** with a paid, fulfilled, returnable order
  placed through the test payment gateway, and a second such order for the
  two-order return.
- **The inbox for that customer's email address.** Shopify customer sign-in
  sends a one-time code there, and Gooper.io's email confirmation is a button
  sent there, so the reviewer can't finish without it. Use a dedicated mailbox
  that opens with only a password (no phone or second-device check), and keep
  it for reviews only.
- **An AI assistant account** that can add a custom connector (Claude or
  ChatGPT), unless the reviewer is told to use their own.

Draft text for the testing-instructions field (fill the bracketed values):

> 1. Install Gooper.io on your development store. Shopify shows Gooper.io's
>    plans; choose Starter. Development stores get a test charge, which is not
>    billed. Plans can be changed later from "Your plan" > Change plan in the
>    app.
> 2. In the app, open the return policy editor, turn on automatic refunds and
>    "Let customers return through their AI assistant", set a return window of
>    30 days and a maximum of 500, and save.
> 3. To see a customer return end to end, use our test store, where returnable
>    orders already exist: [store URL], storefront password [password].
>    Customer email: [email]. Its inbox: [webmail URL], password [password].
>    Shopify sign-in codes and Gooper.io's confirmation email arrive there.
> 4. In Claude (claude.ai, Customize > Connectors) add a custom connector named
>    Gooper.io with the URL https://gooper.io/mcp and connect. [Or: sign in to
>    Claude with [email] / [password].] Approve the connection with the
>    customer email above and press the confirmation button in that inbox.
> 5. Ask: "I'd like to return my [product] from [store name]." The assistant
>    shows the items, any fees and the refund total, and asks before
>    submitting. Say yes. The refund goes to the original (test) payment.
> 6. In Gooper.io in the test store's admin, the return appears under Recent
>    returns. Turning automatic refunds off, or a refund above the maximum,
>    leaves the return for the store to review instead.

Before each submission, walk these steps yourself with the exact credentials in
the field, and replace any order that has already been returned.

The full checks the run should cover:

1. Install Gooper.io, choose a plan on Shopify's page, and open it from Shopify
   admin.
2. In **Policy**, enable automatic refunds, set a return window that includes the
   test order, set a maximum above the test line-item amount, and save.
3. Open the test assistant connector and authenticate with the provided Shopify
   customer account.
4. Ask the assistant to return the test item, or items from two orders at once.
5. Verify the assistant shows the exact items, any fees and the refund total,
   and asks for confirmation before submitting anything.
6. Confirm once. Verify each order reports its own Shopify return/refund status
   and the refund matches the quoted amount in Shopify admin.
7. Repeat with the same request UUID and verify no second refund is created.
8. Return to Gooper.io in Shopify admin and verify the attempt appears in Activity.
9. Demonstrate the disabled state or a quote above the configured maximum to show
   that Gooper.io blocks the automatic action.
10. Change plan from "Your plan" and verify Shopify's page opens and the new plan
    shows in the dashboard.

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
- App Store category, languages, and target regions
- USD prices for Shopify App Pricing (decided prices are CAD)
- Test store, reviewer account, and assistant-host connector configuration
