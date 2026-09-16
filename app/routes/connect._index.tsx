import { useState } from "react";
import { data, useLoaderData } from "react-router";
import { connectorResource } from "../services/agent-access.server";
import { privateHeaders } from "../services/customer-security.server";
import "../styles/customer-returns.css";

export const headers = () => ({
  ...privateHeaders,
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'",
});

// Never derive OAuth/MCP endpoints from a caller-controlled Host header.
export function loader() {
  return data({ endpoint: connectorResource() }, { headers: headers() });
}

export default function ConnectAllStores() {
  const { endpoint } = useLoaderData<typeof loader>();
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
    <main className="customer-returns connection-page">
      <header>
        <a href="/stores">← Find a store</a>
        <span>GOOPER.IO · ASSISTANT CONNECTION</span>
      </header>
      <h1>Connect your assistant to Gooper.io for every store.</h1>
      <p>
        One connection works with every store that uses Gooper.io. Confirm your
        email once, and Gooper.io finds your orders at the stores you bought from.
      </p>
      <section>
        <h2>1. Add Gooper.io to your assistant</h2>
        <p>
          Add a custom remote MCP connection in ChatGPT or hosted Claude. Name it
          “Gooper.io” and paste this URL:
        </p>
        <label htmlFor="refund-all-stores-url">Gooper.io connection URL</label>
        <input
          id="refund-all-stores-url"
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
          Choose OAuth if asked, and leave client ID and secret blank. On the
          page that opens, confirm the email you shop with and approve Gooper.io.
          No store sign-in needed.
        </p>
        <p>
          Then set Gooper.io to <strong>Always allow</strong> in your assistant’s
          connector settings, so returns finish without extra taps.
        </p>
      </section>
      <section>
        <h2>2. Ask about a return</h2>
        <p>
          Try: “I’d like to return something from [store].” Gooper.io looks for
          your order there using the email you confirmed, so your assistant can
          usually help right away. If you used a different email at that store,
          it asks, and you tap a quick confirmation. No store account or sign-in
          needed.
        </p>
        <p>
          Stores stay linked while you keep using them, and the connection ends
          after a year without use.
        </p>
      </section>
      <section>
        <h2>3. Stay in control</h2>
        <p>
          Your assistant shows the exact items, any fees and your refund, then
          submits only after you say yes. Gooper.io uses your email only to find your orders,
          never for marketing. See and remove your confirmed emails and stores
          on <a href="/connect/manage">your connection page</a> in the browser
          where you approved Gooper.io, or remove Gooper.io from your assistant at any
          time.
        </p>
      </section>
    </main>
  );
}
