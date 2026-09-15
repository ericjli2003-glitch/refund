import { authenticate } from "../shopify.server";
import { normalizeShopDomain } from "./customer-account.server";
import { appOrigin, privateHeaders } from "./customer-security.server";
import { intakeSchema } from "./return-intake.server";
import { guidanceMarkdown, type ReturnGuidance } from "./return-guidance.server";
import * as z from "zod/v4";

export const proxyIntakeSchema = intakeSchema.omit({ merchant: true });

// Shopify's SDK validates the HMAC and timestamp. Reject ambiguous parameters
// before its Object.fromEntries conversion, and reject missing/NaN timestamps.
// The proxy signature attests to the SHOP, never to return consent or ownership.
export async function authenticateMerchantProxy(request: Request) {
  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  if (
    new Set(keys).size !== keys.length ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(params.get("shop") || "") ||
    !/^\d{10}$/.test(params.get("timestamp") || "") ||
    !/^[a-f0-9]{64}$/.test(params.get("signature") || "")
  )
    throw new Response("Invalid Shopify proxy request.", { status: 400 });
  const shop = normalizeShopDomain(params.get("shop") || "");
  const pathPrefix = params.get("path_prefix") || "";
  if (!/^\/(apps|a|community|tools)\/[a-zA-Z0-9_-]+$/.test(pathPrefix))
    throw new Response("Invalid Shopify proxy path.", { status: 400 });
  const { session } = await authenticate.public.appProxy(request);
  if (!session || session.isOnline || session.shop !== shop)
    throw new Response("This store has not connected Gooper.io.", { status: 404 });
  return { shop, pathPrefix };
}

export function merchantReturnDiscovery(
  shop: string,
  pathPrefix: string,
  guidance: ReturnGuidance | null = null,
) {
  const base = `https://${shop}${pathPrefix}`;
  return {
    schemaVersion: "2026-09-12",
    kind: "refund_merchant_return_handoff",
    merchant: { shop },
    agentsUrl: `${base}/agents.md`,
    manifestUrl: `${base}/manifest.json`,
    ...(guidance
      ? {
          returnPolicy: {
            source: "merchant",
            policyUrl: guidance.returnPolicyUrl,
            automaticReturnWindowDays: guidance.automaticReturnWindowDays,
            refundTiming: guidance.refundTiming,
            instructions: guidance.returnInstructions,
            instructionsOverrideSafetyRules: false,
          },
        }
      : {}),
    browser: {
      entryUrl: `${base}/start-return`,
      portalUrl: `${appOrigin()}/returns/${shop}`,
      connectorRequired: false,
      automaticHostDiscoveryGuaranteed: false,
      requires:
        "A browser-capable assistant, or the shopper opening the link. WebMCP is optional; the portal also has ordinary controls.",
    },
    mcp: {
      endpoint: `${base}/mcp`,
      transport: "streamable-http",
      tools: ["start_return"],
      authentication:
        "No shopper authentication for intake. Shopify authenticates the merchant proxy hop.",
    },
    rest: {
      startReturn: `${base}/start-return`,
      method: "POST",
      schemaUrl: `${base}/schema.json`,
    },
    ucp: {
      shopifyProfileUrl: `https://${shop}/.well-known/ucp`,
      standardizedReturnMutation: false,
      orderCapability: "dev.ucp.shopping.order",
      refundPublishesUcpOrderEvents: false,
      note: "This is Gooper.io's supplemental MCP/browser handoff manifest, not a UCP protocol profile or a standardized UCP return operation. Do not replace Shopify's UCP profile or treat this URL as a negotiated UCP API. Returns and refunds that Gooper.io submits are processed as native Shopify returns; any UCP order updates about them are Shopify's to publish.",
    },
    safety: {
      customerVerificationRequired: true,
      exactQuoteConfirmationRequired: true,
      proxyCustomerIdAuthorizesReturns: false,
      intakeCreatesReturn: false,
      intakeIssuesRefund: false,
    },
  };
}

export function merchantAgentsMarkdown(
  shop: string,
  pathPrefix: string,
  guidance: ReturnGuidance | null = null,
) {
  const discovery = merchantReturnDiscovery(shop, pathPrefix, guidance);
  const policy = guidance ? guidanceMarkdown(guidance) : "";
  return `# Returns for ${shop}

This merchant uses Gooper.io for customer-verified return quotes and, where the merchant permits it, customer-confirmed returns and refunds.

## No Gooper.io plugin or connector required

- Browser entry: ${discovery.browser.entryUrl}
- Secure customer portal: ${discovery.browser.portalUrl}
- Merchant-bound manifest: ${discovery.manifestUrl}
- Optional public MCP intake: ${discovery.mcp.endpoint}
- Intake JSON schema: ${discovery.rest.schemaUrl}
- Shopify's own UCP profile: ${discovery.ucp.shopifyProfileUrl}
${policy ? `\n## Return policy\n\n${policy}\n` : ""}
For a return request, open the browser entry, then follow its explicit link to the secure portal. If the host cannot operate websites, give the shopper the portal link and state that the conversation cannot execute the return. Do not ask the shopper to install Gooper.io. Reading this file does not install tools or establish customer identity.

Where the host already supports calling an arbitrary public MCP endpoint, start_return accepts optional orderName, itemName and a UUID idempotencyKey. The shop is fixed by Shopify's signed proxy request; never supply another merchant. POST the same JSON to ${discovery.rest.startReturn} if the host supports HTTP actions. Intake only prepares a verification link and a temporary draft, not a return or refund. Do not put email, passwords, sign-in codes, access tokens, or payment details in these hints.

The customer must complete Shopify sign-in personally on the secure page. Keep passwords and verification codes out of chat. After sign-in, a browser supporting Site Tools can use get_return_session, find_returnable_items and quote_return on the top-level Gooper.io portal. Keep that page loaded while continuing the conversation. Other browser-capable assistants can use its normal controls.

Show the exact item, quantity, refund amount, any return fees, payment method and shipping instructions. A quote or sign-in is NOT consent. Submit only after the customer explicitly confirms that quote. If submissionAvailable is false, stop and explain merchant approval is needed. After an uncertain result, use check_return_status; do not create another return.

The proxy never exposes purchases or executes a refund. Its logged_in_customer_id is not accepted as order ownership or consent. Shopify Customer Account authentication and Gooper.io's signed, expiring, customer-bound quotes remain mandatory.

## Protocol boundary

This is a supplemental merchant guide and MCP/browser handoff, not a standardized UCP return API. Do not replace the merchant's /.well-known/ucp. Returns Gooper.io submits are native Shopify returns, so Shopify's own order data reflects them; Gooper.io does not publish UCP order events itself. Availability of browser actions, Site Tools and automatic discovery depends on the host; ordinary text-only chat is not guaranteed to invoke an arbitrary endpoint.
`;
}

export function proxySchema() {
  return z.toJSONSchema(proxyIntakeSchema);
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

export function merchantHandoffPage(shop: string, pathPrefix: string) {
  const discovery = merchantReturnDiscovery(shop, pathPrefix);
  // Shopify follows upstream redirects itself and strips Set-Cookie. An
  // explicit top-level link, not a 302 or an iframe, preserves portal cookies.
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return a purchase</title></head><body><main>
<h1>Return a purchase from ${escapeHtml(shop)}</h1>
<p>Verify your purchase with Shopify, review the exact quote, and confirm before anything is submitted. No Gooper.io account, plugin, or connector is required.</p>
<p><a href="${escapeHtml(discovery.browser.portalUrl)}" target="_top" rel="noreferrer">Continue securely with Gooper.io</a></p>
<p>Let the customer complete Shopify sign-in themselves. Never share passwords or verification codes in chat. This page has not submitted a return or refund.</p>
<p><a href="${escapeHtml(discovery.agentsUrl)}">Assistant instructions</a> · <a href="${escapeHtml(discovery.manifestUrl)}">Return capability manifest</a></p>
</main></body></html>`,
    {
      headers: {
        ...privateHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      },
    },
  );
}
