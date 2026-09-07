# Remote assistant access boundary

## Current state

Public intake (`POST /mcp`, `start_return`) and the signed-in browser portal
remain usable. Protected remote tools are **not ready for host connection**.
This milestone implements and tests the resource-server grant boundary, not
a complete OAuth authorization server or a live ChatGPT/Claude connection.

The old `/mcp/:shop` implementation accepted caller-supplied Shopify tokens and
advertised Shopify as its issuer. That pass-through has been removed. Shopify
authenticates the upstream customer; it does not issue audience-bound access
tokens for Refund's remote resource. The metadata endpoint deliberately returns
503 `agent_authorization_not_configured` until a real broker exists.

## Implemented boundary

- Refund tokens are independent random 256-bit opaque secrets; only their SHA-256
  hashes are stored. No raw token is logged or included in privacy exports.
- Each grant records the approved client ID, canonical `/mcp/:shop` resource,
  shop, customer subject, session and exact scopes. A browser session alone
  never mints a grant. Credentials are accepted only in the Authorization header.
- `returns:read` permits purchase discovery; `returns:quote` permits quoting;
  `returns:submit` permits submission of an explicitly confirmed exact quote.
  Scopes do not implicitly include one another; every tool enforces its own.
- Each request and tool invocation checks the database for expiry/revocation,
  resource/shop/customer binding, active upstream session and installed store.
- Lifetime is at most one hour and never exceeds the customer session. Shopify
  access tokens remain encrypted in that session, never sent to the assistant.
- Logout, login rotation, customer redaction and uninstall delete the customer
  session, cascading to its grants. Internal individual revocation also requires
  the owning session. Privacy exports include safe grant metadata, not secrets.
- Protected HTTP responses are no-store, expose the authentication challenge to
  browser clients, and bound JSON bodies to 64 KiB. The public limit stays 16 KiB.

`issueApprovedAgentGrant` is an internal primitive, not a consent API. Its
`customerApproved` flag cannot establish consent by itself. Never wire it to
an agent tool or forward an arbitrary request body to it.

## Next implementation: authorization broker

Use a maintained OAuth authorization-server implementation. It must:

1. Validate a registered client's identity and exact redirect URI. Use static
   registration initially if needed; do not invent support for dynamic client
   registration or client metadata documents without implementing validation.
2. Bind authorization state to client, canonical resource, requested scopes and
   the browser interaction. Require S256 PKCE and single-use expiring codes.
3. Route the customer through Shopify sign-in, then show a separate consent page
   naming the assistant, merchant and requested actions. Protect its approval
   POST with the verified session and CSRF validation. Denial issues no grant.
4. Exchange the code only for the original client, redirect, resource and PKCE
   verifier. Invoke grant issuance only after that exchange and recorded consent.
   Keep upstream tokens server-side. Do not issue refresh tokens initially.
5. Expose valid authorization-server/protected-resource metadata, implement
   revocation, and wire customer-facing per-assistant disconnection controls.
6. Test successful and denied approval, callback mix-ups, code replay, scope
   escalation, logout/redaction, stolen/wrong-audience credentials and supported
   host callbacks. Test one real host before claiming compatibility.

Deploy the additive `20260907050000_agent_access_grants` migration before this
backend. It creates no grants and changes no return policy or order. There is no
environment switch that makes the unfinished OAuth connection ready.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[OpenAI authenticated integrations](https://developers.openai.com/plugins/build/auth).
