# Gooper.io for Wix

Gooper.io serves Wix stores alongside Shopify stores. Both share one customer
connection (`/mcp` in ChatGPT or Claude), one store directory, one set of
return rules per store and one return record table. Shopify behaviour is
unchanged: every Wix code path is chosen by the store key, and a Shopify store
never takes one.

This document covers what is built, how to set it up in Wix, and what still
has to be confirmed against a live Wix site before launch.

## How a Wix site fits in

- **Store key.** Every table keys a store by `shop`. A Shopify store uses its
  `*.myshopify.com` domain; a Wix site uses `wix-<instanceId>` (the app
  instance ID, a lowercase UUID). The Wix key has no dot, so it can never be
  mistaken for a domain. Helpers: `app/services/store-platform.server.ts`
  (`isWixStore`, `wixStoreKey`, `normalizeStoreKey`, `storeInstallation`,
  `installedStores`, `publicWebsite`).
- **Installed.** A Shopify store is installed while it has an offline
  `Session`; a Wix site while it has a `WixInstallation` row. Shared code asks
  `storeInstallation`/`installedStores`, never either table directly.
- **Permissions.** Wix permissions stand in for Shopify scopes where shared
  code checks one (`WIX_SCOPE_EQUIVALENTS`; today only `read_products`, which
  final-sale rules need).

## What customers get

The same assistant experience as Shopify stores, reached only through the
all-stores connection:

1. The assistant finds the store (`find_store`, `/stores`, `/llms.txt`). A Wix
   site on a custom domain is listed with that website; a site on a free
   `*.wixsite.com` address is listed without one, because that host is shared
   by the owner's sites.
2. The customer's confirmed email finds their orders (Wix order search on
   `buyerInfo.email`, then an exact ownership check on each order). There is no
   Wix sign-in; `link_store` sends the same one-tap email confirmation.
3. `quote_return` shows items, fees and the refund; `confirm_return` refunds
   the original payment through Wix after a clear yes, immediately or once the
   store receives the item, per the store's setting.
4. `check_return_status` reports progress. Wix sends no return labels, so a
   customer who ships the item can add tracking in chat; it is stored on the
   return (`AgentReturn.trackingNumber`/`trackingUrl`) and shown to the
   merchant.

The public store page `/stores/wix-<instanceId>` is its own page
(`app/components/WixStorePage.tsx`) and shows only the assistant route: the
Shopify sign-in portal and in-page start-return tools don't apply.

## What merchants get

A self-hosted page inside the Wix dashboard, `/wix/dashboard`
(`app/routes/wix.dashboard.tsx`, logic in
`app/services/wix/wix-dashboard.server.ts`):

- Return rules with the same fields and validation as Shopify: automatic
  refunds, refund timing, return window, maximum automatic refund, restocking
  fee, return shipping fee, final-sale collections (Catalog V1) or categories
  (Catalog V3), return instructions and policy page, assistant returns on or
  off. Saving confirms the rules, exactly as on Shopify.
- The store directory listing toggle.
- Recent and archived returns with mark received (with or without restock),
  retry, archive and remove.

The page is identified only by the signed `instance` Wix passes to it
(HMAC-SHA256 with the app secret). It sets no cookies: every form re-sends the
signed instance and each action verifies it again, plus a same-origin check.
The route sends `frame-ancestors` for Wix's dashboard origins and skips
Shopify's document headers.

## How Wix returns and refunds work

Wix has no return object, so a Wix return is Gooper.io's `AgentReturn` row
(`returnId` = `gooper-return:<id>`). Flow in
`app/services/wix/wix-return-flow.server.ts`, Wix calls in
`app/services/wix/wix-returns.server.ts`.

- **Returnable quantity** per line is the least of Wix's refundable quantity,
  ordered minus refunded, and shipped minus refunded, less units held by other
  Gooper.io returns on the order that Wix hasn't refunded yet. Only physical
  lines count, and only orders that are approved, paid and not archived.
- **Rules** come from the store's confirmed Gooper.io rules: window, fees,
  final sale, maximum automatic refund and currency, all checked by the shared
  code before the Wix branch runs.
- **Refund amount** is Wix's calculated refund for the items (shipping not
  refunded), less the restocking fee (percent of each line's discounted
  price before tax, rounded half up per line) and the flat return shipping
  fee, in exact decimals. It must equal what the customer confirmed.
- **Refund** goes to the order's refundable payments through
  `POST /ecom/v1/order-billing/refund-payments`. Orders paid partly by gift
  card or membership are left to the store (Wix refunds their whole credit).
- **No double refunds.** Wix's refund call has no idempotency key, so:
  - each refund's reason carries `Gooper.io ref <hash of the return's key>`,
    and a retry returns that refund instead of refunding again;
  - a refund is refused when the order's items were refunded in Wix since the
    customer's request (Wix's version of Shopify's `settledOrBlocked`);
  - after the return's record exists, its units are rechecked against every
    other unrefunded return, so racing confirmations can't both go ahead;
  - an unclear failure (timeout, 5xx) goes to the merchant as
    `NEEDS_ATTENTION` and never re-arms a button that could refund again.
- **Refund status** arrives on the refund call and, for refunds that finish
  later, through the `wix.ecom.v1.order_transactions_refund_completed`
  webhook. A partly processed refund needs the merchant.
- **Restock** happens with the refund for on-receipt returns. For immediate
  refunds, marking the item received adds the units back to Wix Stores
  inventory directly (Wix has no order-level restock outside a refund).

## Install, uninstall and data

`POST /webhooks/wix` (`app/routes/webhooks.wix.tsx`) verifies each delivery
(RS256 JWT with the app's public key) and deduplicates it.

- **AppInstalled** creates the installation, directory entry and a store policy
  with automatic refunds off. Reinstalling never overwrites the merchant's
  rules.
- **AppRemoved** deletes the same tables Shopify's uninstall does, after Wix
  confirms the app is really gone (it no longer issues the site a token), so a
  replayed removal can't wipe a live site.
- The six-hourly directory sweep refreshes Wix sites too, and removes a site
  Wix no longer issues a token for, but only once another site's token has
  shown the app's own credentials work, so a misconfigured app can never read
  as every site being gone. A sync only updates an installed site; only an
  install creates one, so a sync racing an uninstall can't bring it back.
- A custom domain already held by another store (say the merchant moved from
  Shopify) doesn't block the install: the site is listed under its store key
  until the domain is free.
- A refund-completed webhook that arrives before the return has saved its
  refund ID is refused (503, no receipt) so Wix delivers it again.
- Wix has no mandatory customer-data webhooks like Shopify's. Customers ask the
  store, which forwards the request to Gooper.io support; customers can also
  remove confirmed emails or disconnect in chat or at `/connect/manage`.

## Setting up the Wix app

1. Create the app in the Wix app dashboard (custom app, self-hosted).
2. **OAuth:** use the default client-credentials flow (app ID + secret +
   instance ID). No redirect URL is needed.
3. **Permissions** (request these):
   - Manage Your App (`SCOPE.DC.MANAGE-YOUR-APP`)
   - Manage Orders (`SCOPE.DC-STORES.MANAGE-ORDERS`); if the order-billing
     refund calls are refused with it, use Manage eCommerce - all permissions
     (`SCOPE.DC-ECOM-MEGA.MANAGE-ECOM`)
   - Read Stores - all read permissions (`SCOPE.DC-STORES-MEGA.READ-STORES`) or
     Read Products (`SCOPE.DC-STORES.READ-PRODUCTS`), for final-sale rules
   - Manage Stores inventory, for restocking after an immediate refund
   - Optional: Product read admin (`SCOPE.STORES.PRODUCT_READ_ADMIN`) so hidden
     Catalog V3 products are checked for final sale
4. **Webhooks** to `https://<app>/webhooks/wix`: App Installed, App Removed,
   and Order Transactions Refund Completed. Copy the webhook public key.
5. **Dashboard page:** add a dashboard page extension whose iframe URL is
   `https://<app>/wix/dashboard`.
6. **Environment** (Render, `sync: false`): `WIX_APP_ID`, `WIX_APP_SECRET`,
   `WIX_WEBHOOK_PUBLIC_KEY`. Without them the webhook returns 503 and the
   dashboard refuses to load; Shopify is unaffected.
7. Apply migrations `20260928000000_wix_installation` and
   `20260928010000_agent_return_tracking` (`npm run setup`).

## Shopify is unchanged

Everything Shopify customers and merchants see is byte-for-byte what `main`
serves. This was checked by building `main` and this branch and comparing a
Shopify store's public page, the store directory and search, `/connect`,
`/privacy`, `/terms`, `/support`, `/llms.txt`, the sitemap, the merchant search
API and error pages. Shared text that names Shopify stays as it is for Shopify
stores; Wix stores get their own wording where it has to differ (refund
status, shipping labels). The embedded Shopify admin is not touched.

Because of that, these public texts still describe Gooper.io as a Shopify app
and must be updated when Wix launches publicly:

- the privacy policy (`app/routes/privacy.tsx`) and terms, to disclose Wix
  data processing and how Wix customers make data requests (counsel review);
- the public footer ("Gooper.io for Shopify merchants") and the `llms.txt`
  introduction.

## Tests

- Unit: `npm test` (all Wix modules are registered in `app/test.ts`).
- Integration against the local `refund_ci` Postgres: `npm run test:wix`
  (install, directory search, email store link, replayed and real removal,
  with a Shopify store alongside left untouched).
- The built app was run locally: the dashboard renders, saves rules and
  refuses a tampered instance; the Wix and Shopify store pages and the
  directory render correctly.

## Not yet confirmed against a live Wix site

This environment could not reach dev.wix.com or a Wix test site. Everything
below was built from Wix's SDK sources and must be checked on a Wix test site
with Wix Stores before launch:

- The exact permission scope that allows order-billing refundability,
  calculate and refund calls (step 3 above).
- Whether `buyerInfo.email` search is case-insensitive (emails are searched in
  lowercase, so an order placed with capitals could be missed).
- That Wix keeps a refund's `customerReason` word for word in the refund's
  `details.reason` (the "no double refund" reference relies on it; the
  refunded-since-request check covers it if not).
- That leaving out `refundItems.shipping` refunds no shipping, and that Refund
  Payments accepts an amount below the items' value (fees kept).
- The dashboard `instance` fields and the full list of origins Wix frames the
  dashboard from.
- Which error Wix's token endpoint returns for an uninstalled instance.
- The inventory increment paths used for restocking, and whether hidden V3
  products can be read without `PRODUCT_READ_ADMIN`.

Gooper-funded refunds (the sandbox at `/app/funded-returns`) remain
Shopify-only.
