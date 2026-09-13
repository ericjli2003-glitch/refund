# Refund

## Customer MCP connection

Customers can explicitly connect Refund to hosted ChatGPT or Claude using a
merchant-specific remote MCP endpoint. The existing OAuth flow verifies their
Shopify customer identity and obtains assistant consent before exposing purchase,
quote, confirmation and status tools. Connecting is not refund consent.
See [customer connection setup and test limits](docs/AGENT_ACCESS.md).
One connection covers every Refund store: set it up at `/connect` with the MCP
URL `/mcp/stores`, then link each store with that store's own Shopify sign-in the
first time the assistant needs it. By default a linked store stays linked without
another sign-in, using return rules the merchant confirms in Refund. A single
store's connection (`/connect/:shop`, `/mcp/:shop`) is still available.

## Alternative browser flow

Merchant-owned `/agents.md` and Shopify App Proxy entry points are documented in
[Merchant App Proxy setup and proof](docs/MERCHANT_APP_PROXY.md). This optional
path reuses the existing portal and execution engine without a shopper connector
or a required theme embed. It is MCP/browser handoff, not a standard UCP returns API.

Refund is a Shopify app for customer-confirmed returns in compatible AI
browsers. A merchant installs Refund and enables either its storefront app embed
or the merchant-owned agent guide/App Proxy entry;
customers do not install a connector or plugin. When an AI opens that storefront,
WebMCP page tools advertise return support and can open the store's visible
return flow. A customer signs in with the retailer, selects eligible line items,
reviews Shopify's calculated amount, and explicitly confirms before Refund opens
the return and submits an idempotent refund to the original payment method.

This is capability discovery, not background AI-visitor detection. The browser
and assistant need WebMCP for Site Tools or ordinary browser automation for the
portal controls; ordinary text-only ChatGPT/Claude chats do not gain tools
just by mentioning a merchant. See the priority
[connector-free merchant handoff](docs/MERCHANT_BROWSER_HANDOFF.md) and its live
acceptance checklist.

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
- Customer identity is stored as a keyed hash. The one exception is an
  assistant store link that stays active without a new sign-in, which keeps the
  verified Shopify customer ID encrypted (AES-256-GCM) so Refund can act for
  that customer. Disconnecting the assistant, customer redaction, uninstall and
  a year without use delete it.
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

Installing Refund and opening its Shopify app provisions the store identity,
merchant directory entry, store currency, and initial settings automatically.
The hosted `/returns/SHOP.myshopify.com` portal supports customer verification,
purchase lookup, estimates, and resumable drafts without a theme embed or a
separate Refund account. Shopify customer accounts must be available on the store.
Automatic refund payments remain optional and off for a new installation. An
estimate created while they are off has a signed non-submittable flag; enabling
payments later cannot turn that old estimate into authorization.

The theme embed is an optional extra for discovery directly on merchant pages.
Shopify requires the merchant to activate it in the theme editor and save; the
dashboard provides that direct link and checks activation on the published theme.
Reauthentication never overwrites the merchant's existing financial settings.

### Merchant-name discovery pilot

`/stores` and `/api/merchants?query=Testing%20Storefront` expose only published,
currently installed merchants. `/stores/testing-bl7vdfur.myshopify.com` is the
public Testing Storefront return page and registers the same top-level tools as
the theme embed. The page includes canonical metadata, visible merchant identity,
structured data, and a sitemap entry. Installed stores are listed by default, and
a merchant can hide the store from the Refund dashboard. `/llms.txt` lists them for
assistants, and the public MCP's `find_store` tool searches them by partial name or
website, returning every match for the customer to choose from.

Intake accepts exact published names/aliases as well as domains. Multiple name
matches require the customer to identify the website; no match is selected by
default. Search engines and ChatGPT must still discover/index the public page.
Publishing it does not guarantee immediate name-only discovery in a blank chat.

### Continue in chat after verification

After successful top-level Site Tools registration, the authenticated portal
shows “You’re connected. Continue in chat.” Purchases are expandable for a
customer who prefers the form. Quotes, errors, sign-out, and submission status
remain visible. Without Site Tools, the ordinary purchase form stays expanded.
The intake and portal tools ask the assistant to present results in the
conversation and keep the portal loaded in a background tab where supported.
Refund cannot hide ChatGPT's browser panel or focus the chat itself. Closing or
navigating the page can remove its tools; Shopify sign-in remains a visible
customer action. See [OpenAI Site Tools](https://learn.chatgpt.com/docs/webmcp).

### Crawl rules are discovery support, not tool registration

Shopify already provides `robots.txt`. Do not replace merchant rules or add a
mandatory theme-edit step during installation. Refund's own `/robots.txt` allows
public merchant profiles and advertises `/sitemap.xml`, while excluding private
return, customer, and API routes. OAI-SearchBot uses the existing wildcard group;
no additional agent-specific allow-all group is needed. Crawl permission does
not guarantee indexing, enable WebMCP, authorize a return, or bypass sign-in.
See [OpenAI crawler roles](https://developers.openai.com/api/docs/bots) and
[Shopify robots.txt customization](https://shopify.dev/docs/storefronts/themes/seo/robots-txt).

On 2026-09-08, Testing's public `robots.txt` already allowed public crawling and
linked Shopify shopping-agent/UCP discovery pages. Its `/agents.md` URL returned
the password-protected storefront page to an unauthenticated request. Those
comments do not register Refund tools. A future merchant-specific crawl-rule
adjustment should follow an observed block and preserve existing/default rules;
the public Refund profile remains the current discovery surface for this pilot.

The `refund-site-tools` theme app extension registers two page-scoped tools in
browsers that support WebMCP:

- `get_store_return_options` reports merchant preflight checks, return
  support, and recovery guidance.
- `start_return` calls the anonymous intake endpoint and returns a short-lived
  Shopify verification URL plus a privacy-safe correlation ID. It also updates
  the visible return link. It does not read purchases, create a return, or issue
  a refund.

Both tools are registered by JavaScript in the top-level storefront page, not
inside an iframe. The embed also publishes merchant/return metadata in the page
for browser discovery. `/api/merchant-readiness?merchant=STORE` checks whether
the store is connected, its quote policy, Shopify discovery endpoints, and public
theme markup without exposing customer data. Password gates are reported explicitly.
This cannot certify browser registration or authenticated customer API access.

After deploying the extension, each merchant enables **AI return assistance**
once from the theme app-embed settings. The separate **Show the return button**
setting may remain off; the page tools stay available. The panel links to
`/returns/SHOP.myshopify.com` on the hosted app, not the native orders page.
The customer signs in to authorize this app (a storefront login alone is not
app authorization). The portal registers `get_return_session`,
`check_return_status`, `find_returnable_items`, `quote_return`, and
`confirm_return`; it also works as a normal customer-facing page. The first two
tools are protected, read-only recovery operations. A quoted draft is stored for
14 days, scoped to a hashed customer identity, merchant, and individual draft.
Intake creates a durable 30-minute anonymous draft; an idempotency key preserves
its reference across retries. Shopify verification claims that same draft.
Submission history remains independent of draft expiry or replacement. Its signed quote
credential is encrypted at rest and only restored while valid. Fresh Shopify
verification is still required after the browser session expires.
Its support indicator distinguishes registered browser tools from missing support
or registration failure. Successful page registration is not proof that a
particular assistant can use those tools.

Quotes expire after ten minutes and are bound to the customer, shop, items,
quantities, amount, and currency. Login and quote requests perform no Shopify
return/refund mutations. The merchant's limit is checked against Shopify's
`shopMoney`; the customer confirms and receives `presentmentMoney` in their order
currency. A policy/store-currency mismatch fails closed; do not change merchant
policy just to make a test pass. This version refunds only the original
payment method and does not provide a separate instant-debit payout or generate
return shipping labels.

## Optional remote MCP connector

### Public merchant intake

`/mcp` now exposes a single anonymous `start_return` tool. It accepts a merchant
website plus optional `orderName` and `itemName` hints and returns a secure
`continueUrl`. The same operation is available as JSON POST `/api/return-intake`.
`/start-return` provides a human-readable entry page and accepts the same three
query parameters for storefront handoffs. No customer account or Refund
connector authorization is needed to prepare this link.

The link carries encrypted, authenticated hints, expires after 30 minutes, and
is bound to one shop. It does not contain customer credentials, prove purchase
ownership, or authorize any return/refund. Hints survive the Shopify sign-in
flow, including cancellation/retry. The portal still requires customer
authentication, a fresh exact quote, and explicit confirmation.

Canonical installed `*.myshopify.com` domains work immediately. Primary custom
domains are recorded from Shopify on app authentication, whenever the
merchant opens the Refund dashboard, and by background directory maintenance.
Custom-domain requests are rechecked
against that installed shop's Admin API; Refund never fetches a caller-supplied
website to infer the shop. Store names resolve only when they uniquely match a
published merchant profile. An unresolved store is not a determination of return eligibility.

The merchant directory migration must run before serving the updated app.
The production server automatically backfills existing installations after startup
and refreshes their domains every six hours. A database lease coordinates replicas;
failed shops retry after fifteen minutes. The job preserves publication settings
and merchant policy. New installations register during authentication; uninstall
and shop redaction remove the mapping.

Public intake, discovery and OAuth entry points use shared PostgreSQL rate limits,
with hashed client addresses, HTTP 429 and Retry-After. Run the additive
`20260911000000_public_rate_limits` migration before serving this version. A database
outage returns 503 at these endpoints. Configure `REFUND_TRUST_PROXY_HOPS` to the
actual fixed proxy count (1 on Render; 0 for a direct server); the proxy must append
the real client address. Extra edge protection can reduce database load under abuse.
JSON intake bodies remain bounded to 16 KiB. These controls run in the production
HTTP entry point, not the Shopify CLI's plain Vite development server.

The theme's `get_store_return_options` advertises the public HTTP/MCP addresses.
Its launcher now goes through `/start-return`, and can remain hidden. Publish
the updated theme extension after the backend deployment is live.

**Availability boundary:** anonymous MCP means no customer authentication for
intake, not automatic discovery in every chat. The host still needs access to
these tools, or a compatible browser must visit the store. Verification happens
on Shopify's secure page. The current continuation resumes in the customer
portal; it does **not** link a ChatGPT/Claude account, issue an agent access token,
or resume protected remote tools. A Refund OAuth provider and host registration
are now implemented through a merchant-specific OAuth connection. The browser
sign-in and exact-quote flow has been verified in the development store; each
native host still needs its own connection and live acceptance test.

### Protected store tools

The protected store endpoint is reserved for customer-approved Refund grants:

```text
https://YOUR_APP_HOST/mcp/SHOP.myshopify.com
```

The backend supports hosted ChatGPT/Claude OAuth connection testing. The legacy Shopify-token
pass-through has been removed. Cookies, Shopify tokens, intake links and quotes
cannot authorize this endpoint. It accepts only separate, expiring Refund grants
bound to an approved client, customer session, store and resource, with per-tool
`returns:read`, `returns:quote`, or `returns:submit` permissions. Submission still
requires the exact signed quote and affirmative customer confirmation.

The production HTTP server mounts the MCP SDK's OAuth handlers, durable dynamic
client registration, and a separate customer consent page. A single-use S256
PKCE code exchange mints the grant; no MCP tool exposes token minting. The
metadata points to Refund's issuer, not Shopify. Customer sign-in resumes the
assistant consent screen, then returns a code to the exact host callback.
See [connection setup and test limits](docs/AGENT_ACCESS.md).

## Production deployment

The app uses PostgreSQL and runs Prisma migrations before starting the server.
`render.yaml` and the multi-stage `Dockerfile` provide a Render deployment path:

1. Create a Render Blueprint from this repository and branch.
2. Set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, and
   `PUBLIC_SUPPORT_EMAIL` in Render. The blueprint supplies `DATABASE_URL`.
   Also set `REFUND_SECRET` to a long random value so rotating the Shopify app
   secret cannot orphan Refund's sealed data or customer identity hashes. On an
   existing deployment, set `REFUND_PREVIOUS_SECRETS` to the current
   `SHOPIFY_API_SECRET` value at the same time; see `docs/PROJECT_STATE.md`.
3. Keep `application_url`, the `/auth/callback` admin redirect,
   `[customer_authentication]` `/customer/callback` redirect and JavaScript origin,
   aligned to the deployed HTTPS host. Storefront URLs are generated from that
   configuration's `application_url` by `npm run storefront:configure`.
   Configure the customer scopes in `shopify.app.toml` and `SCOPES`, and request
   the appropriate protected-customer-data access. App-client OAuth uses PKCE;
   no per-merchant Headless OAuth client is needed for this portal.
4. Run `shopify app config validate`, then `npm run deploy` to publish the
   app configuration and webhook subscriptions. The deploy wrapper regenerates
   the storefront URLs and pins the same configuration for Shopify CLI. For a
   separate app use `npm run deploy -- --config staging`; it reads
   `shopify.app.staging.toml`. Keep that app's backend `SHOPIFY_APP_URL` aligned.
5. Install on a development store and run the end-to-end checklist in
   `docs/SHOPIFY_APP_STORE_SUBMISSION.md`.

The `/health` route checks database connectivity and returns HTTP 503 if the app
cannot reach PostgreSQL.

## Connector-free ChatGPT desktop test (stop after quote)

1. Install Refund and open its Shopify app. The hosted return portal is available
   without activating automatic payments or the theme embed. For the storefront
   variant of this test, activate **AI return assistance** in the published theme.
2. Use the latest ChatGPT desktop app with Site tools enabled. Choose GPT-5.6
   Sol or GPT-5.6 Terra. Do not install or enable the Refund connector.
3. Start a blank Work/Codex conversation with no storefront tab open and say:
   `Return the snowboard I bought from Testing Storefront at https://testing-bl7vdfur.myshopify.com/. Navigate to the store
   yourself, use its site tools, and stop after showing me the quote. Do not
   submit a return or refund.`
4. If prompted, unlock the storefront yourself in the built-in browser. Do not
   remove the store password just for this test. Confirm that ChatGPT navigates
   to the Testing storefront and that the address
   bar lists `get_store_return_options` and `start_return` as site tools.
5. Let ChatGPT call `start_return` and open its `continueUrl`. Complete Shopify
   customer verification yourself; never give the assistant the sign-in code.
6. Back in the Refund portal, confirm its site tools include
   `get_return_session`, `check_return_status`, `find_returnable_items`, and
   `quote_return`. Let ChatGPT find the snowboard and calculate the quote.
7. Stop when the exact item, quantity, currency, amount, expiry, and correlation
   ID are shown. Do not call `confirm_return` and do not click **Confirm return
   and refund**.
8. To test recovery, close and reopen the portal while the customer session is
   valid, then ask: `Use get_return_session to resume my draft. Do not submit
   it.` The same correlation ID and quote should return until expiry; an expired
   quote must instruct the agent to run `quote_return` again.

Providing the exact URL tests connector-free navigation and tool discovery;
resolving the generic name "Testing Storefront" alone is a separate, unproven
merchant-identification test. Site tools are rollout-dependent and are currently
unavailable with Luna or Enterprise/Edu; if no tools appear, check host support
before interpreting that as a Refund failure.

For the new merchant-discovery acceptance test, start a separate blank conversation
with just: `I want to return my snowboard from Testing Storefront.` Confirm the
assistant identifies the exact Shopify domain or its Refund return page before
authentication. If it cannot find the store, stop without starting a return.
When Refund's `/stores` page is available, call `report_merchant_discovery_failure`
with only `merchant: "Testing Storefront"`, then stop. Do not use a URL fallback
to continue the return, substitute another store or product, or contact the merchant.
When discovery succeeds, stop at the quote. The storefront password
does not gate the public Refund merchant page; Shopify customer verification remains
required for all private purchase data.

### Private merchant opportunities

Unresolved intake and explicit store-finder POST searches stop without returning a
verification link, creating a return draft, looking up purchases, or quoting. Refund
records a private `MerchantOpportunity` for the owner, never in a merchant dashboard,
customer response, notification, or merchant outreach. On `/stores`, the top-level
`find_merchant_return_page` and `report_merchant_discovery_failure` tools provide
the connector-free lookup/report path. A report always stops—even if the merchant
is already installed. Failed searches entirely inside ChatGPT are invisible to
Refund unless the assistant visits Refund or calls the reporting endpoint.

Owner access: run `npm run opportunities` in the trusted Refund backend shell with
its existing database access (for example, the Render service shell). It lists the
100 most recently seen, nonexpired records. There is no public read/export API and
no merchant permission grants access to this report. Entries are unreviewed signals,
not verified sales leads or unique customer counts. `DISCOVERY_GAP` identifies a
uniquely matched installed store; `AMBIGUOUS_MATCH` identifies multiple matches;
`UNRESOLVED_MERCHANT` is a possible merchant opportunity, not proof of noninstallation.

Only a bounded business label or domain, category, source and timestamps are stored.
URL paths/queries, emails, customer identifiers, item/order hints, conversation text,
credentials and IP addresses are excluded. Reports deduplicate by normalized label
per UTC day and expire after 90 days; expired rows are removed during later reporting
activity. Reporting is capped at 30 accepted attempts per minute per app process;
this is an abuse guard, not a distributed unique-visitor counter. All reports remain
untrusted and must be reviewed before any owner-initiated outreach. Known-store rows
are deleted on uninstall/shop redaction. Passive `/stores` and `/api/merchants` GET
requests never create opportunities. Diagnostic failures never allow a return to
proceed; intake stops and emits only a safe correlation ID in server warnings.

> The previous local SQLite database is not compatible with the PostgreSQL
> migration history. Use PostgreSQL; do not point these migrations at SQLite.

## Repository checks

GitHub Actions runs schema validation, tests, type checking, linting, and the
production build on pull requests and pushes to `main`.

## Submission

See [docs/SHOPIFY_APP_STORE_SUBMISSION.md](docs/SHOPIFY_APP_STORE_SUBMISSION.md)
for listing copy, access-scope explanations, reviewer steps, asset requirements,
and the remaining Partner Dashboard tasks.
