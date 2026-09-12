# Project state, open decisions, and review findings

Shared context for any agent or developer picking this repository up. Update it
when a decision below is resolved; do not let it drift into a changelog.

Last reviewed: 2026-09-12, against `claude/project-state` at `779b7c3`.

## Shopify App Store compliance status

### Requirements currently met

- **Requirement 1.1.15, refunds only through the original payment processor.**
  Enforced for published apps since 2026-04-22. `executeAutomaticReturn` uses
  `returnProcess` against allocations derived from `suggestedRefund`, validates
  each allocation against an existing original transaction and gateway, and
  rejects manual and replacement gateways. Refund advances no money and creates
  no separate payout destination. See `docs/ORIGINAL_PAYMENT_REFUNDS.md`.
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
orderRequestReturn  (Customer Account API)
  -> returnApproveRequest
  -> order.suggestedRefund
  -> returnProcess (dispositions + refund transfer together)
  -> order.refunds  (locates the created refund by its `return` reference,
                      since returnProcess does not echo it)
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
4. **Return fees.** Still open. `ReturnProcessInput` has no restocking-fee
   field (`ReturnLineItem.restockingFee` is read-only, computed elsewhere);
   `refundShipping` exists for shipping but nothing is wired to it. `StorePolicy`
   still has no field for this and none is sent to `returnProcess`.

One claim in the earlier version of this document does not hold: migrating
does **not** close the window between `returnApproveRequest` succeeding and
the financial transfer running. `returnProcess` takes an already-approved
`returnId` — it does not fold in approval — so the same kind of failure (an
amount recheck fails, or the call itself fails, after approval) still leaves
an approved-but-unprocessed return and a `NEEDS_ATTENTION` record. The window
is unchanged in kind; only what runs at the end of it changed.

Relevant references:

- [Apps in returns](https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps)
- [Migrate to return processing](https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps/migrate-to-return-processing)
- [returnProcess mutation](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/returnProcess)
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

### 2. Assistant connection lifetime on the browserless path

`issueApprovedAgentGrant` caps the access token at one hour and the refresh
token at the customer session's own expiry. `finishCustomerLogin` sets that
session to at most four hours and stores only the Shopify customer
**access** token, discarding any refresh token.

The consequence is that a connected assistant loses access within four hours
and the customer must complete another browser sign-in. If the remote MCP
connector path is to be the primary route rather than a fallback, persisting
and rotating the Shopify customer refresh token is the change that removes the
repeated browser step. This has protected-customer-data implications and needs
its own review before implementation.

## Review findings

Severity is this reviewer's judgement, not a Shopify determination.

### Medium

- ~~`submissionAvailable` defaults to permissive.~~ **Fixed.** The
  `signedQuoteSchema` default in `app/services/return-quote.server.ts` is now
  `false`; an older or malformed token missing the field fails closed.

- **All key material derives from `SHOPIFY_API_SECRET`.** In
  `app/services/customer-security.server.ts`, `key()` derives session sealing
  and quote signing keys from the app secret, and `hashCustomerId` uses it for
  the stored customer subject hash. Rotating the Shopify API secret would
  invalidate every live session and quote, which is acceptable, but it would
  also orphan the `customerSubjectHash` on every historical `AgentReturn` row,
  which is not. Consider a separate, independently rotatable identity-hash
  secret.

### Low

- ~~`hashCustomerId` is computed twice in `finishCustomerLogin`.~~ **Fixed.**
- ~~`claimIntakeDraft` runs before the new session transaction commits.~~
  **Fixed.** `claimIntakeDraft` now takes an optional transaction client;
  `finishCustomerLogin` claims the draft inside the same `$transaction` that
  creates the session, so the two commit atomically.
- `listAgentGrants` exposes `tokenHash` as the grant identifier used by the
  revoke UI. A SHA-256 of the token does not reveal the token and revocation
  is scoped to the owning session, so this is safe, but a dedicated opaque
  grant id would be clearer.

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
