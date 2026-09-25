# Direct ChatGPT / Claude connection

## What is implemented

One remote MCP connection reaches every store that uses Gooper.io, through the
authorization-code flow: assistant → Gooper.io consent (with email confirmation) →
code exchange → return tools in the chat that find orders, quote, and submit
returns and refunds after the customer confirms each one. Public intake and the
existing browser tools remain separate and available.

This is a backend implementation for host acceptance testing, not a claim that
either host has completed a live test or that an unconnected chat can discover
Gooper.io automatically. Customers must enable a connection in the host for this
first version. Assistants find stores across merchants through `/stores`, `/llms.txt`
and the public MCP `find_store` tool.

## One connection for every store

Setup page: `/connect`. MCP URL:

```text
https://gooper.io/mcp
```

The customer adds this once. Approving it needs no store sign-in. Once Resend is
configured, the consent page first asks "What email do you use when you shop
online?", sends a 6-digit code, and keeps Allow disabled until at least one
email is confirmed. The code is entered on that page, which the authorization
flow cookie binds to the approving browser. The same email carries a button for
another device: it asks for the number shown on the consent page, and the page
picks up the confirmation on its own. Codes last 15 minutes, allow 5 attempts,
can be resent after 30 seconds, and are capped at 8 per authorization and 5 per
address an hour. More emails can be added. Without Resend configured the email
step is skipped.

Confirmed emails are saved on the connection (`ConnectionEmail`), encrypted,
with a keyed hash for lookups, and used only to find the customer's orders at
stores that use Gooper.io, never for marketing:

1. The assistant finds the store with `find_store` and calls a return tool with
   that store's name or website as `store`, which resolves to one shop or stops. If the store has no link, Gooper.io checks the connection's
   confirmed emails for orders there and links the store to the first match,
   with nothing for the customer to do. If none match, the tool returns
   `linkRequired` with reason `email_not_found`, and the assistant asks
   whether they used a different email. Otherwise an unlinked or expired store
   returns `linkRequired` with `nextTool: "link_store"`. A store that hasn't
   saved its return rules, has turned assistant returns off, or can't read
   order emails returns reason `store_not_ready` with no next tool, and the
   assistant points the customer to the store's own returns page. Customers
   are never sent to a Shopify sign-in.
2. `link_store` tries the confirmed emails first. With a different email the
   customer used at checkout, it sends a one-tap confirmation from Gooper.io
   (through Resend) and returns a two-digit number; once confirmed, that email
   is added to the connection, so it works at every store too. This is also
   how connections made before the consent-page step add their first email.
   The customer taps "Yes, that's me" and picks that number on
   `/verify/email/:token`; a wrong number cancels the request. No Shopify
   sign-in or store account is needed, so guest checkouts work. An address with
   no order at the store gets a short note instead, and the chat hears the same
   thing either way. Without an email, `link_store` asks for one. Email is the
   only check: when sending isn't configured `link_store` returns
   `email_unavailable`, and stores that can't use email return
   `store_not_ready`.
3. Return tools for that store then work. `list_linked_stores` shows each link
   and whether it is still active.

Limits and protections:

- **Links that last while used.** Email links reach the customer's orders
  through the store's Admin API, which doesn't apply Shopify's return rules, so
  Gooper.io applies the restocking fee, return shipping fee and final-sale
  collections the merchant confirmed in Gooper.io. Assistant returns are on by
  default and start once the merchant saves those rules; a merchant can turn
  them off. Stores linked by Shopify sign-in before linking went email-only use
  that sign-in while it lasts, then the verified customer ID under the same
  rules. A link ends after a year without use.
- **Rule drift pauses links.** When a signed-in quote shows Shopify charging a
  restocking fee Gooper.io's rules lack, a higher return shipping fee, or final-sale
  items with no final-sale collections set, verified links pause and the
  dashboard asks the merchant to review and save.
- **Connection kept while used.** Gooper.io access and refresh tokens are issued
  against the connection, not a store, and each refresh keeps it for another
  year. Access tokens still last one hour and rotate.
- **Same browser.** Approving the connection sets an HttpOnly
  `__Host-refund_connection` cookie, and `/connect/manage` opens only in that
  browser.
- A store link belongs to the customer at that store. Any sign-in to that
  store's return portal lists it under connected assistants and can remove it.
  Customer redaction and uninstall delete it; signing out ends only its live
  Shopify session.
- Customers see and remove confirmed emails with `list_confirmed_emails` and
  `remove_confirmed_email` in chat, or at `/connect/manage` in the approving
  browser, which can also disconnect. Disconnecting, a year without use and
  customer redaction (for that address, on every connection) delete them.
  Uninstall and shop redaction delete emails confirmed in a chat about that
  store; emails confirmed at setup belong to the customer and stay. Customer
  data requests report when an address was confirmed, without naming other
  stores.
- Looking up orders by email needs Shopify's Level 2 protected customer data
  approval for the order email field. Without it, lookups fail and the store
  returns `store_not_ready`.
- Every Gooper.io MCP address opens this same connection: `/mcp`, `/mcp/stores`, and
  `/mcp/:shop` addresses saved from earlier setup pages, each with its own
  resource metadata. Single-store grants are retired and open nothing.
  Submission still needs the signed quote, and every tool checks its scope.
- **Few questions, one confirmation.** `quote_return` shows what's going back,
  any fees and the refund total, and the assistant asks once; `confirm_return`
  runs only after a clear yes. If `submissionAvailable` is false, the store
  reviews the return itself and the assistant stops. The assistant picks the
  store, order and item itself when only one fits, and never asks for an order
  number or a reason.

## Connect and test

Customer-facing setup is at `/connect`, linked from every return portal
(`/connect/:shop` redirects there). It shows the MCP URL, what the assistant can
do and how store access works. Opening it neither creates an OAuth request nor
grants access. The issuer comes from server configuration, never a request header.

Use this exact remote MCP URL (no trailing slash):

```text
https://gooper.io/mcp
```

A connector saved earlier with a store address, such as
`/mcp/testing-bl7vdfur.myshopify.com`, keeps working and reaches every store
after it reconnects.

Choose OAuth with dynamic client registration (DCR). Leave manually supplied
client IDs/secrets blank. CIMD is deliberately not advertised.

- Claude: add a custom connector under Customize → Connectors, enter the URL,
  then Connect. See [Claude setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- ChatGPT: enable developer mode if available, add an MCP connection with that
  URL, and use OAuth/DCR. See [OpenAI's current test instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).
  Account/workspace policy can restrict developer mode.

Do not use `/mcp/public` or `/apps/refund/mcp` for this customer connection:
those expose anonymous intake only. The browser flow remains an alternative, not
a prerequisite for using the connected assistant after authorization.

The consent page names no merchant: it connects every Gooper.io store and says the
assistant can submit returns and refunds, each after the customer confirms it in
chat, to the original payment method. For submission to work at a store, its
merchant must turn on automatic refunds in the Gooper.io dashboard; otherwise the
assistant quotes and the store reviews the return.

For a first test, ask the assistant to find an order at Pied Piper
(testing-bl7vdfur.myshopify.com) and quote it. Submitting refunds the original
payment method, so use a test order. The full acceptance run for both hosts is
[ASSISTANT_E2E_TEST.md](ASSISTANT_E2E_TEST.md).

## Protocol and safety

### Registration troubleshooting

The generic legacy registration error does not establish which check failed.
The diagnostic update returns fixed reason tags for callback count, callback
allowlist, mixed hosts, token authentication method, grant type, response type,
and scopes. Metadata failures remain HTTP 400 `invalid_client_metadata`.
Storage/encryption failures now return HTTP 500 `server_error` with
`registration_storage`; the registration cap returns `registration_capacity`.
No incoming metadata, secrets, tokens or database exception details are logged
or reflected. All existing callback, grant, scope and authentication restrictions
are preserved. After deployment, one connection attempt should identify the
failure category; this instrumentation is not itself a compatibility fix.

- The production server mounts the installed MCP SDK's authorization, token,
  registration, revocation and metadata handlers. Gooper.io supplies durable
  encrypted client storage, browser consent and transactional grant storage.
  This is not a managed identity-provider deployment.
- The issuer is exactly SHOPIFY_APP_URL's HTTPS origin, without a trailing slash.
  Every success/error authorization redirect includes matching RFC 9207 iss.
- Only documented hosted callback destinations are accepted: Claude's
  https://claude.ai/api/mcp/auth_callback and ChatGPT's stable or callback-ID
  redirect. Arbitrary websites, redirect queries/fragments and loopback/native
  clients are rejected in this rollout. Registered names are not trusted.
- No arbitrary client metadata URL is fetched. Registration is rate-limited and
  capped at 5,000 clients for the initial rollout. Client records persist across
  restarts; confidential-client secrets are encrypted and do not silently expire.
- Authorization requests bind client, exact callback, resource, scopes, a separate
  opaque HttpOnly browser cookie and CSRF protection. They expire in 20 minutes.
- Consent cannot be supplied by an MCP argument. The customer must confirm an
  email and approve the named assistant and exact requested scopes on the
  browser page. No Shopify sign-in is involved.
- Codes expire after two minutes, require S256 PKCE and an exact resource/redirect
  match, and are consumed atomically with grant creation. A valid replay revokes
  the previously issued grant. Concurrent exchanges cannot issue two grants.
- Opaque Gooper.io access tokens are hash-stored, bound to the connection,
  client, resource and scopes, and checked on every request and tool call. They
  carry no Shopify credential: access to a store is checked separately, per
  call, against that store's link. Never paste a token into a chat or a URL.
- Separate scopes are returns:read, returns:quote, returns:submit. Submission
  still requires the signed exact quote, plus the customer's agreement when a
  fee applies. Claude gets
  HTTP insufficient-scope challenges, not only tool metadata errors.
- Access tokens last one hour. Clients registered for `refresh_token` receive
  rotating Gooper.io refresh tokens, and reusing one revokes the chain. A refresh
  token works while the connection lasts, and each refresh keeps the connection
  for another year, so a connection in regular use doesn't need reconnecting.
  Refresh can't add scopes the customer didn't approve. No offline_access scope
  exists.
- Customers disconnect at `/connect/manage` in the approving browser, or by
  removing Gooper.io from their assistant. A store's return portal lists and can
  remove that store's links. Uninstall and customer redaction remove links and
  emails as described above. Privacy reports contain safe metadata, never
  codes, cookies or secrets.

## Deployment and verification

Customer-MCP pivot verification (2026-09-11 PDT): reused the existing five-tool
server and OAuth broker; added `/connect/:shop` and a return-portal setup link.
44 unit tests, 9 OAuth tests, type checking, lint, production build and built-server
smoke passed. The smoke test verifies the setup page's rendered merchant URL,
private/security headers, invalid/uninstalled-store rejection and absence of
new grants or authorization requests just from opening the page. Live read-only
discovery checks passed against the deployed server. That onboarding has since
been deployed and replaced by the email-only flow described above. The live
ChatGPT and Claude acceptance runs are
[ASSISTANT_E2E_TEST.md](ASSISTANT_E2E_TEST.md); results are recorded there, not
here.

Run migrations, build, and start with npm run start:production. The production
HTTP entry point serves both OAuth and the React Router app. The Shopify CLI's
plain Vite development server does not mount the OAuth router; use the production
build for an OAuth preview. Do not set REFUND_OAUTH_HTTP_READY manually: the HTTP
entry point sets it only after mounting the router.

The additive agent_oauth migration changes no merchant policy or order. Existing
Shopify customer callback URLs and scopes are unchanged.

npm run test:oauth requires an isolated local PostgreSQL database named refund_ci.
CI runs migrations and that test against its disposable PostgreSQL service. It
exercises registration, consent/denial, sign-in continuation, PKCE mismatches,
resource/client/callback binding, expiration, replay races, scope denial,
revocation, and logout. It creates no real Shopify order or refund.

Before broad customer rollout, complete each host's run in
[ASSISTANT_E2E_TEST.md](ASSISTANT_E2E_TEST.md), review the authentication implementation, and size distributed
client storage and rate-limit budgets for expected traffic. The production HTTP
server now uses PostgreSQL counters across replicas for registration (20/hour),
authorization (60/10 minutes), and token/revocation requests (120/minute), per
trusted client IP. Public intake shares 120/minute across MCP, JSON and browser
entry points; public discovery allows 60/minute. `REFUND_TRUST_PROXY_HOPS` must
match the deployment's proxy topology. An automated protocol
test is not evidence that the host UI or Shopify live login was exercised.

Run `npm run test:live-discovery` with `REFUND_TEST_APP_URL` set to the deployed
HTTPS origin and `REFUND_TEST_SHOP` set to an installed canonical shop. This checks
the running server's public MCP handshake/tool list, OAuth metadata, rejection of
unauthenticated protected calls and browser preflight. It does not register a
client, invoke intake, create a draft, or submit a financial action. The separate
host connection and exact-quote run in
[ASSISTANT_E2E_TEST.md](ASSISTANT_E2E_TEST.md) still needs a real browser.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[Claude authentication](https://claude.com/docs/connectors/building/authentication),
[MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
