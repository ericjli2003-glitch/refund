# Refund

Refund is a Shopify app and remote MCP server for customer-confirmed returns in
ChatGPT, Claude, and other compatible assistants. A customer authenticates with
the retailer's Shopify customer account, selects their own eligible line items,
reviews Shopify's calculated amount, and explicitly confirms. Refund then opens
the return and submits an idempotent refund to the original payment method.

## What the app does

1. `find_returnable_items` reads recent returnable purchases from the
   authenticated customer's Shopify Customer Account API context.
2. `quote_return` recalculates Shopify's expected total for the exact line items
   and quantities.
3. `confirm_return` requires explicit confirmation and a new UUID. It rechecks
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
- Customer identity is stored as a keyed hash, not a raw customer ID.
- Refund does not collect card numbers. Shopify refunds the original order
  transaction.
- The app handles Shopify's customer data-request, customer-redaction,
  shop-redaction, and uninstall webhooks.
- Public policies are available at `/privacy`, `/terms`, and `/support`.

## Local development

Requirements: Node.js 20.19 or newer, Shopify CLI, and PostgreSQL.

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

## Customer-agent connector

Each installed shop receives this endpoint after deployment:

```text
https://YOUR_APP_HOST/mcp/SHOP.myshopify.com
```

The bearer token must be a Shopify Customer Account API token for that shop. The
required customer scope is `openid email customer-account-api:full`. Configure
customer accounts, protected customer data access, a Customer Account OAuth
client, and the exact callback URLs required by the assistant host before
distributing the connector.

## Production deployment

The app uses PostgreSQL and runs Prisma migrations before starting the server.
`render.yaml` and the multi-stage `Dockerfile` provide a Render deployment path:

1. Create a Render Blueprint from this repository and branch.
2. Set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, and
   `PUBLIC_SUPPORT_EMAIL` in Render. The blueprint supplies `DATABASE_URL`.
3. After the first successful deployment, replace both `https://example.com`
   values in `shopify.app.toml` with the deployed HTTPS origin and `/api/auth`
   callback.
4. Run `shopify app config validate`, then `shopify app deploy` to publish the
   app configuration and webhook subscriptions.
5. Install on a development store and run the end-to-end checklist in
   `docs/SHOPIFY_APP_STORE_SUBMISSION.md`.

The `/health` route checks database connectivity and returns HTTP 503 if the app
cannot reach PostgreSQL.

> The previous local SQLite database is not compatible with the PostgreSQL
> migration history. This project has not been deployed to production, so start
> with a new PostgreSQL database.

## Repository checks

GitHub Actions runs schema validation, tests, type checking, linting, and the
production build on pull requests and pushes to `main`.

## Submission

See [docs/SHOPIFY_APP_STORE_SUBMISSION.md](docs/SHOPIFY_APP_STORE_SUBMISSION.md)
for listing copy, access-scope explanations, reviewer steps, asset requirements,
and the remaining Partner Dashboard tasks.
