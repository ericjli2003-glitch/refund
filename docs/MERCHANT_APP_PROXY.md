# Merchant-domain return discovery and proof

Refund reuses its existing return engine. The new entry point is merchant-hosted
discovery, not a shopper-installed plugin or a second returns system.

## Implemented path

1. The merchant publishes `/agents.md`, or redirects that otherwise-unused path
   to `/apps/refund/agents.md`.
2. Shopify forwards `/apps/refund/*` to Refund's `/proxy/refund/*`, adding a signed
   shop, timestamp and actual merchant-customized `path_prefix`.
3. Refund validates with `authenticate.public.appProxy`, requires an installed
   offline session, and publishes a shop-bound guide, manifest, intake schema,
   public `start_return` MCP tool and browser entry page.
4. MCP/JSON intake reuses `startReturnIntake`: an expiring draft and verification
   link only. The browser entry links directly to the existing `/returns/:shop`
   portal; opening that public entry does not create a draft.
5. The shopper completes existing Shopify Customer Account OIDC sign-in.
   Existing portal Site Tools or ordinary browser controls use the protected
   `/api/returns/:shop` operations: session, list, quote, confirm, status.
6. After exact-quote confirmation, `submitReturnQuote` calls
   `executeAutomaticReturn`. It rechecks ownership, quantity, policy and amount,
   requests the return through the Customer Account API, then uses Shopify Admin
   `returnApproveRequest`, `suggestedRefund`, and idempotent `refundCreate`.

The backend uses **both Customer Account and Admin APIs**. The Admin installation
token alone never substitutes for customer ownership verification.

## Routes and functions

The merchant's default prefix is `/apps/refund`; all its children are dispatched
by `app/routes/proxy.refund.$.ts` on the backend:

- `GET /agents.md`: `merchantAgentsMarkdown` in `app/services/merchant-proxy.server.ts`.
- `GET /manifest.json`: `merchantReturnDiscovery`, with merchant-bound endpoints.
- `GET /ucp`: the same supplemental manifest, **not** a UCP protocol API.
- `GET /schema.json`: the exact `proxyIntakeSchema` JSON schema.
- `POST /mcp`: `handleIntakeMcp` / `createIntakeMcpServer(shop)`, exposing only `start_return`.
- `GET /start-return`: `merchantHandoffPage`, an explicit top-level portal link.
- `POST /start-return`: existing `startReturnIntake`, accepting optional hints and UUID idempotency key.

MCP/JSON bodies cannot select another merchant. Forged/stale/duplicate query
parameters fail closed. `logged_in_customer_id` is ignored: it does not authorize
order lookup, a quote, confirmation or a refund. All proxy paths share the existing
intake quota. Shopify forwarding can aggregate users behind a proxy IP; monitor
429s before increasing quotas and never trust caller-supplied forwarding headers.

## Minimal merchant setup

1. Deploy the backend commit through the normal release process. No new database
   migration is required. Deploy Shopify configuration with `npm run deploy`,
   which also keeps existing theme URLs aligned with the selected app config.
   `shopify.app.toml` declares `write_app_proxy` and the proxy. Keep deployed
   `SCOPES` aligned (`render.yaml` and `.env.example` are updated). Existing
   installations may need to approve the new permission.
2. Verify Refund's proxy path in the merchant's Shopify app settings. Preserve an
   existing customized prefix/subpath and substitute it below. The backend uses
   the signed actual `path_prefix`, not a hard-coded assumption.
3. Add a Shopify URL redirect from **`/agents.md`** to
   **`/apps/refund/agents.md`**, provided the root path is otherwise unused.
   If an existing edge/static layer already serves `/agents.md`, append pointers
   to `https://YOUR_STORE/apps/refund/agents.md` and
   `https://YOUR_STORE/apps/refund/manifest.json` instead. Do not overwrite an
   existing guide. If Shopify does not apply the root redirect on that storefront,
   use its existing edge layer and validate the real response before claiming
   success. Shopify App Proxy itself cannot occupy an arbitrary root path.
4. Customer accounts must be enabled. Existing merchant return rules and Refund's
   automatic-refund policy still apply; discovery does not enable automatic
   refunds. The theme embed is optional for this entry path.

Theme Liquid is not a server route: a snippet cannot publish `/agents.md`.
Do not replace Shopify's `/.well-known/ucp`. The redirect approach needs no DNS
change; edge rewrites are only a fallback for an already-managed storefront.

**Do not use a proxy redirect/iframe for sign-in.** Shopify follows upstream 30x
redirects itself and strips Cookie/Set-Cookie. The entry page intentionally links
to the top-level Refund portal so existing secure cookies, OAuth state/nonce,
PKCE and CSRF protections work.

## UCP and normal ChatGPT/Claude: exact boundary

This implements the **MCP/browser branch** of the requested UCP/MCP architecture.
The manifest links Shopify's UCP profile but does not advertise
`dev.ucp.shopping.order` or invent a standardized UCP `start_return` mutation.
It does not implement UCP version/capability negotiation. `/ucp` is explicitly a
Refund handoff manifest, not `/.well-known/ucp` or a standard UCP profile.

No Refund connector, OAuth agent grant, or Refund account is required for the
browser path. A browser-capable ChatGPT/Claude host can follow links and use the
portal. The shopper must personally sign in and confirm the exact quote. Hosts
supporting WebMCP can use existing Site Tools; others may use ordinary controls.

Reading `/agents.md` does **not** install a remote MCP connection into normal
chat. Public MCP is available to hosts already capable of calling it; it is not
a way around that limitation. Text-only chat may only offer the shopper a link.
Do not claim universal automatic discovery or conversational execution without
an acceptance test for the actual product/mode.

Primary contracts:

- [Shopify app proxies](https://shopify.dev/docs/apps/build/online-store/app-proxies)
- [Proxy authentication/cookies](https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies)
- [UCP discovery](https://ucp.dev/2026-04-08/specification/overview/)
- [ChatGPT Work/Codex Site Tools](https://learn.chatgpt.com/docs/webmcp)
- [ChatGPT MCP setup](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Claude MCP setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

## Reproducible proof

Current live-test status (2026-09-11): the Testing storefront's `/agents.md` and
proxy URL both redirect to `/password`. Public discovery is not yet verified.
The merchant chose to leave live customer testing pending. No password protection,
merchant redirect, production deployment or real return/refund was changed by
this implementation task.

Local verification completed: 44 unit tests, 8 proxy/return proof tests, 9 OAuth
tests, 5 infrastructure tests, 2 storefront-configuration tests, and the existing
draft/onboarding/opportunity integration scripts passed. Type checking, lint,
production build, built-server smoke, Prisma validation and Shopify CLI app
configuration validation also passed. CI is configured to run the new proxy
proof; these results are local, not a claim that a new GitHub CI run occurred.

### Local integration (no real payments)

Use an isolated local PostgreSQL database named `refund_ci`, the repository's
test Shopify environment variables, Node 22.18+, and applied migrations:

```sh
npm run test:proxy
npm test
npm run typecheck
npm run lint
npm run build
node scripts/test-http.mjs
```

`tests/merchant-proxy.integration.ts` follows a simulated merchant root redirect
and signed Shopify forwarding hop over local HTTP. It uses the real Shopify SDK
signature validator, MCP transport, PostgreSQL, actual OIDC handlers with fixture
JWT/JWKS, quote validation, portal actions and existing execution service. Only
outbound Shopify responses are fixtures; the SDK's separate HTTP adapter is
intercepted too. No production bypass is added.

It checks tenant isolation, invalid signatures/timestamps/duplicates, custom
paths, uninstall, payload limits, state/PKCE/nonce/JWT, ownership, CSRF, quote
expiry/binding, changed amounts, merchant policy, successful execution, retries
and partial failure. No return/refund mutation occurs before confirmation, and
no assistant grant/connector is created.

The proof exposed a pre-existing JSONB property-order bug in `sameReturnItems`.
Fields are now canonicalized before comparing stored requests against quotes,
so identical confirmation retries are recognized.

`scripts/test-http.mjs` additionally checks the **built production router** serves
signed proxy resources/MCP, rejects unsigned requests and applies shared limits.

### Live deployed hop (read-only)

After deployment and merchant setup:

```sh
REFUND_TEST_APP_URL=https://YOUR_REFUND_APP \
REFUND_TEST_SHOP=YOUR_STORE.myshopify.com \
REFUND_TEST_STOREFRONT_URL=https://YOUR_STORE_DOMAIN \
REFUND_TEST_PROXY_PATH=/apps/refund \
npm run test:live-proxy
```

This checks `/agents.md`, real Shopify signing/forwarding, merchant identity,
browser link and MCP initialize/tools-list. It never invokes intake, signs in,
creates a draft, submits a return, or issues a refund.

### Actual host/customer acceptance (required for the full claim)

Use a merchant-owned **test order/payment** and customer account, with explicit
authorization for that test transaction. Record host, mode/version and absence
of a Refund connector. Start a normal conversation asking to return that item
from the merchant URL; do not configure a custom MCP connector.

1. Observe discovery of `/agents.md`, the proxy and portal. Record any manual URL
   prompt needed as a discovery gap.
2. Have the customer personally sign in, then continue in the same chat.
3. Obtain a quote and verify no Shopify return/refund exists yet. Record exact
   items/amount and correlation ID, not cookies, tokens or sign-in codes.
4. After the customer explicitly approves that test transaction, submit once.
   Verify Shopify return/refund IDs and the original-payment target.
5. Resume and check status; do not create another return to test retries.

A fixture passing is not proof of live Shopify configuration, host discovery or
a real payment. If the host cannot browse/call tools, report that limitation;
do not substitute a plugin, API harness or simulated chat and label it normal
ChatGPT/Claude.
