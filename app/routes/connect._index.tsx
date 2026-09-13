import { useState } from "react";
import { data, useLoaderData } from "react-router";
import { allStoresResource } from "../services/agent-access.server";
import { privateHeaders } from "../services/customer-security.server";
import "../styles/customer-returns.css";

export const headers = () => ({
  ...privateHeaders,
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'",
});

// Never derive OAuth/MCP endpoints from a caller-controlled Host header.
export function loader() {
  return data({ endpoint: allStoresResource() }, { headers: headers() });
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
    <main className="customer-returns">
      <header>
        <a href="/stores">← Find a store</a>
        <span>REFUND · ASSISTANT CONNECTION</span>
      </header>
      <h1>Connect your assistant to Refund for every store.</h1>
      <p>
        One connection works with every store that uses Refund. You sign in to
        each store you bought from the first time your assistant needs it.
      </p>
      <section>
        <h2>1. Add Refund to your assistant</h2>
        <p>
          Add a custom remote MCP connection in ChatGPT or hosted Claude. Name it
          “Refund” and paste this URL:
        </p>
        <label htmlFor="refund-all-stores-url">Refund connection URL</label>
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
          Choose OAuth if asked, and leave client ID and secret blank. Approve
          Refund on the page that opens; no store sign-in is needed yet.
        </p>
      </section>
      <section>
        <h2>2. Ask about a return</h2>
        <p>
          Try: “Find my returnable purchases from [store] and show me a quote. Do
          not submit anything.” Your assistant finds the store and sends you a
          link to sign in to it with Shopify. Open it in the same browser you
          used to approve Refund, then return to the conversation.
        </p>
        <p>
          Most stores stay linked while you keep using them. If a store asks you
          to sign in again, your assistant sends a new link, and if you’re still
          signed in to that store it’s one click. The connection ends after a
          year without use.
        </p>
      </section>
      <section>
        <h2>3. Stay in control</h2>
        <p>
          A return and refund are only submitted after you confirm the exact
          items and amount. You can unlink a store from its return portal or
          remove Refund from your assistant at any time.
        </p>
      </section>
    </main>
  );
}
