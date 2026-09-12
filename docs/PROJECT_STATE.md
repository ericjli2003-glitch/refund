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
  Customer IDs are never stored, so sign-in is the only point re-keying is
  possible.

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
