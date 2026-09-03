import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

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
    orders: {
      nodes: DashboardOrder[];
    };
  };
  errors?: Array<{ message: string }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("query")?.trim() ?? "";

  const response = await admin.graphql(
    `#graphql
      query RefundDashboardOrders($first: Int!, $query: String) {
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

  return {
    orders: responseJson.data.orders.nodes,
    query,
  };
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
  const { orders, query } = useLoaderData<typeof loader>();
  const [search, setSearch] = useState(query);
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

      <s-section heading="Recent orders" padding="none">
        <s-box padding="base">
          <form method="get">
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

      <s-section slot="aside" heading="About this view">
        <s-paragraph color="subdued">
          This dashboard shows the 25 most recent matching orders. Opening an
          order takes you to Shopify Admin, where the merchant can review and
          issue the refund using Shopify&apos;s existing safeguards.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
