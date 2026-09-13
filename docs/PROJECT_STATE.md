# Project state, open decisions, and review findings

Shared context for any agent or developer picking this repository up. Update it
when a decision below is resolved; do not let it drift into a changelog.

Last reviewed: 2026-09-12, against `claude/project-state`.

## Shopify App Store compliance status

### Requirements currently met

- **Requirement 1.1.15, refunds only through the original payment processor.**
  Enforced for published apps since 2026-04-22. `executeAutomaticReturn`
  submits the refund through `returnProcess` using allocations from the
  return's `suggestedFinancialOutcome`, validates each allocation against an
  existing original transaction and gateway, and rejects manual and replacement
  gateways. Refund advances no money and creates no separate payout
  destination. See `docs/ORIGINAL_PAYMENT_REFUNDS.md`.
- **Customer Account API for buyer-facing returns authentication.** Built for
  Shopify requires this for returns and exchanges apps effective 2026-12-01.
  The portal already uses Customer Account OIDC with PKCE, one-use state, and
  verified ID-token signature and nonce.
- **Return processing migration.** Shopify introduced return processing in
  Admin API 2025-07 and states that existing returns apps should migrate to
  `returnProcess`. `executeAutomaticReturn` now processes the approved return
  with `returnProcess` instead of leaving it `OPEN` and calling `refundCreate`
  separately. See below for what this closed and what it left open.

Current flow in `app/services/automatic-return.server.ts`:

```
orderRequestReturn                    (Customer Account API)
  -> returnApproveRequest
  -> return details                   (line items, reverse fulfillment
                                       orders, fulfillment locations)
  -> return.suggestedFinancialOutcome (refund net of return fees, with
                                       original-payment allocations)
  -> returnProcess                    (dispositions + refund transfer)
  -> order.refunds                    (finds the created refund by its
                                       `return` reference; returnProcess
                                       does not echo it)
```

What migrating resolved, against the four consequences the old `refundCreate`
flow had:

1. **Merchant financial reports.** Resolved. The return closes (`CLOSED`)
   through `returnProcess` rather than staying `OPEN`, so it is recorded as a
   sale entry.
2. **Inventory restocking.** Resolved per the location decision below.
   `resolveRestockLocation` picks the merchant's override or the order's
   fulfillment location; `buildReturnProcessLineItems` allocates quantities
   across reverse fulfillment order line items and disposes them `RESTOCKED`.
   A line item restocks nothing, rather than a guess, when no single location
   resolves or the approved quantity can't be fully allocated.
3. **Duplicate line item misallocation.** Resolved as a side effect of the
   migration, not a separate fix. `returnProcess`'s `returnLineItems` input
   keys off `ReturnLineItem.id`, which is specific to this return, instead of
   `refundCreate`'s `refundLineItems`, which keyed off the order's raw
   (potentially duplicated) `LineItem.id`.
4. **Return fees.** Resolved by honoring Shopify's own return rules rather than
   adding a Refund setting. Merchants set restocking and return shipping fees
   under Settings → Policies → Return and cancellation rules. Customer Account
   `returnCalculate` already nets those fees into the quote, and its
   `restockingFeeSubtotalSet` and `returnShippingFeeSubtotalSet` are now shown
   to the customer. Shopify's help center states that return fees "aren't
   automatically deducted from refunds," and the earlier `order.suggestedRefund`
   ignored them, so on any store with fees the post-confirmation amount check
   would have failed and left an open return. Execution now uses
   `Return.suggestedFinancialOutcome`, which accounts for the return's fees. A
   separate Refund fee setting was rejected because it would duplicate core
   Shopify configuration. **Not yet exercised against a live store with fees
   configured.**

One claim in an earlier version of this document does not hold: migrating
does **not** close the window between `returnApproveRequest` succeeding and
the financial transfer running. `returnProcess` takes an already-approved
`returnId` — it does not fold in approval — so the same kind of failure (an
amount recheck fails, or the call itself fails, after approval) still leaves
an approved-but-unprocessed return and a `NEEDS_ATTENTION` record. The window
is unchanged in kind; only what runs at the end of it changed.

**Mitigation (implemented):** the merchant dashboard offers **Retry refund** on
such records (`retryApprovedReturn`). It claims the record (`RETRYING`) so it
runs once at a time, then rechecks Shopify before any money moves: a refund
already linked to the return is recorded instead of repeated; a refund issued
on the order outside the return since the request stops the retry; a
declined, cancelled or closed return stops it; a still-requested return is
approved first. Processing then shares `processApprovedReturn` with the
customer flow, so the refund must still equal the amount the customer
confirmed. Nothing retries automatically.

Relevant references:

- [Apps in returns](https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps)
- [Migrate to return processing](https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps/migrate-to-return-processing)
- [returnProcess mutation](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/returnProcess)
- [Return object, including suggestedFinancialOutcome](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Return)
- [Return rules and fees](https://help.shopify.com/en/manual/fulfillment/managing-orders/returns/return-rules)
- [Refund processing requirement update](https://shopify.dev/changelog/process-refunds-only-through-the-original-payment-processor-requirement-update)
- [Built for Shopify returns and subscriptions requirements](https://shopify.dev/changelog/built-for-shopify-requirements-for-returns-and-exchanges-and-subscription-apps)

## Open decisions

### 1. Restock disposition and location (decided and implemented)

`returnProcess` requires a disposition per return line item, and a
`locationId` is required for `RESTOCKED`. There was no merchant setting for
this.

**Decision:** default the restock location to the order's originating
fulfillment location, and add a merchant-configurable override on top of it.

The default covers single-location stores with no configuration and no new
dashboard surface to complete before the app works. The override exists for
merchants who route returns to a dedicated returns warehouse, where the
fulfillment location is the wrong answer.

Implemented as:

- A nullable `returnLocationId` column on `StorePolicy`. Null means use the
  order's fulfillment location; a value overrides it.
- A location picker in the embedded dashboard (`app/routes/app._index.tsx`)
  writing that column, populated from the shop's locations and validated
  server-side against them.
- Resolution at processing time (`resolveRestockLocation` in
  `app/services/return-processing.server.ts`): `StorePolicy.returnLocationId`
  if set, otherwise the order's fulfillment location — only when every
  fulfillment for the order shares one location. If neither resolves, or the
  approved quantity can't be fully allocated across the reverse fulfillment
  order's line items, the line item is processed as not restocked rather than
  failing the return or restocking a guessed fraction.

Defaulting everything to not-restocked was rejected: it leaves merchants doing
manual restocks and undercuts the point of automating the return.

### 2. Assistant connection lifetime (investigated; mitigated, cannot be removed)

`issueApprovedAgentGrant` caps each access token at one hour. Clients
registered for `refresh_token` rotate Refund refresh tokens, but no grant
outlives the customer session, which `finishCustomerLogin` caps at four hours
or Shopify's shorter token lifetime.

The earlier proposal, persisting and rotating the Shopify customer refresh
token, is not possible for this app. Shopify's Customer Account API
documentation states that apps authenticating with their own client ID through
`customer_authentication` are public PKCE clients that "don't receive refresh
tokens." Only customer account clients configured on the shop itself
(headless storefronts, Hydrogen) receive them, which would need per-merchant
setup an App Store app cannot depend on.

**Decision:** keep the four-hour ceiling and make reconnecting cheap.

- The assistant consent page first redirects through a silent `prompt=none`
  Shopify sign-in. With a live Shopify customer session Shopify returns a code
  without a login screen; without one it returns an error, and the page shows
  the ordinary sign-in choice with no error message. The consent click is
  always still required.
- Customer-facing copy (`/connect/:shop`, `docs/AGENT_ACCESS.md`) states the
  real lifetime.

Re-evaluate if Shopify starts issuing refresh tokens to public app clients.

### 3. Merchant return guidance for assistants (decided and implemented)

Merchants can set plain-text return instructions (up to 1,000 characters) and
a return policy link, which must be an https page on the shop's myshopify or
primary domain. Both publish to every quote's `returnShipping`, the app proxy
`agents.md` and manifest (`returnPolicy`), the public `/stores/:shop` page, and
the storefront readiness data behind `get_store_return_options`. Merchant text
is quoted and labeled as merchant-provided, and the manifest sets
`instructionsOverrideSafetyRules: false`, so an assistant cannot read it as
relaxing verification or confirmation.

The dashboard also generates a paste-ready Returns section for a theme's own
`agents.md.liquid`, with Liquid delimiters stripped from merchant text. Theme
templates can only read the `agents` and `request` objects, not app data, so
merchants paste it again after changing their guidance.

### 4. UCP (investigated; no Refund-owned UCP surface)

- Shopify serves the merchant's `/.well-known/ucp`, and there is still no app
  registration API for adding capabilities to that profile.
- The UCP Order capability (`dev.ucp.shopping.order`) is business-pushed: the
  business sends order `adjustments`, including returns and refunds, to the
  platform. Returns Refund submits are ordinary Shopify returns processed with
  `returnProcess`; any UCP order update about them is Shopify's to publish.
- Vendor capabilities must use the vendor's own reverse-domain namespace, with
  spec and schema URLs on that domain's origin. Refund is served from a Render
  subdomain it does not control as a namespace authority, so it defines no
  capability. Revisit once Refund has its own domain.

The manifest's `ucp` block states these boundaries, including
`refundPublishesUcpOrderEvents: false`.

### 5. Cross-merchant discovery (decided and implemented)

- Installed stores are listed in Refund's store directory by default
  (`MerchantDirectory.discoveryPublished` defaults to true, and the migration
  listed existing stores, which had no hide control before). Merchants can hide
  the store from the dashboard. Only the Shopify store name, primary domain and
  Refund return page are published, and uninstalling removes the listing.
- Assistants find stores through `/stores`, `/llms.txt`, `GET /api/merchants`
  and the public MCP `find_store` tool, which matches partial names or exact
  domains across listed, installed stores. Several matches are all returned for
  the customer to choose from; nothing is picked for them, and no match stops
  the request.
- Resolving the store for a return (`start_return`) still requires an exact
  domain or a unique published name.
- Sign-in stays per store. Shopify customer accounts are separate for every
  store, so there is no cross-store customer identity. One assistant
  connection still covers every store; see decision 8.

### 6. Refund timing and receiving returned items (decided and implemented)

App Store requirement 1.1.15 allows refunds only through the original payment
processor, and 1.1 prohibits unauthorized refund or payment services, so
"immediate" means refunding the original payment method at confirmation, never
advancing Refund's own money or paying out another way.

- **Merchant choice** (`StorePolicy.refundTiming`): `IMMEDIATE` (the default)
  refunds when the customer confirms; `ON_RECEIPT` approves the return then and
  refunds once the merchant marks the item received. The timing is shown in the
  quote and signed into it; if the store changes it before confirmation, the
  submission fails closed and asks for a new quote.
- **Restocking follows the physical item.** An immediate refund calls
  `returnProcess` with no dispositions, so nothing re-enters inventory before it
  is back; this replaces the earlier restock-at-refund behavior. Marking the
  item received then disposes it with `reverseFulfillmentOrderDispose`:
  `RESTOCKED` at the resolved location, or `NOT_RESTOCKED` when none resolves.
- **On receipt**, **Mark received and refund** runs the same Shopify rechecks as
  Retry refund (an existing linked refund is recorded, an order refunded outside
  the return stops it, the return must still be open), then refunds and
  restocks in one `returnProcess` call for the amount the customer confirmed.
  The record is claimed (`RECEIVING`) so it runs once; a failure returns it to
  waiting for its item.
- A waiting return that Shopify processes or closes outside Refund is flagged
  for merchant attention by the returns webhook, so Retry refund can record any
  refund made there instead of refunding twice.
- Returns submitted before refund timing existed were restocked at refund time
  and cannot be marked received.

**Not yet verified against a live store:** that `returnProcess` accepts a refund
with empty dispositions and still lets the reverse fulfillment order be
disposed afterwards. Shopify's input marks dispositions optional and documents
no timing constraint on `reverseFulfillmentOrderDispose`, but neither case has
been exercised.

### 7. Return labels and tracking (decided and implemented)

Refund uses Shopify's own return labels rather than buying labels from a
carrier, so there is no carrier account, per-label cost or off-platform billing.

- Merchants create or upload a return label on the return in Shopify admin;
  the dashboard links each open return's order there. Shopify stores it as a
  reverse delivery and can email it to the customer.
- The customer portal, `get_return_session`/`check_return_status` (MCP and
  WebMCP) show each approved, unreceived return's label link and tracking, read
  server-side from the return's reverse deliveries. Only https links are shown,
  and a return whose shipping can't be read is omitted rather than failing the
  status.
- Customers shipping the item themselves add a tracking number (and optional
  https carrier link) to their own return through the portal, the WebMCP tool
  or the MCP `add_return_tracking` tool (`returns:submit`). Refund creates a
  reverse delivery with `reverseDeliveryCreateWithShipping`, or updates the
  store's existing label delivery with `reverseDeliveryShippingUpdate`, both
  with `notifyCustomer: false`. Tracking from a store label is never
  overwritten.

**Not yet verified against a live store:** reading label fields and adding
tracking on a return whose refund was already processed.

### 8. One assistant connection for every store (decided and implemented)

Customers who connect Refund expect it to work with every store in the Refund
network, not one store per connector. `/mcp/stores` is that connection
(`AgentConnection`); `/mcp/:shop` remains for single-store use.

- Approving the connection needs no store sign-in and grants no purchase
  access. Each store is linked (`AgentStoreLink`) with that store's own Shopify
  customer sign-in through the `link_store` tool, and each private tool takes a
  `shop` argument.
- Links and the connection last while used and end after a year without use
  (decision 9). The connection's refresh tokens are bound to the connection.
- Links complete only in the browser that approved the connection, which
  prevents attaching a customer's sign-in to someone else's connection.
- Customer redaction and uninstall delete store links, and privacy reports
  include them.

**Not yet verified with a live host:** that ChatGPT and Claude show the
`link_store` URL clearly and retry with `shop` after the customer links.

### 9. Store links without signing in again (decided and implemented)

Shopify issues apps no customer refresh token (decision 2), so a link that used
only the customer's Shopify session needed a new sign-in every four hours.

- Linking verifies the Shopify customer ID once through the store's own
  sign-in, so the Customer Account API stays the authentication method (Built
  for Shopify 5.12.4). The ID is stored encrypted on the link.
- After that session ends, the link reads the customer's orders (`orders`
  filtered by `customer_id`, ownership rechecked on every order), prices returns
  (`returnCalculate`) and requests them (`returnRequest`, then the usual
  approval and `returnProcess`) through the Admin API.
- The Admin API doesn't apply the store's Shopify return rules, so Refund
  applies the merchant's confirmed restocking fee, return shipping fee and
  final-sale collections (5.12.3). Final-sale checks need `read_products`.
  Refund's return window, automatic-refund cap and refund timing still apply,
  and refunds still go only to the original payment method.
- On by default (`StorePolicy.verifiedStoreLinks`), effective once the merchant
  saves the rules; merchants can turn it off. A signed-in quote showing Shopify
  charging fees or final-sale rules the saved rules miss pauses it until the
  merchant saves again. Rules that charge more than Shopify don't pause it.
- A link and the connection end after a year without use, as the retention
  limit Shopify's protected customer data requirements call for.

**Not yet verified against a live store:** that `returnCalculate` totals with
fees match `Return.suggestedFinancialOutcome` after `returnRequest` (a mismatch
stops before any refund), the `customer_id` order filter, and the
`read_products` permission prompt.

### 10. Linking a store by order email (decided and implemented)

The per-store Shopify sign-in was the main friction for customers, and guest
shoppers don't think of themselves as having an account to sign in to.

- `link_store` takes the email used at checkout. Refund checks it against the
  store's orders (Admin API `orders` filtered by `email`; reading the email
  field needs Level 2 protected customer data access) and sends a one-tap
  confirmation through Resend (`RESEND_API_KEY`, `REFUND_EMAIL_FROM`).
- The confirmation page asks for a two-digit number shown only in the
  customer's chat, so someone who types another person's email can't finish
  the link; a wrong number cancels it. Opening the link changes nothing, so
  email scanners can't confirm on the customer's behalf.
- An address with no order gets a "we couldn't find an order" note, and the
  chat response is identical, so Refund can't reveal who shops where. Sending
  is capped at 3 emails per address per store and 10 per connection an hour.
- Email-confirmed links use the Admin API path from decision 9: only orders
  whose email matches, with the merchant's confirmed return rules. They are
  keyed by a hash of the email, which customer redaction also matches.
- Stores that can't use it (email not configured, return rules not saved, or
  order email access missing) fall back to the Shopify link, which is instant
  when the customer is already signed in to the store.
- A single store match is used without asking; several matches go back to the
  customer. Both MCP servers send hosts a shared style guide
  (`returnsChatStyle`) for a warm, brief, plain-language conversation.

**Tradeoff:** Built for Shopify requirement 5.12.4 asks returns apps to support
the Customer Account API as the primary authentication method. Shopify sign-in
is still supported, but email confirmation is now the default in chat, which
may affect Built for Shopify eligibility. Claude and ChatGPT don't pass a
user's email to MCP servers, so the customer provides it.

**Before it works live:** request Level 2 protected customer data (email) in the
Partner Dashboard, create a Resend account with a verified sending domain, and
set `RESEND_API_KEY` and `REFUND_EMAIL_FROM` in Render.

## Review findings

Severity is this reviewer's judgement, not a Shopify determination.

### Medium

- ~~`submissionAvailable` defaults to permissive.~~ **Fixed.** The
  `signedQuoteSchema` default in `app/services/return-quote.server.ts` is now
  `false`; an older or malformed token missing the field fails closed.

- ~~All key material derives from `SHOPIFY_API_SECRET`.~~ **Fixed.**
  `REFUND_SECRET` now derives sealing keys, quote signatures and customer
  identity hashes, falling back to `SHOPIFY_API_SECRET` when unset so existing
  deployments are unchanged. Retired values listed in `REFUND_PREVIOUS_SECRETS`
  stay readable: unsealing and quote verification try each secret, compliance
  webhooks match every identity hash, idempotent retries accept older hashes,
  OAuth client registrations are re-sealed when read, and a customer's older
  records are re-keyed to the current hash when that customer next signs in.
  Customer IDs are stored only encrypted on assistant store links (decision 9),
  so sign-in remains the main point re-keying is possible; verified store links
  re-seal their customer ID onto the current secret when used.

  To decouple an existing deployment, set `REFUND_SECRET` to a new random value
  and `REFUND_PREVIOUS_SECRETS` to the current `SHOPIFY_API_SECRET` value, and
  keep that old value listed while records hashed with it exist. The public
  rate limiter still keys short-lived IP hashes from `SHOPIFY_API_SECRET`,
  which is harmless to rotate.

### Low

- ~~`hashCustomerId` is computed twice in `finishCustomerLogin`.~~ **Fixed.**
- ~~`claimIntakeDraft` runs before the new session transaction commits.~~
  **Fixed.** `claimIntakeDraft` now takes an optional transaction client;
  `finishCustomerLogin` claims the draft inside the same `$transaction` that
  creates the session, so the two commit atomically.
- ~~`listAgentGrants` exposes `tokenHash` as the grant identifier.~~ **Fixed.**
  Grants carry a database-generated `publicId` (UUID) that the portal's
  disconnect control uses; revocation still requires the owning session.

### Verified as sound during review

- The merchant refund limit and currency are rechecked at execution
  (`automatic-return.server.ts`), not only at quote time.
- PKCE uses base64url SHA-256 correctly; sealed values use AES-256-GCM with a
  context AAD; portal writes require an exact `Origin` match plus a CSRF header.
- `authorizeAgent` accepts only Refund's own opaque `rfa_` tokens and rejects
  Shopify tokens, cookies, intake links and signed quotes.

### Security review, 2026-09-12

Covered every public, customer, assistant and merchant route, OAuth, store
links, webhooks, data retention, dependencies and committed files.

Checked and sound: all five webhook routes use `authenticate.webhook` (HMAC);
the app proxy uses `authenticate.public.appProxy`; merchant routes use
`authenticate.admin`; `npm audit --omit=dev` reports no vulnerabilities; no
secrets are committed; the one `dangerouslySetInnerHTML` (store page JSON-LD)
escapes `<`; consent and store-link pages send `frame-ancestors 'none'`;
customer pages send `no-store`, `nosniff` and `X-Frame-Options: DENY`.

Fixed:

- **Expired access was never purged.** Expired sessions, grants and
  authorization requests were cleaned only opportunistically, and ended
  connections and idle store links (which hold encrypted customer IDs) were
  never deleted. `pruneExpiredCustomerAccess` now runs with background
  maintenance.
- **Disconnecting an all-stores assistant left its data.** Revoking one of its
  tokens (or a replayed code or refresh token) now revokes the connection and
  all its grants and deletes its store links and link requests.
- **Customer sign-in had no rate limit.** Each `/customer/login` request writes a
  pending session and calls Shopify. `/customer/login`, `/customer/callback` and
  store-link pages share a 60-per-minute per-address limit.
- **`link_store` could create unbounded link requests.** A connection may hold
  10 unfinished requests at once.
- **No HSTS.** The production server sends `Strict-Transport-Security`.
- **Year-long links pinned retired secrets.** A verified link opened with a
  retired secret is re-sealed with the current one when used.
- **Deploy scopes drifted.** `render.yaml` and `.env.example` now include
  `read_products`, matching `shopify.app.toml`.

Accepted risks:

- `/mcp/*` has no per-address limit because assistant hosts share egress
  addresses; bearer tokens gate it, and the OAuth `/token` limit is per address.
- Someone in control of a customer's assistant account can use a verified store
  link until it is removed or unused for a year. Returns still need the exact
  confirmed quote, stay under the merchant's automatic-refund limit and refund
  only the original payment method.
- Verified-link returns use the merchant's saved Refund rules, not Shopify's;
  drift is detected only from signed-in quotes.
- Without `read_all_orders`, the Admin API returns only the last 60 days of
  orders, so verified links see a shorter purchase history than a signed-in
  customer.

## Environment note for agents

A full `npm ci` may fail in sandboxed environments that block the
`zod-to-json-schema` package, a transitive dependency of
`@modelcontextprotocol/sdk`. GitHub Actions runs the complete suite against
PostgreSQL 16 on every pull request; rely on CI when local installation is not
possible.

`npm run test:proxy`, `npm run test:oauth` and the other integration scripts
need a local PostgreSQL database named `refund_ci`. None was available where
the `returnProcess`, return fee, secret rotation and silent sign-in changes
were written, so those paths were checked by unit tests, type checking, lint
and the production build only. Their integration fixtures were updated but
have not run until CI does.
