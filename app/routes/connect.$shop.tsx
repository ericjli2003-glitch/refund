import { useState } from "react";
import { data, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { agentResource } from "../services/agent-access.server";
import { normalizeShopDomain } from "../services/customer-account.server";
import { requireInstalledShop } from "../services/customer-session.server";
import { privateHeaders } from "../services/customer-security.server";
import "../styles/customer-returns.css";

export const headers = () => ({
  ...privateHeaders,
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'",
});

export async function loader({ params }: LoaderFunctionArgs) {
  let shop: string;
  try {
    shop = normalizeShopDomain(params.shop || "");
  } catch {
    throw new Response("Use a valid Shopify store domain.", {
      status: 400,
      headers: headers(),
    });
  }
  await requireInstalledShop(shop);
  // Never derive OAuth/MCP endpoints from a caller-controlled Host header.
  return data({ shop, endpoint: agentResource(shop) }, { headers: headers() });
}

export function CustomerConnection({
  shop,
  endpoint,
}: {
  shop: string;
  endpoint: string;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopyStatus("Connection URL copied.");
    } catch {
      setCopyStatus("Select the URL above and copy it manually.");
    }
  }
  return (
    <main className="customer-returns">
      <header>
        <a href={`/returns/${shop}`}>← Return portal</a>
        <span>REFUND · ASSISTANT CONNECTION</span>
      </header>
      <h1>Connect your assistant to Refund.</h1>
      <p>
        Find purchases and prepare a return in your conversation. This
        connection is only for <strong>{shop}</strong>, not all stores you shop
        with.
      </p>
      <section>
        <h2>1. Add Refund to your assistant</h2>
        <p>
          Add a custom remote MCP connection in ChatGPT or hosted Claude. Name
          it “Refund” and paste this complete URL, including the store domain:
        </p>
        <label htmlFor="refund-mcp-url">Customer MCP connection URL</label>
        <input
          id="refund-mcp-url"
          className="return-connection-url"
          type="text"
          value={endpoint}
          readOnly
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" onClick={copyEndpoint}>
          Copy connection URL
        </button>
        <p role="status" aria-live="polite">
          {copyStatus}
        </p>
        <p>
          Choose OAuth if asked. Leave client ID and client secret blank to use
          automatic registration. Do not paste a Shopify token or password.
        </p>
        <p>
          ChatGPT may require developer mode; account and workspace restrictions
          apply. This is a custom connection, not a published directory listing.
        </p>
        <p>
          <a href="https://developers.openai.com/plugins/deploy/connect-chatgpt">
            ChatGPT setup instructions
          </a>
          {" · "}
          <a href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp">
            Claude setup instructions
          </a>
        </p>
      </section>
      <section>
        <h2>2. Verify your purchase and allow access</h2>
        <p>
          Start Connect in your assistant. Complete Shopify sign-in yourself,
          then review the store, assistant and requested permissions on Refund’s
          consent page. Enter verification codes only on Shopify’s sign-in page,
          never in chat.
        </p>
        <p>
          Connecting does not submit a return or refund. Access lasts up to one
          hour and may end sooner with your customer session. Reconnect when it
          expires. You can disconnect the assistant from the return portal.
        </p>
      </section>
      <section>
        <h2>3. Ask about your return</h2>
        <p>
          Start with: “Find my returnable purchases and show me a quote. Do not
          submit anything.”
        </p>
        <p>
          Your assistant can find eligible items, calculate a quote and check
          return status. A return and refund can only be submitted after you
          explicitly confirm the exact items and amount. Merchant return rules
          still apply.
        </p>
        <p>
          If your assistant cannot connect,{" "}
          <a href={`/returns/${shop}`}>use the return portal</a>.
        </p>
      </section>
    </main>
  );
}

export default function ConnectCustomerAssistant() {
  const info = useLoaderData<typeof loader>();
  return <CustomerConnection {...info} />;
}
