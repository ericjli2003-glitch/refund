# Merchant-side returns without a Refund connector

This is the priority path for customers bringing their own **compatible browser
agent**. The merchant installs Refund; the customer does not install a Refund
connector. It is separate from the optional remote ChatGPT/Claude OAuth connector.

## Intended customer journey

1. The customer asks their assistant to return a purchase from a merchant.
2. The assistant opens the merchant's storefront in a browser that exposes
   WebMCP tools. The merchant's enabled Refund embed publishes
   `get_store_return_options` and `start_return`, even with the launcher off.
3. The assistant invokes `start_return` with order/item hints. This opens
   the return panel and provides a visible link to the merchant's Refund portal.
   It does not read orders or submit a return.
4. On the portal, `get_return_session` reports whether customer verification is
   needed, or restores the verified customer's draft and quote. The customer completes Shopify sign-in themselves. Credentials and
   verification codes must not be requested in chat.
5. After navigation back, the agent discovers the page's tools again and calls
   `get_return_session`, then `find_returnable_items` and `quote_return`.
6. The exact item, quantity, amount and currency are presented to the customer.
   Only explicit confirmation permits submission. Merchant policy, ownership,
   signed quotes and idempotency remain enforced by the server.

## What detection means

Refund does not watch private ChatGPT/Claude conversations. A user-agent string,
bot classifier, HTTP header, website visit or initial return intent is not proof
of identity or approval. We publish narrowly scoped tools; a compatible agent
chooses to invoke the return tool when its user asks. No background refund starts
merely because an AI visitor appears.

Hiding the launcher affects presentation only, not security. Tool availability
must never replace customer authentication. The anonymous storefront publishes
only intake/help, not purchase data or financial actions.

## Support boundary

WebMCP is an evolving browser capability, not a guarantee that an ordinary
ChatGPT/Claude chat can discover arbitrary merchant tools. Both the browser and
assistant must support the tool path and carry navigation into the verified
portal. A remote connector, browser automation and browser-native tools are
different interfaces. Basic browsing or search support alone does not establish
WebMCP support.

The hosted merchant profiles at `/stores/SHOP.myshopify.com` also provide this
handoff, so the theme embed is optional for hosted discovery. Public directory
publication remains merchant-controlled.

The portal reports whether its tools registered, the browser lacks the API, or
registration failed. “Available” means page registration succeeded, **not** that
ChatGPT or Claude has discovered or executed those tools. Unsupported browsers
retain the normal return form. No flags, origin-trial enrollment, browser
extension installation, cross-origin tool exposure or host permissions are
silently enabled by Refund.

## Acceptance checklist

- Use a real host/browser combination with supported WebMCP discovery.
- Confirm both storefront tools are discoverable with the launcher hidden.
- Start with an anonymous customer and verify that no purchases are exposed.
- Follow the handoff; let the customer sign in; rediscover tools after navigation.
- Confirm the portal reports the verified session and quotes the actual item.
- Stop before submission unless the customer approves the exact quote.
- Verify cancellation, expired sessions and unsupported-browser fallback.

Automated coverage checks the connector-free session descriptor, registration
failure, AbortSignal cleanup, remounting and cancellation during registration.
These tests do not prove a live ChatGPT/Claude browser can discover the tools.

References:

- [Chrome WebMCP imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [WebMCP tool security](https://developer.chrome.com/docs/ai/webmcp/secure-tools)
- [WebMCP specification](https://webmachinelearning.github.io/webmcp/)
- [ChatGPT remote connection testing](https://developers.openai.com/plugins/deploy/connect-chatgpt)

Immediate debit-card payouts and return shipping labels remain separate,
unimplemented capabilities; this path uses the existing original-payment refund.

## UCP publication boundary

Shopify serves the merchant's `/.well-known/ucp` profile. Its documented
[Order MCP](https://shopify.dev/docs/agents/orders/order-mcp) currently exposes
`get_order`, limited to orders placed through the calling agent. Refund's
Customer Account API flow handles the customer's existing purchases separately.
The [profile documentation](https://shopify.dev/docs/agents/profiles) describes
capability negotiation, but provides no app registration API for appending
Refund's tools to that Shopify-owned profile. A Refund-hosted JSON file alone
would not publish the app through the merchant's UCP service. Keep the existing
WebMCP/MCP surfaces until a supported Shopify publication mechanism is available.

The UCP Order capability (`dev.ucp.shopping.order`) is business-pushed: the
business sends order `adjustments`, including returns and refunds, to the
platform. Refund processes returns natively with `returnProcess`, so they are
ordinary Shopify returns, and any UCP order update about them is Shopify's to
publish. UCP also requires vendor capabilities to use the vendor's own
reverse-domain namespace hosted on that domain, so Refund defines none while it
is served from a Render subdomain.
