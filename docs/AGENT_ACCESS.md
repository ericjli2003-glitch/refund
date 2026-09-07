# Direct ChatGPT / Claude connection

## What is implemented

A merchant-specific remote MCP connection now supports the authorization-code
flow through Refund: assistant → Shopify customer sign-in → explicit assistant
consent → code exchange → private return tools in the chat. Public intake and
the existing browser tools remain separate and available.

This is a backend implementation for host acceptance testing, not a claim that
either host has completed a live test or that an unconnected chat can discover
Refund automatically. Customers must enable a connection in the host for this
first version. Cross-merchant discovery and directory publication remain future work.

## Connect the Testing store

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

Complete Shopify sign-in, check the merchant and requested actions on Refund's
consent page, and choose Allow only if intended. You return to the assistant.
Connecting is not confirmation of any particular return or refund.

For the first test, ask the assistant to find order #1001 and quote the actual
item, **without submitting anything**. The development order previously contained
Refund Test Product, CAD14.00; do not relabel it as a snowboard. Retrieve a fresh
quote rather than assuming that amount still applies.

## Protocol and safety

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
- Access expires within one hour and never outlives the verified Shopify session.
  No refresh tokens or offline_access scope are issued; reconnect after expiry.
- Customers can disconnect individual assistants in the return portal. Logout,
  customer redaction and uninstall remove related authorizations/grants.
  Privacy reports contain safe metadata, never codes, cookies or secrets.

## Deployment and verification

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
rate limiting and client storage for expected traffic. An automated protocol
test is not evidence that the host UI or Shopify live login was exercised.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[Claude authentication](https://claude.com/docs/connectors/building/authentication),
[MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
