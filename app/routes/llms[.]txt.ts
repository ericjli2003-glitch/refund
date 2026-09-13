import {
  findPublishedMerchants,
  merchantProfilePath,
} from "../services/merchant-directory.server";
import { appOrigin } from "../services/customer-security.server";

// Store names come from Shopify and are merchant-controlled; keep them on one
// line and unable to break the markdown link syntax.
const linkText = (value: string) =>
  value.replace(/[\r\n]+/g, " ").replace(/[[\]()\\]/g, "\\$&");

export async function loader() {
  const origin = appOrigin();
  const stores = await findPublishedMerchants();
  const listed = stores.length
    ? stores
        .map(
          (store) =>
            `- [${linkText(store.name)}](${origin}${merchantProfilePath(store.shop)}): ${store.primaryDomain}`,
        )
        .join("\n")
    : "- No stores are listed yet.";
  return new Response(
    `# Refund

> Refund handles customer-confirmed returns for Shopify stores. Find the store a purchase came from; the customer then verifies the purchase with that store's own Shopify sign-in and confirms an exact quote before any return or refund is submitted.

## Find a store

- Store directory: ${origin}/stores
- Search: GET ${origin}/api/merchants?query=STORE_NAME_OR_WEBSITE
- Public MCP (streamable HTTP, no sign-in): POST ${origin}/mcp with tools find_store and start_return

## Rules for assistants

- Search with only a business name or store website. Never send customer, order, item, payment or sign-in details.
- If several stores match, show them and ask the customer which website they bought from. Never choose for them or substitute another store.
- If no store matches, stop. Do not start a return with a different store.
- start_return only prepares a verification link. Shopify customer accounts are separate for each store, so the customer signs in with the store they bought from, personally, on Shopify's page.
- Sign-in and a quote are not consent. Submit a return only after the customer explicitly confirms the exact quote, including any return fees.
- Refunds go only to the original payment method.

## Listed stores

${listed}
`,
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
