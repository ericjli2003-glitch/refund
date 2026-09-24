import { useState } from "react";
import {
  sandboxActionAvailable,
  sandboxBalances,
  sandboxOperationReference,
  type SandboxAction,
  type SandboxState,
} from "../funded-return-sandbox";
import { fundedReturnProgress } from "../funded-return-display";

const actionLabels: Record<SandboxAction, string> = {
  APPROVE_RISK: "Approve sample risk check",
  REQUEST_PAYOUT: "Send payout through sandbox provider",
  PAYOUT_SUCCEEDED: "Provider confirmed payout",
  PAYOUT_FAILED: "Provider confirmed payout failure",
  PAYOUT_UNKNOWN: "Payout outcome unknown",
  RECEIVE_ITEM: "Mark item received",
  INSPECT_ITEM: "Complete Gooper return",
  REQUEST_COLLECTION: "Process Gooper repayment",
  COLLECTION_SUCCEEDED: "Provider confirmed repayment",
  COLLECTION_FAILED: "Provider confirmed repayment failure",
  COLLECTION_UNKNOWN: "Repayment outcome unknown",
};

const scenarioLabels = {
  SUCCEED: "Succeeds",
  FAIL: "Fails",
  TIMEOUT_AFTER_ACCEPT: "Accepted, but the response times out",
  LOST_BEFORE_ACCEPT: "Request lost before the provider sees it",
  SUCCEED_THEN_REVERSE: "Succeeds, then is reversed",
  FAIL_THEN_LATE_SUCCESS: "Fails, then a contradictory success arrives",
  WRONG_AMOUNT_EVENT: "Webhook reports the wrong amount",
} as const;
type Scenario = keyof typeof scenarioLabels;

export type SandboxPaymentView = {
  id: string;
  caseId: string;
  operation: string;
  attempt: number;
  amountMinor: number;
  currency: string;
  status: string;
  providerReference: string | null;
  submissions: number;
  lookups: number;
  reviewReason: string | null;
  lastError: string | null;
  events: Array<{
    id: string;
    source: string;
    status: string;
    disposition: string;
    detail: string | null;
    receivedAt: string;
  }>;
};

export type FundedOrderCandidate = {
  id: string;
  name: string;
  currency: string;
  lineItems: Array<{ id: string; title: string; quantity: number }>;
};

export type FundedUnitsView = {
  caseId: string;
  lineItemId: string;
  quantity: number;
  status: string;
  shopifyReturnId: string | null;
  conflictReason: string | null;
};

export type FundedSandboxViewProps = {
  cases: Array<{ id: string; version: number; state: SandboxState }>;
  payments: SandboxPaymentView[];
  orders?: FundedOrderCandidate[];
  ordersError?: string | null;
  funded?: FundedUnitsView[];
  actionId: string;
  error?: string | null;
  notice?: string | null;
  busy: boolean;
  onSubmit: (values: Record<string, string>) => void;
};

export default function FundedReturnsSandboxView({
  cases,
  payments,
  orders = [],
  ordersError = null,
  funded = [],
  actionId,
  error,
  notice,
  busy,
  onSubmit,
}: FundedSandboxViewProps) {
  const [orderId, setOrderId] = useState(orders[0]?.id ?? "");
  const order = orders.find((candidate) => candidate.id === orderId) ?? orders[0];
  const [lineItemId, setLineItemId] = useState("");
  const lineItem =
    order?.lineItems.find((line) => line.id === lineItemId) ?? order?.lineItems[0];
  const [orderQuantity, setOrderQuantity] = useState("1");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [payoutScenario, setPayoutScenario] = useState<Scenario>("SUCCEED");
  const [collectionScenario, setCollectionScenario] =
    useState<Scenario>("SUCCEED");
  const [acceptedAmount, setAcceptedAmount] = useState("50.00");
  const selected = cases.find((row) => row.id === selectedId) ?? cases[0];
  const state = selected?.state;
  const balances = state ? sandboxBalances(state) : null;
  const progress = state ? fundedReturnProgress(state) : null;
  const money = (minor: number) =>
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: state?.currency ?? "CAD",
    }).format(minor / 100);
  const send = (intent: SandboxAction) => {
    if (!selected || busy) return;
    onSubmit({
      intent,
      id: selected.id,
      version: String(selected.version),
      actionId,
      ...(intent === "INSPECT_ITEM" ? { acceptedAmount } : {}),
      ...(intent === "REQUEST_PAYOUT" ? { scenario: payoutScenario } : {}),
      ...(intent === "REQUEST_COLLECTION"
        ? { scenario: collectionScenario }
        : {}),
    });
  };
  const caseFunded = funded.filter((units) => units.caseId === selected?.id);
  const casePayments = payments.filter(
    (payment) => payment.caseId === selected?.id,
  );
  const needsReview = casePayments.some(
    (payment) => payment.status === "REVIEW",
  );
  const scenarioSelect = (
    label: string,
    value: Scenario,
    onChange: (value: Scenario) => void,
    action: SandboxAction,
  ) => (
    <s-select
      label={label}
      value={value}
      disabled={busy || !state || !sandboxActionAvailable(state, action)}
      onChange={(event) =>
        onChange(event.currentTarget.value as Scenario)
      }
    >
      {(Object.keys(scenarioLabels) as Scenario[]).map((scenario) => (
        <s-option key={scenario} value={scenario}>
          {scenarioLabels[scenario]}
        </s-option>
      ))}
    </s-select>
  );
  const button = (intent: SandboxAction) => (
    <s-button
      key={intent}
      disabled={busy || !state || !sandboxActionAvailable(state, intent)}
      onClick={() => send(intent)}
    >
      {actionLabels[intent]}
    </s-button>
  );

  return (
    <s-page heading="Gooper-funded returns sandbox" inlineSize="large">
      <s-button slot="secondary-actions" href="/app">
        Back to refunds
      </s-button>
      <s-banner heading="Simulation only — no money moves" tone="warning">
        These are synthetic $50 returns, not Shopify orders. Payments go to a
        fake sandbox provider with no credentials and no bank connection. No
        customer or merchant is charged, and no Shopify return, inventory or
        refund is changed. Samples are saved for this store.
      </s-banner>
      {notice && <s-banner tone="info">{notice}</s-banner>}
      {error && (
        <s-banner heading="That action could not finish" tone="critical">
          {error}
        </s-banner>
      )}

      <s-section heading="Start a sample return">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Test the model: Gooper pays first. The merchant owes repayment only
            after receiving and approving the item.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            {(["CAD", "USD"] as const).map((currency) => (
              <s-button
                key={currency}
                disabled={busy}
                onClick={() => {
                  setSelectedId(null);
                  setAcceptedAmount("50.00");
                  onSubmit({ intent: "create", id: actionId, currency });
                }}
              >
                New {currency} sample
              </s-button>
            ))}
          </s-stack>
          <s-paragraph color="subdued">
            Or start from a real order on this development store. Gooper
            reserves the units, creates an open Shopify return for them (the
            customer isn&apos;t notified) and tags the order gooper-funded, so
            the ordinary refund flow can&apos;t pay for them twice.
          </s-paragraph>
          {ordersError && <s-banner tone="warning">{ordersError}</s-banner>}
          {order && lineItem ? (
            <s-stack direction="block" gap="small">
              <s-select
                label="Order"
                value={order.id}
                disabled={busy}
                onChange={(event) => {
                  setOrderId(event.currentTarget.value);
                  setLineItemId("");
                }}
              >
                {orders.map((candidate) => (
                  <s-option key={candidate.id} value={candidate.id}>
                    {candidate.name} · {candidate.currency}
                  </s-option>
                ))}
              </s-select>
              <s-select
                label="Item"
                value={lineItem.id}
                disabled={busy}
                onChange={(event) => setLineItemId(event.currentTarget.value)}
              >
                {order.lineItems.map((line) => (
                  <s-option key={line.id} value={line.id}>
                    {line.title} (ordered {line.quantity})
                  </s-option>
                ))}
              </s-select>
              <s-text-field
                label="Quantity to fund"
                value={orderQuantity}
                disabled={busy}
                onInput={(event) => setOrderQuantity(event.currentTarget.value)}
              />
              <s-button
                disabled={busy}
                onClick={() =>
                  onSubmit({
                    intent: "fromOrder",
                    orderId: order.id,
                    lineItemId: lineItem.id,
                    quantity: orderQuantity,
                  })
                }
              >
                Start funded case from this order
              </s-button>
            </s-stack>
          ) : (
            !ordersError && (
              <s-paragraph color="subdued">
                No CAD orders found on this store.
              </s-paragraph>
            )
          )}
          {cases.length > 0 && (
            <s-select
              label="Recent sample returns"
              value={selected?.id}
              disabled={busy}
              onChange={(event) => {
                setSelectedId(event.currentTarget.value);
                setAcceptedAmount("50.00");
              }}
            >
              {cases.map((row) => (
                <s-option key={row.id} value={row.id}>
                  {row.state.order
                    ? `${row.state.order.orderName} · ${row.state.order.title}`
                    : `${row.state.currency} sample`}{" "}
                  · {(row.state.amountMinor / 100).toFixed(2)} ·{" "}
                  {row.id.slice(0, 8)} · {row.state.returnStatus}
                </s-option>
              ))}
            </s-select>
          )}
        </s-stack>
      </s-section>

      {state && balances && (
        <>
          {progress && (
            <s-section heading="Funded return status">
              <s-badge tone={progress.tone}>{progress.label}</s-badge>
            </s-section>
          )}
          {state.order && (
            <s-section heading="Linked Shopify order">
              <s-stack direction="block" gap="small">
                <s-paragraph>
                  {state.order.orderName}: {state.order.quantity} ×{" "}
                  {state.order.title}. The ordinary refund flow refuses these
                  units while Gooper holds them.
                </s-paragraph>
                {caseFunded.map((units) => (
                  <s-paragraph key={units.lineItemId + units.status}>
                    <s-badge
                      tone={
                        units.status === "ACTIVE"
                          ? "success"
                          : units.status === "CONFLICT"
                            ? "critical"
                            : "neutral"
                      }
                    >
                      {units.status}
                    </s-badge>{" "}
                    {units.quantity} unit(s) ·{" "}
                    {units.shopifyReturnId
                      ? `Shopify return ${units.shopifyReturnId}`
                      : "No Shopify return yet"}
                    {units.conflictReason ? ` · ${units.conflictReason}` : ""}
                  </s-paragraph>
                ))}
                {caseFunded.some(
                  (units) => units.status === "ACTIVE" && !units.shopifyReturnId,
                ) && (
                  <s-button
                    disabled={busy}
                    onClick={() =>
                      selected && onSubmit({ intent: "attachReturn", id: selected.id })
                    }
                  >
                    Retry creating the Shopify return
                  </s-button>
                )}
                {caseFunded.some((units) => units.status === "ACTIVE") &&
                  (state.payout === "NOT_STARTED" || state.payout === "FAILED") && (
                    <s-button
                      disabled={busy}
                      onClick={() =>
                        selected && onSubmit({ intent: "releaseOrder", id: selected.id })
                      }
                    >
                      Release items and cancel the Shopify return
                    </s-button>
                  )}
              </s-stack>
            </s-section>
          )}
          <s-section heading="1. Gooper funds the customer">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Sample refund: {money(state.amountMinor)}. Risk check:{" "}
                {state.risk}. Payout: {state.payout}.
              </s-paragraph>
              {button("APPROVE_RISK")}
              {scenarioSelect(
                "Sandbox provider behaviour for the next payout",
                payoutScenario,
                setPayoutScenario,
                "REQUEST_PAYOUT",
              )}
              {button("REQUEST_PAYOUT")}
              {sandboxOperationReference(state, "payout") && (
                <s-paragraph color="subdued">
                  Current payout intent:{" "}
                  {sandboxOperationReference(state, "payout")}
                </s-paragraph>
              )}
              {state.payout === "UNKNOWN" && (
                <s-banner tone="warning">
                  The payout outcome is unknown. Check with the provider below;
                  a timeout is not permission to send a second payment.
                </s-banner>
              )}
            </s-stack>
          </s-section>
          <s-section heading="2. Merchant receives and inspects the return">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Return: {state.returnStatus}. Receipt alone does not make
                repayment due. There is no automatic acceptance deadline.
              </s-paragraph>
              {button("RECEIVE_ITEM")}
              <s-text-field
                label={`Amount approved after inspection (${state.currency})`}
                value={acceptedAmount}
                disabled={
                  busy || !sandboxActionAvailable(state, "INSPECT_ITEM")
                }
                onInput={(event) =>
                  setAcceptedAmount(event.currentTarget.value)
                }
              />
              <s-paragraph color="subdued">
                Enter 50.00 for full approval, 25.00 for partial approval, or 0
                for rejection.
              </s-paragraph>
              {button("INSPECT_ITEM")}
              {(state.returnStatus === "REJECTED" ||
                state.returnStatus === "PARTIALLY_APPROVED") && (
                <s-banner tone="warning">
                  {money(balances.FUNDED_EXPOSURE)} remains at risk for Gooper
                  and needs review. This does not authorize a customer charge or
                  merchant repayment for the rejected amount.
                </s-banner>
              )}
            </s-stack>
          </s-section>
          <s-section heading="3. Merchant repays Gooper">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Accepted principal: {money(state.acceptedMinor)}. Collection:{" "}
                {state.collection}.
              </s-paragraph>
              {scenarioSelect(
                "Sandbox provider behaviour for the next repayment",
                collectionScenario,
                setCollectionScenario,
                "REQUEST_COLLECTION",
              )}
              {button("REQUEST_COLLECTION")}
              {sandboxOperationReference(state, "collection") && (
                <s-paragraph color="subdued">
                  Current repayment intent:{" "}
                  {sandboxOperationReference(state, "collection")}
                </s-paragraph>
              )}
              {state.collection === "UNKNOWN" && (
                <s-banner tone="warning">
                  Resolve the existing collection before another attempt. The
                  merchant still owes the approved principal until settlement is
                  confirmed.
                </s-banner>
              )}
            </s-stack>
          </s-section>
          <s-section heading="Sandbox provider">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Outcomes only arrive as signed provider events or provider
                lookups, matched to the exact intent, attempt, amount and
                currency. Unknown outcomes are looked up, never paid again.
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button
                  disabled={busy}
                  onClick={() => onSubmit({ intent: "deliver" })}
                >
                  Deliver next provider webhooks
                </s-button>
                <s-button
                  disabled={busy}
                  onClick={() => onSubmit({ intent: "replay" })}
                >
                  Replay delivered webhooks
                </s-button>
                <s-button
                  disabled={busy}
                  onClick={() => onSubmit({ intent: "reconcile" })}
                >
                  Reconcile with provider now
                </s-button>
              </s-stack>
              {needsReview && (
                <s-banner heading="Payment held for review" tone="critical">
                  A provider result contradicted, reversed or did not match a
                  payment. Balances were not changed, and no new request of
                  that kind is allowed for this sample. There is no automatic
                  resolution.
                </s-banner>
              )}
              {casePayments.length === 0 ? (
                <s-paragraph color="subdued">
                  No payment intents for this sample yet.
                </s-paragraph>
              ) : (
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Payment</s-table-header>
                    <s-table-header>Status</s-table-header>
                    <s-table-header format="currency">Amount</s-table-header>
                    <s-table-header>Provider activity</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {casePayments.map((payment) => (
                      <s-table-row key={payment.id}>
                        <s-table-cell>
                          {payment.operation === "PAYOUT"
                            ? "Customer payout"
                            : "Merchant repayment"}{" "}
                          · attempt {payment.attempt}
                        </s-table-cell>
                        <s-table-cell>
                          <s-badge
                            tone={
                              payment.status === "SUCCEEDED"
                                ? "success"
                                : payment.status === "REVIEW" ||
                                    payment.status === "FAILED"
                                  ? "critical"
                                  : "warning"
                            }
                          >
                            {payment.status}
                          </s-badge>
                        </s-table-cell>
                        <s-table-cell>{money(payment.amountMinor)}</s-table-cell>
                        <s-table-cell>
                          {payment.submissions} submission(s), {payment.lookups}{" "}
                          lookup(s).{" "}
                          {payment.events
                            .map(
                              (event) =>
                                `${event.source} ${event.status}: ${event.disposition}`,
                            )
                            .join("; ")}
                          {payment.reviewReason
                            ? ` Review: ${payment.reviewReason}`
                            : ""}
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              )}
            </s-stack>
          </s-section>
          <s-section heading="Simulation ledger">
            <s-paragraph>
              Changes from a zero starting balance, in {state.currency}. This is
              a workflow ledger, not a bank balance or production accounting
              system.
            </s-paragraph>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Account</s-table-header>
                <s-table-header format="currency">Balance</s-table-header>
              </s-table-header-row>
              <s-table-body>
                <s-table-row>
                  <s-table-cell>Gooper cash change</s-table-cell>
                  <s-table-cell>{money(balances.GOOPER_CASH)}</s-table-cell>
                </s-table-row>
                <s-table-row>
                  <s-table-cell>Funded principal still at risk</s-table-cell>
                  <s-table-cell>{money(balances.FUNDED_EXPOSURE)}</s-table-cell>
                </s-table-row>
                <s-table-row>
                  <s-table-cell>
                    Approved merchant repayment outstanding
                  </s-table-cell>
                  <s-table-cell>
                    {money(balances.MERCHANT_RECEIVABLE)}
                  </s-table-cell>
                </s-table-row>
              </s-table-body>
            </s-table>
          </s-section>
          <s-section heading="Saved activity">
            {state.events.length === 0 ? (
              <s-paragraph>
                No actions yet. Start with the sample risk check.
              </s-paragraph>
            ) : (
              <s-ordered-list>
                {state.events.map((event) => (
                  <s-list-item key={event.command.id}>
                    {actionLabels[event.command.action]} — {event.at}
                    {event.command.acceptedMinor !== undefined
                      ? ` · Approved ${money(event.command.acceptedMinor)}`
                      : ""}
                  </s-list-item>
                ))}
              </s-ordered-list>
            )}
          </s-section>
        </>
      )}
    </s-page>
  );
}
