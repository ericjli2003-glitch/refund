# Refund

Refund is a Shopify app for customer-confirmed returns in compatible AI
browsers. A merchant installs Refund once and enables its storefront app embed;
customers do not install a connector or plugin. When an AI opens that storefront,
WebMCP page tools advertise return support and can open the store's visible
return flow. A customer signs in with the retailer, selects eligible line items,
reviews Shopify's calculated amount, and explicitly confirms before Refund opens
the return and submits an idempotent refund to the original payment method.

## What the app does

1. `find_returnable_items` reads recent returnable purchases from the
   authenticated customer's Shopify Customer Account API context.
2. `quote_return` recalculates Shopify's expected total for the exact line items
   and quantities.
3. `confirm_return` requires explicit confirmation and the signed `quoteToken`
   returned by `quote_return`. The quote supplies a stable retry key. It rechecks
   customer ownership, returnability, store policy, currency, and amount before
   creating the return and refund.
4. Webhooks reconcile return and refund status. Duplicate requests and duplicate
   webhook deliveries are safe.

The merchant controls a master enable switch, return window, maximum automatic
refund amount, and currency in the embedded Shopify admin app. Attempts that
cannot finish cleanly are marked `NEEDS_ATTENTION` for merchant review.

## Privacy and safety

- Customer access tokens are validated for each MCP request and are not stored
  in operational return records.
- The browser portal stores short-lived customer tokens encrypted in a separate
  session table. Only an opaque, Secure, HttpOnly cookie reaches the browser.
  PKCE, one-use state, verified ID-token signatures/nonce, and same-origin CSRF
  checks protect sign-in and portal actions. Sessions are removed on sign-out,
  expiry cleanup, customer redaction, shop redaction, and uninstall.
- Customer identity is stored as a keyed hash, not a raw customer ID.
- Refund does not collect card numbers. Shopify refunds the original order
  transaction.
- The app handles Shopify's customer data-request, customer-redaction,
  shop-redaction, and uninstall webhooks.
- Public policies are available at `/privacy`, `/terms`, and `/support`.

## Local development

Requirements: Node.js 22.18 or newer, Shopify CLI, and PostgreSQL.

```sh
cp .env.example .env
npm ci
npm run setup
npm run dev
```

Update `.env` with the Shopify app credentials, local PostgreSQL URL, and public
app URL. Never commit `.env`.

Run the complete local verification suite:

```sh
npm run prisma:validate
npm test
npm run typecheck
npm run lint
npm run build
```

## Storefront WebMCP

The `refund-site-tools` theme app extension registers two page-scoped tools in
browsers that support WebMCP:

- `get_store_return_options` advertises return support and the store's secure
  customer-return portal entry point.
- `start_store_return` opens the same visible return panel a shopper can use
  directly. It does not create a return or issue a refund.

After deploying the extension, each merchant enables **AI return assistance**
once from the theme app-embed settings. The separate **Show the return button**
setting may remain off; the page tools stay available. The panel links to
`/returns/SHOP.myshopify.com` on the hosted app, not the native orders page.
The customer signs in to authorize this app (a storefront login alone is not
app authorization). The portal registers `find_returnable_items`, `quote_return`,
and `confirm_return`; it also works as a normal customer-facing page.

Quotes expire after ten minutes and are bound to the customer, shop, items,
quantities, amount, and currency. Login and quote requests perform no Shopify
return/refund mutations. The merchant's limit is checked against Shopify's
`shopMoney`; the customer confirms and receives `presentmentMoney` in their order
currency. A policy/store-currency mismatch fails closed; do not change merchant
policy just to make a test pass. This version refunds only the original
payment method and does not provide a separate instant-debit payout or generate
return shipping labels.

## Optional remote MCP connector

Each installed shop receives this endpoint after deployment:

```text
https://YOUR_APP_HOST/mcp/SHOP.myshopify.com
```

The connector is an optional integration path, not a customer requirement. Its
bearer token must be a Shopify Customer Account API token for that shop. The
required customer scope is `openid email customer-account-api:full`. Configure
customer accounts, protected customer data access, a Customer Account OAuth
client, and the exact callback URLs required by the assistant host before using
this path.

## Production deployment

The app uses PostgreSQL and runs Prisma migrations before starting the server.
`render.yaml` and the multi-stage `Dockerfile` provide a Render deployment path:

1. Create a Render Blueprint from this repository and branch.
2. Set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, and
   `PUBLIC_SUPPORT_EMAIL` in Render. The blueprint supplies `DATABASE_URL`.
3. Keep `application_url`, the `/auth/callback` admin redirect,
   `[customer_authentication]` `/customer/callback` redirect and JavaScript origin,
   and the two portal URLs in the theme block aligned to the deployed HTTPS host.
   Configure the customer scopes in `shopify.app.toml` and `SCOPES`, and request
   the appropriate protected-customer-data access. App-client OAuth uses PKCE;
   no per-merchant Headless OAuth client is needed for this portal.
4. Run `shopify app config validate`, then `shopify app deploy` to publish the
   app configuration and webhook subscriptions.
5. Install on a development store and run the end-to-end checklist in
   `docs/SHOPIFY_APP_STORE_SUBMISSION.md`.

The `/health` route checks database connectivity and returns HTTP 503 if the app
cannot reach PostgreSQL.

> The previous local SQLite database is not compatible with the PostgreSQL
> migration history. Use PostgreSQL; do not point these migrations at SQLite.

## Repository checks

GitHub Actions runs schema validation, tests, type checking, linting, and the
production build on pull requests and pushes to `main`.

## Submission

See [docs/SHOPIFY_APP_STORE_SUBMISSION.md](docs/SHOPIFY_APP_STORE_SUBMISSION.md)
for listing copy, access-scope explanations, reviewer steps, asset requirements,
and the remaining Partner Dashboard tasks.
