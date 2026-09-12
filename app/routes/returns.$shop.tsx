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
import {
  registerBrowserReturnTools,
  returnSessionTool,
  type BrowserModelContext,
  type BrowserTool,
} from "../browser-return-tools";
import prisma from "../db.server";
import {
  claimIntakeDraft,
  getReturnSession,
} from "../services/return-draft.server";
import type {
  createReturnQuote,
  submitReturnQuote,
} from "../services/return-quote.server";
import "../styles/customer-returns.css";

type Orders = Awaited<ReturnType<typeof getReturnableOrders>>["orders"];
type Quote = Awaited<ReturnType<typeof createReturnQuote>> & {
  correlationId?: string | null;
};
type Result = Awaited<ReturnType<typeof submitReturnQuote>>;

export const headers = () => privateHeaders;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const shop = await requireInstalledShop(params.shop || "");
  const session = await getCustomerSession(request, shop);
  const url = new URL(request.url);
  const query = new URLSearchParams({ shop });
  const hints = returnHints(url, shop);
  if (session && hints.draftId) {
    await claimIntakeDraft({
      shop,
      customerSubjectHash: session.customerSubjectHash!,
      draftId: hints.draftId,
    });
    await prisma.customerReturnSession.update({
      where: { id: session.id },
      data: { draftId: hints.draftId },
    });
  }
  const draftId = hints.draftId || session?.draftId;
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
      draftId: draftId || null,
      returnSession:
        session && authenticated
          ? await getReturnSession({
              shop,
              customerSubjectHash: session.customerSubjectHash!,
              draftId,
            })
          : null,
      loginUrl: `/customer/login?${query}`,
      error,
    },
    { headers: privateHeaders },
  );
}

export default function CustomerReturns() {
  const initial = useLoaderData<typeof loader>();
  const [orders, setOrders] = useState(initial.orders);
  const [quote, setQuote] = useState<Quote | null>(
    initial.returnSession?.quote
      ? {
          ...initial.returnSession.quote,
          correlationId: initial.returnSession.correlationId,
        }
      : null,
  );
  const [result, setResult] = useState<Result | null>(null);
  const [returnSession, setReturnSession] = useState(initial.returnSession);
  const [error, setError] = useState(initial.error);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [grants, setGrants] = useState(initial.grants);
  const [browserTools, setBrowserTools] = useState<
    "checking" | "unavailable" | "ready" | "failed"
  >("checking");
  const continueInChat = initial.authenticated && browserTools === "ready";

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
        body: JSON.stringify({ ...input, operation, draftId: initial.draftId }),
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
      if (payload.session) {
        setReturnSession(payload.session);
        setResult(null);
        setQuote(
          payload.session.quote
            ? {
                ...payload.session.quote,
                correlationId: payload.session.correlationId,
              }
            : null,
        );
        setConfirmed(false);
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
        modelContext?: BrowserModelContext;
      }
    ).modelContext;
    if (window.top !== window) {
      setBrowserTools("unavailable");
      return;
    }
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
      returnSessionTool({
        shop: initial.shop,
        authenticated: initial.authenticated,
        loginUrl: new URL(initial.loginUrl, window.location.origin).href,
        resume: run("get_session"),
      }),
      {
        name: "check_return_status",
        description:
          "Check the signed-in customer's current Refund draft or submitted return status. Use after a retry, interruption, or uncertain response before attempting any later action.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
        execute: run("status"),
      },
      {
        name: "find_returnable_items",
        description:
          "Read the signed-in customer's recent orders, returnable products, and ineligibility reasons. Match the customer's requested order and item; never substitute another product without asking.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          consequentialHint: false,
          untrustedContentHint: true,
        },
        execute: run("list"),
      },
      {
        name: "quote_return",
        description:
          "Calculate and persist a resumable return quote without submitting anything. Show the exact order, products, quantities, currency, amount, correlation ID, and shipping instructions in the conversation; do not require the customer to click the page's quote button. If submissionAvailable is false, explain that merchant approval is needed and stop. Otherwise, stop for explicit customer confirmation.",
        inputSchema: {
          type: "object",
          properties: { orderId: { type: "string" }, items },
          required: ["orderId", "items"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          consequentialHint: false,
          untrustedContentHint: true,
        },
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
          consequentialHint: true,
          untrustedContentHint: true,
          destructiveHint: true,
          idempotentHint: true,
        },
        execute: run("confirm"),
      },
    ];
    setBrowserTools("checking");
    return registerBrowserReturnTools(context, tools, setBrowserTools);
    // The registration closes over only stable session information; state setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    initial.authenticated,
    initial.csrf,
    initial.shop,
    initial.loginUrl,
    initial.draftId,
  ]);

  return (
    <main className="customer-returns">
      <header>
        <a href={`https://${initial.shop}`}>← Back to store</a>
        <span>REFUND · CUSTOMER RETURNS</span>
      </header>
      <h1>
        {continueInChat
          ? "You’re connected. Continue in chat."
          : "Let’s find your return."}
      </h1>
      <p className="return-intro">
        Securely connected to {initial.shop}. Nothing is submitted until you
        confirm the items and refund amount.
      </p>
      <p>
        Prefer a connected assistant?{" "}
        <a href={`/connect/${initial.shop}`}>Connect ChatGPT or Claude to Refund</a>.
      </p>
      <p role="status">
        {browserTools === "checking" && "Checking browser return-tool support…"}
        {browserTools === "ready" &&
          "Return tools are available to a compatible agent in this browser. No Refund connector is needed here; customer sign-in and refund confirmation are still required."}
        {browserTools === "unavailable" &&
          "This browser does not expose WebMCP page tools. You can use the return form below; automatic tool access depends on your browser and assistant."}
        {browserTools === "failed" &&
          "Browser return tools could not be registered. You can still use the return form below."}
      </p>
      {continueInChat && (
        <p className="return-chat-handoff" role="status">
          Your assistant can find your purchase and show your quote in the
          conversation. Keep this tab open while you continue in chat. You only
          need the purchase form below if you prefer to continue here.
        </p>
      )}
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
              <h2>{result.title}</h2>
              <p>{result.message}</p>
              <p>{result.currencyCode} {result.amount} · {result.paymentMethod}</p>
            </section>
          )}
          <section aria-label="Return status">
            <h2>Your return status</h2>
            <p>Latest recorded Shopify updates. Your bank&apos;s posting time may vary.</p>
            <button disabled={busy} onClick={() => void call("status").catch(() => {})}>
              Refresh return status
            </button>
            {!returnSession?.submissions.length && !result && <p>No return submissions yet.</p>}
            {returnSession?.submissions.map((submission) => (
              <article key={submission.id}>
                <h3>{submission.orderName || "Return"} · {submission.title}</h3>
                <p>{submission.currencyCode} {submission.amount} · {submission.paymentMethod}</p>
                <p>{submission.message}</p>
              </article>
            ))}
          </section>
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
              <h2>
                {quote.submissionAvailable
                  ? "Review before confirming"
                  : "Your return estimate"}
              </h2>
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
              {quote.correlationId && (
                <p>Return reference: {quote.correlationId}</p>
              )}
              {!quote.submissionAvailable && <p>{quote.nextStep}</p>}
              {quote.submissionAvailable && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />{" "}
                    I confirm these items and this amount for a refund to my original payment method. I will follow the store&apos;s return instructions.
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
                </>
              )}
            </section>
          )}
          <details className="return-purchases" open={!continueInChat}>
            <summary>View purchases or continue here</summary>
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
          </details>
        </>
      )}
      <footer>
        Your assistant can use the return tools on this page in compatible
        browsers. Signing in or requesting a quote never issues a refund.
      </footer>
    </main>
  );
}
