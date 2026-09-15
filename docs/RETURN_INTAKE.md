# Public merchant return intake

An agent that can reach Gooper.io may call one public tool to prepare the customer's
return workflow. The API is an intake service, not an inbox that monitors private
AI conversations. The calling agent identifies the return intent and sends the
merchant website explicitly. There is no separate LLM classifier or model key.

## Interfaces

- Streamable HTTP MCP: `POST /mcp`, tool `start_return`.
- JSON: `POST /api/return-intake` with `Content-Type: application/json`.
- Browser: `GET /start-return` (form) or with merchant/order/item query hints.
- Authenticated browser portal: `/returns/SHOP.myshopify.com`.

Input example:

```json
{"merchant":"testing-bl7vdfur.myshopify.com","orderName":"#1001","itemName":"Snowboard"}
```

Possible results:

- `verification_required`: includes canonical merchant identity, an expiring
  `continueUrl`, `authenticationRequired: true`, `confirmationRequired: true`,
  and explicit `returnSubmitted: false` / `refundSubmitted: false`.
- `merchant_not_resolved`: no orders, private account information, or assertions
  about the customer's purchase are returned. Check the exact merchant domain
  or use the merchant's own published return instructions.
- Errors: malformed/oversized JSON receives 400/413; non-JSON receives 415.
  Unavailable merchant verification receives a generic 503 through HTTP or an
  MCP tool error without disclosing internal credentials or database errors.

Never send passwords, OTPs, payment details, customer tokens, or a refund
confirmation in this public request. Input only contains order/item *hints*.
The continuation is an encrypted request description, not a customer session.

## Customer and merchant boundaries

1. Merchant installation records the canonical store and its Shopify-reported
   primary domain. Background maintenance backfills existing installations and
   refreshes domains every six hours; opening Gooper.io also refreshes the mapping.
2. Intake resolves only a known domain. A custom domain is rechecked with the
   canonical installed shop; arbitrary URLs are never fetched.
3. The continuation expires after 30 minutes, uses authenticated encryption,
   and fails if used for another store. It can be revisited until expiry because
   it authorizes no action. No unauthenticated customer session is persisted.
4. The portal sends the customer through its existing Shopify PKCE flow. The
   pending session retains hints; successful login rotates the opaque session
   cookie. Cancellation offers a retry with the same hints.
5. Customer-specific tools query only the authenticated customer's purchases.
   The supplied order and item must be reconciled with Shopify's actual data.
6. A signed quote and explicit customer confirmation are still required by the
   existing return service. Refunds go to the original payment method.

## Rollout and acceptance

- Run the database migration, then deploy the backend.
- Open the merchant dashboard to register a current primary custom domain.
- Publish the updated storefront extension. Leave its visible launcher off if
  desired; its WebMCP tools remain available in supported browsers.
- Invoke anonymous `start_return` and follow `continueUrl`.
- Confirm the requested item and order survive verification and a cancelled
  sign-in. Login must show only the customer's own purchases.
- Quote the actual item, show the precise amount/currency, and stop before
  submission until the customer explicitly confirms.

Automated tests exercise anonymous routing, encrypted/expired/cross-store
continuations, HTTP and MCP behavior, unsupported merchants, and the handoff
into the pending Shopify OAuth session. They do not replace a successful live
Shopify login or a confirmed test return.

### Customer sign-in scopes

Gooper.io requests `openid customer-account-api:full`. It verifies the ID token and
then resolves the authenticated Customer Account API customer ID; it does not
need an email claim to match ownership. The customer's checkout email can still
be used on Shopify's own sign-in screen without granting Gooper.io the OIDC `email`
scope. In the Testing development store, requesting the additional `email`
scope returned `invalid_scope`; the same PKCE flow without it successfully
authenticated and retrieved the customer's orders. Do not broaden data access
or bypass identity verification to work around an authorization failure.

### Shopify return balance convention

Customer Account `returnCalculate` expresses credits as negative `returnTotalSet`
values (see Shopify's [self-serve returns example](https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps/build-self-serve-returns)).
Both quoting and submission convert a strictly negative return balance into a
positive refund, preserving the decimal string and currency. Zero, positive
(customer owes money), and invalid balances fail closed. Merchant caps compare
the converted shop-currency refund; customer confirmation uses presentment
currency. Never apply an unconditional absolute value or increase the store cap
to work around a sign-convention error.

## Remaining native chat integration

The global MCP service deliberately exposes only public intake. Browser login
does not silently grant the requesting remote agent access. Supporting protected
actions directly in ChatGPT/Claude now use a separate merchant-specific OAuth
connection with durable client registration, Shopify login, explicit assistant
consent, and resource-bound grants. See [direct connection setup](AGENT_ACCESS.md).
Each host still needs a live acceptance test. Authentication metadata alone
cannot make an unconnected chatbot discover or invoke the endpoint.

References:

- https://developers.openai.com/plugins/build/auth
- https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Shop
- https://shopify.dev/docs/api/customer/2026-07
