# Direct ChatGPT / Claude connection

## What is implemented

A merchant-specific remote MCP connection now supports the authorization-code
flow through Refund: assistant → Shopify customer sign-in → explicit assistant
consent → code exchange → private return tools in the chat. Public intake and
the existing browser tools remain separate and available.

This is a backend implementation for host acceptance testing, not a claim that
either host has completed a live test or that an unconnected chat can discover
Refund automatically. Customers must enable a connection in the host for this
first version. Assistants find stores across merchants through `/stores`, `/llms.txt`
and the public MCP `find_store` tool.

## One connection for every store

Setup page: `/connect`. MCP URL:

```text
https://refund-ztxz.onrender.com/mcp/stores
```

The customer adds this once. Approving it on Refund's consent page needs no
store sign-in, because the connection alone reaches no purchases. Shopify
customer accounts are separate for every store, so each store is linked with
its own sign-in:

1. The assistant finds the store with `find_store` and calls a return tool with
   that `shop`. An unlinked or expired store returns `linkRequired` with
   `nextTool: "link_store"`.
2. `link_store` returns a link, valid for 20 minutes, to
   `/connect/stores/link/:token`. The customer opens it, signs in with Shopify
   (silently when still signed in to that store) and approves the link.
3. Return tools for that store then work. `list_linked_stores` shows each link
   and whether it is still active.

Limits and protections:

- **Links that last while used.** Linking verifies the customer with Shopify
  once and stores their Shopify customer ID encrypted. While that Shopify
  session lasts (at most four hours, with no refresh token for apps like
  Refund), tools use it and Shopify's own return rules apply. After it ends,
  tools reach the same customer's orders through the store's Admin API, which
  doesn't apply Shopify's return rules, so Refund applies the restocking fee,
  return shipping fee and final-sale collections the merchant confirmed in
  Refund. This is on by default and takes effect once the merchant saves those
  rules. A merchant can turn it off; links then need a new sign-in after four
  hours, which is one click with a live Shopify session. A link ends after a
  year without use.
- **Rule drift pauses links.** When a signed-in quote shows Shopify charging a
  restocking fee Refund's rules lack, a higher return shipping fee, or final-sale
  items with no final-sale collections set, verified links pause and the
  dashboard asks the merchant to review and save.
- **Connection kept while used.** Refund access and refresh tokens are issued
  against the connection, not a store, and each refresh keeps it for another
  year. Access tokens still last one hour and rotate.
- **Same browser.** Approving the connection sets an HttpOnly
  `__Host-refund_connection` cookie, and a store link completes only in that
  browser. Someone who sends a customer their own link can't attach the
  customer's store sign-in to the sender's assistant.
- A store link belongs to the customer at that store. Any sign-in to that
  store's return portal lists it under connected assistants and can remove it.
  Customer redaction and uninstall delete it; signing out ends only its live
  Shopify session.
- All-stores tokens are rejected by `/mcp/:shop`, and single-store tokens by
  `/mcp/stores`. Submission still needs the signed quote and explicit
  confirmation, and every tool checks its scope.

## Connect the Testing store

Customer-facing setup is available at `/connect/:shop` after deploying this
version. It is linked from the return portal and provides a copyable,
merchant-specific MCP URL, sign-in/consent instructions, permission boundaries
and a quote-only first prompt. Opening it neither creates an OAuth request nor
grants access. The issuer comes from server configuration, never a request header.
Invalid domains and stores without an active installation are rejected.

Use this exact remote MCP URL (no trailing slash):

```text
https://refund-ztxz.onrender.com/mcp/testing-bl7vdfur.myshopify.com
```

Choose OAuth with dynamic client registration (DCR). Leave manually supplied
client IDs/secrets blank. CIMD is deliberately not advertised.

- Claude: add a custom connector under Customize → Connectors, enter the URL,
  then Connect. See [Claude setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- ChatGPT: enable developer mode if available, add an MCP connection with that
  URL, and use OAuth/DCR. See [OpenAI's current test instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).
  Account/workspace policy can restrict developer mode.

Do not use the bare `/mcp` or `/apps/refund/mcp` URL for this customer connection:
those expose anonymous intake only. The full `/mcp/:shop` route exposes the six
private return tools after OAuth. The browser flow remains an alternative, not
a prerequisite for using the connected assistant after authorization.

Complete Shopify sign-in, check the merchant and requested actions on Refund's
consent page, and choose Allow only if intended. You return to the assistant.
Connecting is not confirmation of any particular return or refund.

For the first test, ask the assistant to find order #1001 and quote the actual
item, **without submitting anything**. The development order previously contained
Refund Test Product, CAD14.00; do not relabel it as a snowboard. Retrieve a fresh
quote rather than assuming that amount still applies.

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
  registration, revocation and metadata handlers. Refund supplies durable
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
  Shopify login preserves only a validated internal continuation.
- Consent cannot be supplied by an MCP argument. The signed-in customer must
  approve the named assistant and exact requested scopes on the browser page.
- Codes expire after two minutes, require S256 PKCE and an exact resource/redirect
  match, and are consumed atomically with grant creation. A valid replay revokes
  the previously issued grant. Concurrent exchanges cannot issue two grants.
- Independent opaque Refund access tokens are hash-stored, resource/shop/customer/
  client-bound and scope-checked on every request and tool call. Shopify tokens
  stay encrypted server-side. Never paste either token into a chat or a URL.
- Separate scopes are returns:read, returns:quote, returns:submit. Submission
  still requires the signed exact quote and explicit confirmation. Claude gets
  HTTP insufficient-scope challenges, not only tool metadata errors.
- Access tokens last at most one hour. Clients registered for `refresh_token`
  receive rotating Refund refresh tokens (reusing one revokes the chain), but no
  grant outlives the verified Shopify customer session, capped at four hours.
  Shopify issues no refresh token to public PKCE app clients, so Refund cannot
  extend that session. Reconnecting first tries a silent `prompt=none` Shopify
  sign-in; the consent click is still required. No offline_access scope exists.
- Customers can disconnect individual assistants in the return portal. Logout,
  customer redaction and uninstall remove related authorizations/grants.
  Privacy reports contain safe metadata, never codes, cookies or secrets.

## Deployment and verification

Customer-MCP pivot verification (2026-09-11 PDT): reused the existing five-tool
server and OAuth broker; added `/connect/:shop` and a return-portal setup link.
44 unit tests, 9 OAuth tests, type checking, lint, production build and built-server
smoke passed. The smoke test verifies the setup page's rendered merchant URL,
private/security headers, invalid/uninstalled-store rejection and absence of
new grants or authorization requests just from opening the page. Live read-only
discovery checks passed against the deployed server. These new onboarding changes
have not yet been deployed; actual ChatGPT/Claude customer sign-in and quote tests
remain pending. No real customer return or refund was performed.

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

Before broad customer rollout, complete each host's actual connection/quote
acceptance test, review the authentication implementation, and size distributed
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
host sign-in and exact-quote checklist above still needs the customer's browser.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[Claude authentication](https://claude.com/docs/connectors/building/authentication),
[MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
