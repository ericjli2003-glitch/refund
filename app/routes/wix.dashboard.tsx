import type { ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  isRouteErrorResponse,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";

import {
  WIX_INSTANCE_FIELD,
  loadWixDashboard,
  requireWixDashboardSession,
  runWixDashboardAction,
  wixDashboardHeaders,
} from "../services/wix/wix-dashboard.server";
import styles from "../styles/wix-dashboard.module.css";

// The Gooper.io page inside a Wix site's dashboard. Wix frames it and passes a
// signed `instance`; everything this page shows or changes belongs to the
// site that instance names. See wix-dashboard.server.ts for how the identity
// is carried from the first load to every form post.

export const headers = () => wixDashboardHeaders();

export const meta = () => [{ title: "Gooper.io" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requireWixDashboardSession(request);
  const showArchived =
    new URL(request.url).searchParams.get("archived") === "1";
  return loadWixDashboard(session, { showArchived });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const session = await requireWixDashboardSession(request, formData);
  return runWixDashboardAction(session, formData);
};

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type ReadyData = Extract<Data, { ready: true }>;
type ReturnRow = ReadyData["returns"][number];

function formatMoney(amount: string, currencyCode: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(Number(amount));
  } catch {
    return `${amount} ${currencyCode}`;
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

// Every form carries the signed instance Wix opened the page with; the server
// verifies it again on each post.
function DashboardForm({
  signedInstance,
  intent,
  children,
  fields = {},
  className,
}: {
  signedInstance: string;
  intent: string;
  children: ReactNode;
  fields?: Record<string, string>;
  className?: string;
}) {
  return (
    <Form method="post" className={className}>
      <input type="hidden" name={WIX_INSTANCE_FIELD} value={signedInstance} />
      <input type="hidden" name="intent" value={intent} />
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
    </Form>
  );
}

function Banner({
  tone,
  heading,
  children,
}: {
  tone: "success" | "warning" | "critical" | "info";
  heading: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`${styles.banner} ${styles[tone]}`}
      role={tone === "critical" ? "alert" : "status"}
    >
      <strong>{heading}</strong>
      {children}
    </div>
  );
}

function HowItWorks({
  connectUrl,
  publicPageUrl,
}: {
  connectUrl: string;
  publicPageUrl: string;
}) {
  return (
    <section className={styles.card} aria-labelledby="how-it-works">
      <h2 id="how-it-works">How it works</h2>
      <ol className={styles.steps}>
        <li>Save your return rules below. Returns start only after you do.</li>
        <li>
          Customers add Gooper.io to ChatGPT or Claude from{" "}
          <a
            className={styles.link}
            href={connectUrl}
            target="_blank"
            rel="noreferrer"
          >
            {connectUrl.replace(/^https:\/\//, "")}
          </a>{" "}
          and confirm their email once.
        </li>
        <li>
          Their assistant finds their orders at your store by that email, quotes
          the refund under your rules, and submits the return after they say
          yes.
        </li>
        <li>
          Your store&apos;s public returns page is{" "}
          <a
            className={styles.link}
            href={publicPageUrl}
            target="_blank"
            rel="noreferrer"
          >
            {publicPageUrl.replace(/^https:\/\//, "")}
          </a>
          .
        </li>
      </ol>
    </section>
  );
}

function ReturnActions({
  row,
  showArchived,
  signedInstance,
  busy,
}: {
  row: ReturnRow;
  showArchived: boolean;
  signedInstance: string;
  busy: boolean;
}) {
  const action = (
    intent: string,
    label: string,
    explanation: string | null = null,
    fields: Record<string, string> = {},
  ) => (
    <DashboardForm
      signedInstance={signedInstance}
      intent={intent}
      fields={{ agentReturnId: row.id, ...fields }}
    >
      {explanation && <p className={styles.muted}>{explanation}</p>}
      <button className={styles.button} type="submit" disabled={busy}>
        {label}
      </button>
    </DashboardForm>
  );
  return (
    <div className={styles.rowActions}>
      {row.trackingNumber && (
        <p>
          Tracking:{" "}
          {row.trackingUrl ? (
            <a
              className={styles.link}
              href={row.trackingUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {row.trackingNumber}
            </a>
          ) : (
            row.trackingNumber
          )}
        </p>
      )}
      {!row.trackingNumber && row.trackingUrl && (
        <p>
          <a
            className={styles.link}
            href={row.trackingUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Track the return shipment
          </a>
        </p>
      )}
      {row.itemReceivedAt && (
        <p className={styles.muted}>
          Item received {formatDate(row.itemReceivedAt)}
        </p>
      )}
      {row.failureReason && <p>{row.failureReason}</p>}
      {showArchived
        ? action("unarchiveReturn", "Restore")
        : row.archivable && action("archiveReturn", "Archive")}
      {row.receivable && row.refundTiming !== "ON_RECEIPT" && (
        <div className={styles.inline}>
          {action("receiveReturn", "Mark received", null, { restock: "false" })}
          {action("receiveReturn", "Mark received and restock")}
        </div>
      )}
      {row.receivable &&
        row.refundTiming === "ON_RECEIPT" &&
        action(
          "receiveReturn",
          "Mark received and refund",
          "Once the item is back, this checks Wix for any existing refund, then refunds the amount the customer confirmed and restocks the item.",
        )}
      {row.retryable &&
        action(
          "retryReturn",
          "Retry refund",
          "Retrying checks Wix first. It refunds the amount the customer confirmed only if no refund exists for it yet. A return set to refund on receipt goes back to waiting for its item.",
        )}
      {row.removable &&
        action(
          "removeReturn",
          "Remove",
          row.status === "NOT_SUBMITTED"
            ? "Wix turned this request down, so no refund exists. Removing it clears it from this list."
            : "Wix never confirmed a refund for this request. Check the order in Wix first; removing it only clears it from Gooper.io so the customer can try again.",
        )}
    </div>
  );
}

function ReturnsList({ data, busy }: { data: ReadyData; busy: boolean }) {
  const { showArchived, archivedCount, returns, signedInstance } = data;
  // Links keep the signed instance so the page can load again after moving
  // between views.
  const viewHref = (archived: boolean) =>
    `?${new URLSearchParams({
      [WIX_INSTANCE_FIELD]: signedInstance,
      ...(archived ? { archived: "1" } : {}),
    })}`;
  return (
    <section className={styles.card} aria-labelledby="returns-heading">
      <h2 id="returns-heading">
        {showArchived ? "Archived returns" : "Recent returns"}
      </h2>
      <p>
        {showArchived ? (
          <a className={styles.link} href={viewHref(false)}>
            Back to recent returns
          </a>
        ) : (
          archivedCount > 0 && (
            <a className={styles.link} href={viewHref(true)}>
              View {archivedCount} archived return
              {archivedCount === 1 ? "" : "s"}
            </a>
          )
        )}
      </p>
      {returns.length === 0 ? (
        <p className={styles.muted}>
          {showArchived
            ? "Nothing archived yet."
            : "No customer-agent return requests have been received yet."}
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Requested</th>
                <th scope="col">Status</th>
                <th scope="col" className={styles.amount}>
                  Refund
                </th>
              </tr>
            </thead>
            <tbody>
              {returns.map((row) => (
                <tr key={row.id}>
                  <td>{row.orderLabel}</td>
                  <td>{formatDate(row.createdAt)}</td>
                  <td>
                    <span className={`${styles.badge} ${styles[row.tone]}`}>
                      {row.statusTitle}
                    </span>
                    <ReturnActions
                      row={row}
                      showArchived={showArchived}
                      signedInstance={signedInstance}
                      busy={busy}
                    />
                  </td>
                  <td className={styles.amount}>
                    {row.amount && row.currencyCode
                      ? formatMoney(row.amount, row.currencyCode)
                      : "Not set"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PolicyForm({ data, busy }: { data: ReadyData; busy: boolean }) {
  const { policy, collections, signedInstance } = data;
  const currency = policy.currencyCode ?? "";
  return (
    <section className={styles.card} aria-labelledby="policy-heading">
      <h2 id="policy-heading">Return automation</h2>
      <dl className={styles.summary}>
        <div>
          <dt>Automatic refunds</dt>
          <dd>{policy.automaticRefundsEnabled ? "Enabled" : "Quotes only"}</dd>
        </div>
        <div>
          <dt>Refund timing</dt>
          <dd>
            {policy.refundTiming === "ON_RECEIPT"
              ? "After the item is received"
              : "When the customer confirms"}
          </dd>
        </div>
        <div>
          <dt>AI-assisted returns</dt>
          <dd>{policy.verifiedStoreLinks ? "Enabled" : "Paused"}</dd>
        </div>
        <div>
          <dt>Return window</dt>
          <dd>{policy.returnWindowDays} days</dd>
        </div>
      </dl>
      {!policy.returnRulesConfirmedAt && (
        <Banner tone="info" heading="Save to turn on AI-assisted returns">
          Customers can&apos;t start returns at your store from ChatGPT or
          Claude until you review these rules and save.
        </Banner>
      )}
      {policy.returnRulesMismatch && (
        <Banner tone="warning" heading="AI-assisted returns are paused">
          {policy.returnRulesMismatch} Check the fees and final-sale choices
          below, then save.
        </Banner>
      )}
      <details
        className={styles.details}
        open={!policy.returnRulesConfirmedAt || undefined}
      >
        <summary>Edit automation and return policy</summary>
        <DashboardForm
          signedInstance={signedInstance}
          intent="savePolicy"
          className={styles.stack}
        >
          <label className={styles.check}>
            <input
              type="checkbox"
              name="automaticRefundsEnabled"
              value="true"
              defaultChecked={policy.automaticRefundsEnabled}
            />
            <span>
              Refund eligible returns to the original payment method when the
              customer confirms
            </span>
          </label>
          <p className={styles.hint}>
            Quotes work without this. When it is on, the customer sees the
            amount and timing, says yes, and Gooper.io submits the refund
            through Wix to their original payment method.
          </p>

          <div className={styles.grid2}>
            <div className={styles.field}>
              <label htmlFor="returnWindowDays">Return window (days)</label>
              <input
                id="returnWindowDays"
                name="returnWindowDays"
                type="number"
                min={1}
                max={365}
                step={1}
                required
                defaultValue={policy.returnWindowDays}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="maxAutoRefundAmount">
                Maximum automatic refund{currency ? ` (${currency})` : ""}
              </label>
              <input
                id="maxAutoRefundAmount"
                name="maxAutoRefundAmount"
                type="number"
                min={0.01}
                max={100000}
                step={0.01}
                required
                defaultValue={policy.maxAutoRefundAmount}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="refundTiming">When to refund</label>
              <select
                id="refundTiming"
                name="refundTiming"
                defaultValue={policy.refundTiming}
              >
                <option value="IMMEDIATE">
                  As soon as the customer confirms the return
                </option>
                <option value="ON_RECEIPT">
                  After I mark the returned item received
                </option>
              </select>
            </div>
          </div>
          <p className={styles.hint}>
            Immediate refunds reach customers before you receive the item, so
            your store carries the risk if it never comes back. Refunds on
            receipt wait until you mark the item received below.
          </p>

          <label className={styles.check}>
            <input
              type="checkbox"
              name="verifiedStoreLinks"
              value="true"
              defaultChecked={policy.verifiedStoreLinks}
            />
            <span>Let customers return through their AI assistant</span>
          </label>
          <p className={styles.hint}>
            Wix doesn&apos;t apply return rules to these returns, so Gooper.io
            applies the fees and final-sale choices below. Saving confirms they
            match your store&apos;s return policy.
          </p>

          <div className={styles.grid2}>
            <div className={styles.field}>
              <label htmlFor="restockingFeePercent">Restocking fee (%)</label>
              <input
                id="restockingFeePercent"
                name="restockingFeePercent"
                type="number"
                min={0}
                max={100}
                step={0.01}
                defaultValue={policy.restockingFeePercent}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="returnShippingFee">
                Return shipping fee{currency ? ` (${currency})` : ""}
              </label>
              <input
                id="returnShippingFee"
                name="returnShippingFee"
                type="number"
                min={0}
                max={1000}
                step={0.01}
                defaultValue={policy.returnShippingFee}
              />
            </div>
          </div>

          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>
              Final-sale collections or categories (up to{" "}
              {data.finalSaleCollectionLimit})
            </legend>
            {collections === null ? (
              <p className={styles.hint}>
                Gooper.io couldn&apos;t read your store&apos;s collections just
                now. Reload the page to try again.
              </p>
            ) : collections.length ? (
              <div className={styles.choices}>
                {collections.map((collection) => (
                  <label key={collection.id} className={styles.check}>
                    <input
                      type="checkbox"
                      name="finalSaleCollectionIds"
                      value={collection.id}
                      defaultChecked={policy.finalSaleCollectionIds.includes(
                        collection.id,
                      )}
                    />
                    <span>{collection.name}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className={styles.hint}>
                Your store has no collections to mark as final sale.
              </p>
            )}
          </fieldset>

          <div className={styles.field}>
            <label htmlFor="returnInstructions">
              Return instructions for customers and assistants
            </label>
            <textarea
              id="returnInstructions"
              name="returnInstructions"
              maxLength={data.instructionsMaxLength}
              rows={4}
              aria-describedby="returnInstructionsHint"
              defaultValue={policy.returnInstructions ?? ""}
            />
            <p id="returnInstructionsHint" className={styles.hint}>
              Shown with every quote and on your public return page. Plain text,
              up to {data.instructionsMaxLength} characters.
            </p>
          </div>
          <div className={styles.field}>
            <label htmlFor="returnPolicyUrl">Return policy page</label>
            <input
              id="returnPolicyUrl"
              name="returnPolicyUrl"
              type="url"
              aria-describedby="returnPolicyUrlHint"
              defaultValue={policy.returnPolicyUrl ?? ""}
            />
            <p id="returnPolicyUrlHint" className={styles.hint}>
              A page on your own site&apos;s domain, starting with https://.
            </p>
          </div>

          <div className={styles.inline}>
            <button className={styles.primary} type="submit" disabled={busy}>
              Save policy
            </button>
          </div>
        </DashboardForm>
      </details>
    </section>
  );
}

function ListingCard({ data, busy }: { data: ReadyData; busy: boolean }) {
  if (!data.hasDirectory) return null;
  return (
    <section className={styles.card} aria-labelledby="listing-heading">
      <h2 id="listing-heading">Store directory listing</h2>
      <DashboardForm
        signedInstance={data.signedInstance}
        intent="setListing"
        fields={{ listed: data.listed ? "false" : "true" }}
        className={styles.stack}
      >
        <p>
          {data.listed
            ? "Your store is listed, so customers and assistants can find it by name in Gooper.io's store directory."
            : "Your store is hidden from Gooper.io's store directory."}
        </p>
        <p className={styles.hint}>
          Listing publishes only your store name, website and Gooper.io return
          page. Customers still confirm their email before seeing any order.
        </p>
        <div>
          <button className={styles.button} type="submit" disabled={busy}>
            {data.listed
              ? "Hide my store from the directory"
              : "List my store in the directory"}
          </button>
        </div>
      </DashboardForm>
    </section>
  );
}

export default function WixDashboard() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header>
          <h1 className={styles.title}>Gooper.io</h1>
          <p className={styles.subtitle}>
            Returns and refunds through your customers&apos; AI assistants.
          </p>
        </header>

        {!data.ready ? (
          <>
            <Banner tone="info" heading="Finishing setup">
              Gooper.io is still connecting to your site. This usually takes a
              minute. Reload this page shortly.
            </Banner>
            <HowItWorks
              connectUrl={data.connectUrl}
              publicPageUrl={data.publicPageUrl}
            />
          </>
        ) : (
          <>
            {result &&
              (result.ok ? (
                <Banner tone="success" heading={result.notice}>
                  {result.detail}
                </Banner>
              ) : (
                <Banner tone="critical" heading={result.heading}>
                  {result.error}
                </Banner>
              ))}
            <div className={styles.layout}>
              <div className={styles.column}>
                <PolicyForm data={data} busy={busy} />
                <ReturnsList data={data} busy={busy} />
              </div>
              <div className={styles.column}>
                <HowItWorks
                  connectUrl={data.connectUrl}
                  publicPageUrl={data.publicPageUrl}
                />
                <ListingCard data={data} busy={busy} />
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message =
    isRouteErrorResponse(error) &&
    typeof error.data === "string" &&
    error.status < 500
      ? error.data
      : "Something went wrong loading Gooper.io. Reload the page to try again.";
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <h1 className={styles.title}>Gooper.io</h1>
        <Banner tone="critical" heading="This page couldn't load">
          {message}
        </Banner>
      </div>
    </main>
  );
}
