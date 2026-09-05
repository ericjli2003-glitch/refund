import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const DASHBOARD_ORDER_LIMIT = 25;

type Money = {
  amount: string;
  currencyCode: string;
};

type DashboardOrder = {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  currentTotalPriceSet: { shopMoney: Money };
  totalRefundedSet: { shopMoney: Money };
};

type OrdersQueryResponse = {
  data?: {
    shop: { currencyCode: string };
    orders: {
      nodes: DashboardOrder[];
    };
  };
  errors?: Array<{ message: string }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("query")?.trim() ?? "";

  const response = await admin.graphql(
    `#graphql
      query RefundDashboardOrders($first: Int!, $query: String) {
        shop { currencyCode }
        orders(first: $first, sortKey: CREATED_AT, reverse: true, query: $query) {
          nodes {
            id
            legacyResourceId
            name
            createdAt
            displayFinancialStatus
            currentTotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            totalRefundedSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
      }`,
    {
      variables: {
        first: DASHBOARD_ORDER_LIMIT,
        query: query || null,
      },
    },
  );

  const responseJson = (await response.json()) as OrdersQueryResponse;
  if (!responseJson.data || responseJson.errors?.length) {
    const message =
      responseJson.errors?.map((error) => error.message).join(", ") ||
      "Shopify did not return order data.";
    throw new Response(message, { status: 502 });
  }

  const [storedPolicy, agentReturns, privacyRequests] = await Promise.all([
    prisma.storePolicy.findUnique({ where: { shop: session.shop } }),
    prisma.agentReturn.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.privacyRequest.findMany({
      where: { shop: session.shop, status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 10,
    }),
  ]);

  return {
    orders: responseJson.data.orders.nodes,
    query,
    saved: url.searchParams.get("saved") === "true",
    privacyResolved: url.searchParams.get("privacyResolved") === "true",
    siteToolsActivationUrl: new URL(
      `/admin/themes/current/editor?context=apps&template=index&activateAppId=${encodeURIComponent(
        process.env.SHOPIFY_API_KEY ?? "",
      )}/refund-site-tools`,
      `https://${session.shop}`,
    ).toString(),
    policy: storedPolicy ?? {
      automaticRefundsEnabled: false,
      returnWindowDays: 30,
      maxAutoRefundAmount: "100.00",
      currencyCode: responseJson.data.shop.currencyCode,
    },
    agentReturns,
    privacyRequests,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "resolvePrivacyRequest") {
    const requestId = formData.get("requestId");
    if (typeof requestId !== "string" || !requestId) {
      throw new Response("Privacy request ID is required.", { status: 400 });
    }
    await prisma.privacyRequest.updateMany({
      where: { id: requestId, shop: session.shop, status: "PENDING" },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    return redirect("/app?privacyResolved=true");
  }

  const returnWindowDays = Number(formData.get("returnWindowDays"));
  const maxAutoRefundAmount = Number(formData.get("maxAutoRefundAmount"));

  if (
    !Number.isInteger(returnWindowDays) ||
    returnWindowDays < 1 ||
    returnWindowDays > 365 ||
    !Number.isFinite(maxAutoRefundAmount) ||
    maxAutoRefundAmount <= 0 ||
    maxAutoRefundAmount > 100_000
  ) {
    throw new Response("Invalid automatic return policy.", { status: 400 });
  }

  const shopResponse = await admin.graphql(`#graphql
    query AutomaticRefundCurrency {
      shop { currencyCode }
    }
  `);
  const shopResult = (await shopResponse.json()) as {
    data?: { shop: { currencyCode: string } };
  };
  const currencyCode = shopResult.data?.shop.currencyCode;
  if (!currencyCode) {
    throw new Response("Could not determine the store currency.", {
      status: 502,
    });
  }

  await prisma.storePolicy.upsert({
    where: { shop: session.shop },
    create: {
      shop: session.shop,
      automaticRefundsEnabled:
        formData.get("automaticRefundsEnabled") === "true",
      returnWindowDays,
      maxAutoRefundAmount: maxAutoRefundAmount.toFixed(2),
      currencyCode,
    },
    update: {
      automaticRefundsEnabled:
        formData.get("automaticRefundsEnabled") === "true",
      returnWindowDays,
      maxAutoRefundAmount: maxAutoRefundAmount.toFixed(2),
      currencyCode,
    },
  });

  return redirect("/app?saved=true");
};

function formatMoney(money: Money) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: money.currencyCode,
  }).format(Number(money.amount));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(value));
}

function formatStatus(status: string | null) {
  if (!status) return "Unknown";

  return status
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function statusTone(status: string | null) {
  switch (status) {
    case "PAID":
      return "success" as const;
    case "PARTIALLY_REFUNDED":
      return "caution" as const;
    case "REFUNDED":
      return "info" as const;
    case "PENDING":
    case "AUTHORIZED":
    case "PARTIALLY_PAID":
      return "warning" as const;
    case "EXPIRED":
    case "VOIDED":
      return "critical" as const;
    default:
      return "auto" as const;
  }
}

export default function RefundDashboard() {
  const {
    orders,
    query,
    saved,
    privacyResolved,
    policy,
    siteToolsActivationUrl,
    agentReturns,
    privacyRequests,
  } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const [search, setSearch] = useState(query);
  const [automaticRefundsEnabled, setAutomaticRefundsEnabled] = useState(
    policy.automaticRefundsEnabled,
  );
  const [returnWindowDays, setReturnWindowDays] = useState(
    String(policy.returnWindowDays),
  );
  const [maxAutoRefundAmount, setMaxAutoRefundAmount] = useState(
    policy.maxAutoRefundAmount,
  );
  const refundedOrders = orders.filter(
    (order) => Number(order.totalRefundedSet.shopMoney.amount) > 0,
  ).length;

  return (
    <s-page heading="Refunds" inlineSize="large">
      <s-button slot="primary-action" href="shopify:admin/orders">
        View all orders
      </s-button>

      <s-section>
        <s-grid
          gridTemplateColumns="@container (inline-size <= 600px) 1fr, 1fr auto 1fr"
          gap="base"
        >
          <s-box padding="small-400">
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">Orders shown</s-text>
              <s-heading>{orders.length}</s-heading>
            </s-stack>
          </s-box>
          <s-divider direction="block" />
          <s-box padding="small-400">
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">With refunds</s-text>
              <s-heading>{refundedOrders}</s-heading>
            </s-stack>
          </s-box>
        </s-grid>
      </s-section>

      {saved && (
        <s-banner heading="Automatic return policy saved" tone="success">
          Customers can use the policy immediately after authenticating with
          their Shopify customer account.
        </s-banner>
      )}

      {privacyResolved && (
        <s-banner heading="Privacy request completed" tone="success">
          The request has been removed from the pending queue.
        </s-banner>
      )}

      {privacyRequests.length > 0 && (
        <s-section heading="Pending privacy requests">
          <s-stack direction="block" gap="base">
            <s-banner heading="Customer data export required" tone="warning">
              Download each verified customer export, deliver it through your
              compliance process, then mark the request completed.
            </s-banner>
            {privacyRequests.map((privacyRequest) => (
              <s-stack
                key={privacyRequest.id}
                direction="inline"
                gap="base"
                alignItems="center"
              >
                <s-link href={`/app/privacy/${privacyRequest.id}`}>
                  Download request from{" "}
                  {formatDate(privacyRequest.createdAt.toString())}
                </s-link>
                <form
                  method="post"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit(event.currentTarget);
                  }}
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="resolvePrivacyRequest"
                  />
                  <input
                    type="hidden"
                    name="requestId"
                    value={privacyRequest.id}
                  />
                  <s-button type="submit" variant="secondary">
                    Mark completed
                  </s-button>
                </form>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section heading="Customer-agent automation">
        <form
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData();
            formData.set(
              "automaticRefundsEnabled",
              automaticRefundsEnabled ? "true" : "false",
            );
            formData.set("returnWindowDays", returnWindowDays);
            formData.set("maxAutoRefundAmount", maxAutoRefundAmount);
            submit(formData, { method: "post" });
          }}
        >
          <s-stack direction="block" gap="base">
            <s-switch
              label="Allow eligible customer-confirmed returns without merchant approval"
              checked={automaticRefundsEnabled}
              onChange={(event) =>
                setAutomaticRefundsEnabled(event.currentTarget.checked)
              }
            ></s-switch>
            <s-paragraph color="subdued">
              The customer still signs in, selects an eligible item, sees the
              calculated amount, and confirms it. Shopify then opens the return
              and sends the refund to the original payment method.
            </s-paragraph>
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))"
              gap="base"
            >
              <s-number-field
                label="Return window (days)"
                min={1}
                max={365}
                step={1}
                value={returnWindowDays}
                onChange={(event) =>
                  setReturnWindowDays(event.currentTarget.value)
                }
                required
              ></s-number-field>
              <s-money-field
                label={`Maximum automatic refund (${policy.currencyCode})`}
                min={0.01}
                max={100000}
                value={maxAutoRefundAmount}
                onChange={(event) =>
                  setMaxAutoRefundAmount(event.currentTarget.value)
                }
                required
              ></s-money-field>
            </s-grid>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button type="submit" variant="primary">
                Save policy
              </s-button>
              <s-badge
                tone={policy.automaticRefundsEnabled ? "success" : "warning"}
              >
                {policy.automaticRefundsEnabled ? "Active" : "Paused"}
              </s-badge>
            </s-stack>
          </s-stack>
        </form>
      </s-section>

      <s-section heading="Storefront AI returns">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Customers install nothing. Enable Refund once in the theme, and
            compatible AI browsers can discover return help when they visit
            this storefront. Customers still sign in and explicitly confirm
            before a refund is submitted.
          </s-paragraph>
          <s-box>
            <s-button href={siteToolsActivationUrl} variant="primary">
              Enable storefront AI tools
            </s-button>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Recent orders" padding="none">
        <s-box padding="base">
          <form
            method="get"
            onSubmit={(event) => {
              event.preventDefault();
              submit(event.currentTarget);
            }}
          >
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
              <s-search-field
                label="Search orders"
                labelAccessibilityVisibility="exclusive"
                name="query"
                placeholder="Order number or Shopify search query"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              ></s-search-field>
              <s-button type="submit" variant="primary">
                Search
              </s-button>
            </s-grid>
          </form>
        </s-box>

        {orders.length === 0 ? (
          <s-box padding="large">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-heading>No orders found</s-heading>
              <s-paragraph color="subdued">
                Try another order number or clear the search to see recent
                orders.
              </s-paragraph>
              {query && <s-button href="/app">Clear search</s-button>}
            </s-stack>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header listSlot="secondary">Date</s-table-header>
              <s-table-header listSlot="labeled">Payment</s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                Total
              </s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                Refunded
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {orders.map((order) => (
                <s-table-row key={order.id}>
                  <s-table-cell>
                    <s-link
                      href={`shopify:admin/orders/${order.legacyResourceId}`}
                    >
                      {order.name}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{formatDate(order.createdAt)}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(order.displayFinancialStatus)}>
                      {formatStatus(order.displayFinancialStatus)}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {formatMoney(order.currentTotalPriceSet.shopMoney)}
                  </s-table-cell>
                  <s-table-cell>
                    {formatMoney(order.totalRefundedSet.shopMoney)}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Recent customer-agent returns" padding="none">
        {agentReturns.length === 0 ? (
          <s-box padding="large">
            <s-paragraph color="subdued">
              No customer-agent return requests have been received yet.
            </s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header listSlot="secondary">Requested</s-table-header>
              <s-table-header listSlot="labeled">Status</s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                Refund
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {agentReturns.map((agentReturn) => (
                <s-table-row key={agentReturn.id}>
                  <s-table-cell>
                    {agentReturn.orderName ?? agentReturn.orderId}
                  </s-table-cell>
                  <s-table-cell>
                    {formatDate(agentReturn.createdAt.toString())}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        agentReturn.status === "REFUND_SUBMITTED" ||
                        agentReturn.status === "REFUND_RECORDED"
                          ? "success"
                          : agentReturn.status === "NEEDS_ATTENTION"
                            ? "critical"
                            : "info"
                      }
                    >
                      {formatStatus(agentReturn.status)}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {agentReturn.amount && agentReturn.currencyCode
                      ? formatMoney({
                          amount: agentReturn.amount,
                          currencyCode: agentReturn.currencyCode,
                        })
                      : "—"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="What is automatic">
        <s-unordered-list>
          <s-list-item>Customer and order ownership verification</s-list-item>
          <s-list-item>Shopify return eligibility and amount check</s-list-item>
          <s-list-item>Return approval and refund submission</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
