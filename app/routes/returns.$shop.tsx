import { useEffect, useState } from "react";
import { data, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { getReturnableOrders } from "../services/automatic-return.server";
import { CustomerAccountApiError } from "../services/customer-account.server";
import {
  getCustomerSession,
  requireInstalledShop,
} from "../services/customer-session.server";
import { privateHeaders } from "../services/customer-security.server";
import { returnHints } from "../services/return-intake.server";
import { listAgentGrants } from "../services/agent-access.server";
import type {
  createReturnQuote,
  submitReturnQuote,
} from "../services/return-quote.server";
import "../styles/customer-returns.css";

type Orders = Awaited<ReturnType<typeof getReturnableOrders>>["orders"];
type Quote = Awaited<ReturnType<typeof createReturnQuote>>;
type Result = Awaited<ReturnType<typeof submitReturnQuote>>;
type BrowserTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

export const headers = () => privateHeaders;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const shop = await requireInstalledShop(params.shop || "");
  const session = await getCustomerSession(request, shop);
  const url = new URL(request.url);
  const query = new URLSearchParams({ shop });
  const hints = returnHints(url, shop);
  const hasNewHints = Boolean(
    hints.orderName || hints.itemName || url.searchParams.has("continuation"),
  );
  const orderHint =
    hints.orderName || (!hasNewHints && session?.orderHint) || "";
  const itemHint = hints.itemName || (!hasNewHints && session?.itemHint) || "";
  if (orderHint) query.set("orderName", orderHint);
  if (itemHint) query.set("itemName", itemHint);
  if (url.searchParams.has("continuation")) {
    query.delete("orderName");
    query.delete("itemName");
    query.set("continuation", url.searchParams.get("continuation")!);
  }
  let orders: Orders = [];
  let error = url.searchParams.has("loginError")
    ? "Sign-in was not completed. Please try again."
    : "";
  let authenticated = Boolean(session);
  if (session) {
    try {
      orders = (await getReturnableOrders(shop, session.customerToken)).orders;
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Could not load your purchases.";
      if (cause instanceof CustomerAccountApiError && cause.status === 401)
        authenticated = false;
    }
  }
  return data(
    {
      shop,
      authenticated,
      grants: session && authenticated ? await listAgentGrants(session.id) : [],
      csrf: session?.csrfToken || "",
      orders,
      orderHint,
      itemHint,
      loginUrl: `/customer/login?${query}`,
      error,
    },
    { headers: privateHeaders },
  );
}

export default function CustomerReturns() {
  const initial = useLoaderData<typeof loader>();
  const [orders, setOrders] = useState(initial.orders);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState(initial.error);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [grants, setGrants] = useState(initial.grants);

  async function call(operation: string, input: Record<string, unknown> = {}) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/returns/${initial.shop}`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Return-CSRF": initial.csrf,
        },
        body: JSON.stringify({ ...input, operation }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "The request failed.");
      if (payload.orders) setOrders(payload.orders);
      if (payload.grants) setGrants(payload.grants);
      if (payload.quote) {
        setQuote(payload.quote);
        setConfirmed(false);
        setResult(null);
      }
      if (payload.result) {
        setResult(payload.result);
        setQuote(null);
      }
      return payload;
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "The request failed.";
      setError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (tool: BrowserTool) => unknown;
          unregisterTool?: (name: string) => void;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const items = {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          lineItemId: { type: "string" },
          quantity: { type: "integer", minimum: 1 },
        },
        required: ["lineItemId", "quantity"],
        additionalProperties: false,
      },
    };
    const run =
      (operation: string) => async (input: Record<string, unknown>) => {
        if (!initial.authenticated)
          return {
            authenticationRequired: true,
            loginUrl: new URL(initial.loginUrl, window.location.origin).href,
            nextStep:
              "Ask the customer to sign in using the visible link. No return has been submitted.",
          };
        try {
          return await call(operation, input);
        } catch (cause) {
          return {
            isError: true,
            error:
              cause instanceof Error ? cause.message : "Return action failed.",
          };
        }
      };
    const tools: BrowserTool[] = [
      {
        name: "find_returnable_items",
        description:
          "Read the signed-in customer's recent orders, returnable products, and ineligibility reasons. Match the customer's requested order and item; never substitute another product without asking.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
        execute: run("list"),
      },
      {
        name: "quote_return",
        description:
          "Calculate a return quote without submitting anything. Show the customer the exact order, products, quantities, currency, amount, and shipping instructions, then ask for explicit confirmation.",
        inputSchema: {
          type: "object",
          properties: { orderId: { type: "string" }, items },
          required: ["orderId", "items"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
        execute: run("quote"),
      },
      {
        name: "confirm_return",
        description:
          "CONSEQUENTIAL: opens a return and submits a refund to the original payment method. Only call after the customer explicitly confirms the exact quote from quote_return. Never infer consent from login or a request to check eligibility. Reuse the same quoteToken for retries.",
        inputSchema: {
          type: "object",
          properties: {
            quoteToken: { type: "string" },
            customerConfirmed: { type: "boolean", const: true },
            customerNote: { type: "string", maxLength: 300 },
          },
          required: ["quoteToken", "customerConfirmed"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
        execute: run("confirm"),
      },
    ];
    for (const tool of tools) context.registerTool(tool);
    return () => {
      for (const tool of tools) context.unregisterTool?.(tool.name);
    };
    // The registration closes over only stable session information; state setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.authenticated, initial.csrf, initial.shop, initial.loginUrl]);

  return (
    <main className="customer-returns">
      <header>
        <a href={`https://${initial.shop}`}>← Back to store</a>
        <span>REFUND · CUSTOMER RETURNS</span>
      </header>
      <h1>Let’s find your return.</h1>
      <p className="return-intro">
        Securely connected to {initial.shop}. Nothing is submitted until you
        confirm the items and refund amount.
      </p>
      {(initial.orderHint || initial.itemHint) && (
        <p>
          Looking for:{" "}
          {[initial.orderHint, initial.itemHint].filter(Boolean).join(" · ")}
        </p>
      )}
      {error && (
        <section role="alert" className="return-error">
          <h2>We need to check something</h2>
          <p>{error}</p>
          <a href={initial.loginUrl}>Sign in again</a>
        </section>
      )}
      {!initial.authenticated ? (
        <section>
          <h2>Verify your purchase</h2>
          <p>
            Use the email address you used at checkout. Shopify will verify it
            with a sign-in code or another sign-in option offered by this store.
            You do not need a Shopify merchant account or a new password.
          </p>
          <p>
            Enter sign-in codes only on Shopify’s secure page. After
            verification, you can review your purchases here with your
            assistant.
          </p>
          <a className="return-button" href={initial.loginUrl}>
            Continue to verify my purchase
          </a>
        </section>
      ) : (
        <>
          <p className="return-connected">
            ✓ Customer connected{" "}
            <button
              className="return-link"
              disabled={busy}
              onClick={() =>
                void call("logout")
                  .then(() => window.location.reload())
                  .catch(() => {})
              }
            >
              Sign out of Refund
            </button>
          </p>
          {result && (
            <section role="status">
              <h2>
                {result.status === "REFUND_SUBMITTED"
                  ? "Refund submitted"
                  : "Return status"}
              </h2>
              <p>{result.message}</p>
              <p>Status: {result.status}</p>
            </section>
          )}
          {grants.length > 0 && (
            <section aria-label="Connected assistants">
              <h2>Connected assistants</h2>
              {grants.map((grant) => (
                <div key={grant.id}>
                  <p>
                    <strong>{grant.name}</strong> · Expires{" "}
                    {new Date(grant.expiresAt).toLocaleString()}
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void call("disconnect_assistant", {
                        grantId: grant.id,
                      }).catch(() => {})
                    }
                  >
                    Disconnect {grant.name}
                  </button>
                </div>
              ))}
            </section>
          )}
          {quote && (
            <section className="return-quote" aria-label="Return quote">
              <h2>Review before confirming</h2>
              <p>{quote.orderName}</p>
              <ul>
                {quote.items.map((item) => (
                  <li key={item.lineItemId}>
                    {item.quantity} × {item.title}
                  </li>
                ))}
              </ul>
              <p className="return-amount">
                {quote.expectedRefund.currencyCode}{" "}
                {quote.expectedRefund.amount}
              </p>
              <p>{quote.paymentMethod}</p>
              <p>{quote.returnShipping}</p>
              <p>Quote expires at {quote.expiresAt}.</p>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />{" "}
                I confirm these items and this refund amount.
              </label>
              <button
                disabled={busy || !confirmed}
                onClick={() =>
                  void call("confirm", {
                    quoteToken: quote.quoteToken,
                    customerConfirmed: true,
                  }).catch(() => {})
                }
              >
                Confirm return and refund
              </button>
            </section>
          )}
          <h2>Your recent purchases</h2>
          {!orders.length && !error && (
            <p>No recent orders are available for this account.</p>
          )}
          {orders.map((order) => (
            <section key={order.id}>
              <h3>Order {order.name}</h3>
              <p>Purchased {order.processedAt.slice(0, 10)}</p>
              {order.returnInformation.returnableLineItems.nodes.map(
                (entry) => (
                  <form
                    key={entry.lineItem.id}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      void call("quote", {
                        orderId: order.id,
                        items: [
                          {
                            lineItemId: entry.lineItem.id,
                            quantity: Number(form.get("quantity")),
                          },
                        ],
                      }).catch(() => {});
                    }}
                  >
                    <h4>{entry.lineItem.presentmentTitle}</h4>
                    <p>
                      Item total:{" "}
                      {entry.lineItem.currentTotalPrice.currencyCode}{" "}
                      {entry.lineItem.currentTotalPrice.amount}
                    </p>
                    <label>
                      Quantity{" "}
                      <input
                        aria-label={`Quantity for ${entry.lineItem.presentmentTitle}`}
                        name="quantity"
                        type="number"
                        min="1"
                        max={entry.quantity}
                        defaultValue="1"
                        required
                      />
                    </label>
                    <button disabled={busy}>Get refund quote</button>
                  </form>
                ),
              )}
              {!order.returnInformation.returnableLineItems.nodes.length && (
                <p>
                  No items are currently eligible for a return.{" "}
                  {order.returnInformation.nonReturnableSummary?.nonReturnableReasons.join(
                    ", ",
                  )}
                </p>
              )}
            </section>
          ))}
        </>
      )}
      <footer>
        Your assistant can use the return tools on this page in compatible
        browsers. Signing in or requesting a quote never issues a refund.
      </footer>
    </main>
  );
}
