import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import {
  processApprovedReturn,
  retryApprovedReturn,
  type AdminGraphql,
} from "./automatic-return.server";

const SHOP = "retry.myshopify.com";
const ORDER = "gid://shopify/Order/1";
const RETURN = "gid://shopify/Return/2";
const LINE_ITEM = "gid://shopify/LineItem/3";
const RETURN_LINE_ITEM = "gid://shopify/ReturnLineItem/4";
const LOCATION = "gid://shopify/Location/5";
const REFUND = "gid://shopify/Refund/8";

function mockDelegate(
  t: TestContext,
  target: object,
  name: string,
  implementation: (...args: never[]) => unknown,
) {
  const original = Reflect.get(target, name);
  Reflect.set(target, name, t.mock.fn(implementation));
  t.after(() => Reflect.set(target, name, original));
}

type Handler = (variables: Record<string, unknown>) => unknown;

// Routes each Admin API call by operation name and records the order.
function fakeShopify(handlers: Record<string, Handler>) {
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = [];
  const admin: AdminGraphql = {
    async graphql(query, options) {
      const name = Object.keys(handlers).find((key) => query.includes(key));
      if (!name) throw new Error(`Unexpected Shopify operation: ${query}`);
      const variables = options?.variables ?? {};
      calls.push({ name, variables });
      return Response.json({ data: handlers[name](variables) });
    },
  };
  return { admin, calls, names: () => calls.map((call) => call.name) };
}

const details = () => ({
  return: {
    order: { fulfillments: [{ location: { id: LOCATION } }] },
    returnLineItems: {
      nodes: [
        {
          id: RETURN_LINE_ITEM,
          quantity: 1,
          fulfillmentLineItem: { lineItem: { id: LINE_ITEM } },
        },
      ],
    },
    reverseFulfillmentOrders: {
      nodes: [
        {
          lineItems: {
            nodes: [
              {
                id: "gid://shopify/ReverseFulfillmentOrderLineItem/6",
                totalQuantity: 1,
                fulfillmentLineItem: { lineItem: { id: LINE_ITEM } },
              },
            ],
          },
        },
      ],
    },
  },
});

const outcome = (amount: string) => () => ({
  return: {
    suggestedFinancialOutcome: {
      financialTransfer: {
        amount: { presentmentMoney: { amount, currencyCode: "CAD" } },
        suggestedTransactions: [
          {
            amountSet: { presentmentMoney: { amount, currencyCode: "CAD" } },
            gateway: "shopify_payments",
            parentTransaction: {
              id: "gid://shopify/OrderTransaction/7",
              gateway: "shopify_payments",
              manualPaymentGateway: false,
            },
          },
        ],
      },
    },
  },
});

const refund = (returnId: string | null, createdAt = new Date().toISOString()) => ({
  id: REFUND,
  createdAt,
  return: returnId ? { id: returnId } : null,
  transactions: {
    nodes: [{ kind: "REFUND", status: "SUCCESS" }],
    pageInfo: { hasNextPage: false },
  },
});

const processed = () => ({
  returnProcess: { return: { id: RETURN, status: "CLOSED" }, userErrors: [] },
});

// A 14.00 item less a 10% restocking fee from the merchant's return rules.
const CONFIRMED = { amount: "12.60", currencyCode: "CAD" };

function mockRecords(t: TestContext, record: Record<string, unknown> = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const stored = {
    id: "agent-return-1",
    shop: SHOP,
    orderId: ORDER,
    returnId: RETURN,
    refundId: null,
    status: "NEEDS_ATTENTION",
    amount: CONFIRMED.amount,
    currencyCode: CONFIRMED.currencyCode,
    requestedLineItems: [{ lineItemId: LINE_ITEM, quantity: 1 }],
    createdAt: new Date(Date.now() - 60_000),
    ...record,
  };
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => ({
    returnLocationId: null,
  }));
  mockDelegate(t, prisma.agentReturn, "findFirst", async () => stored);
  mockDelegate(t, prisma.agentReturn, "updateMany", async () => ({ count: 1 }));
  mockDelegate(
    t,
    prisma.agentReturn,
    "update",
    async ({ data }: { data: Record<string, unknown> }) => {
      updates.push(data);
      return { ...stored, ...data };
    },
  );
  return updates;
}

test("processing refunds the fee-net amount, restocks, and records the refund", async (t) => {
  const updates = mockRecords(t);
  const shopify = fakeShopify({
    ReturnDetailsForProcessing: details,
    SuggestedReturnOutcome: outcome("12.60"),
    ProcessAutomaticReturn: processed,
    OrderRefundsForReturn: () => ({ order: { refunds: [refund(RETURN)] } }),
  });
  await processApprovedReturn({
    admin: shopify.admin,
    shop: SHOP,
    recordId: "agent-return-1",
    orderId: ORDER,
    returnId: RETURN,
    items: [{ lineItemId: LINE_ITEM, quantity: 1 }],
    confirmed: CONFIRMED,
  });
  const input = shopify.calls.find((call) => call.name === "ProcessAutomaticReturn")!
    .variables.input as Record<string, unknown>;
  assert.deepEqual(input.returnLineItems, [
    {
      id: RETURN_LINE_ITEM,
      quantity: 1,
      dispositions: [
        {
          reverseFulfillmentOrderLineItemId: "gid://shopify/ReverseFulfillmentOrderLineItem/6",
          quantity: 1,
          locationId: LOCATION,
          dispositionType: "RESTOCKED",
        },
      ],
    },
  ]);
  assert.deepEqual(input.financialTransfer, {
    issueRefund: {
      orderTransactions: [
        {
          parentId: "gid://shopify/OrderTransaction/7",
          transactionAmount: { amount: "12.60", currencyCode: "CAD" },
        },
      ],
    },
  });
  assert.deepEqual(updates.at(-1), {
    refundId: REFUND,
    returnStatus: "PROCESSED",
    status: "REFUND_SUBMITTED",
    refundStatus: "SUCCESS",
    failureReason: null,
  });
});

test("a refund amount that ignores return fees, or an invoice outcome, stops before returnProcess", async (t) => {
  mockRecords(t);
  for (const transfer of [outcome("14.00"), () => ({ return: { suggestedFinancialOutcome: { financialTransfer: {} } } })]) {
    const shopify = fakeShopify({
      ReturnDetailsForProcessing: details,
      SuggestedReturnOutcome: transfer,
      ProcessAutomaticReturn: processed,
    });
    await assert.rejects(
      processApprovedReturn({
        admin: shopify.admin,
        shop: SHOP,
        recordId: "agent-return-1",
        orderId: ORDER,
        returnId: RETURN,
        items: [{ lineItemId: LINE_ITEM, quantity: 1 }],
        confirmed: CONFIRMED,
      }),
      /amount changed|could not calculate/,
    );
    assert.ok(!shopify.names().includes("ProcessAutomaticReturn"));
  }
});

test("a retry records a refund Shopify already linked to the return instead of refunding again", async (t) => {
  const updates = mockRecords(t);
  const shopify = fakeShopify({
    OrderRefundsForReturn: () => ({ order: { refunds: [refund(RETURN)] } }),
  });
  await retryApprovedReturn(SHOP, "agent-return-1", shopify.admin);
  assert.deepEqual(shopify.names(), ["OrderRefundsForReturn"]);
  assert.equal(updates.at(-1)?.refundId, REFUND);
  assert.equal(updates.at(-1)?.status, "REFUND_SUBMITTED");
});

test("a retry stops on a closed return or a later refund made outside the return", async (t) => {
  const updates = mockRecords(t);
  for (const [handlers, message] of [
    [
      {
        OrderRefundsForReturn: () => ({ order: { refunds: [] } }),
        ReturnStatusForRetry: () => ({ return: { status: "CLOSED", order: { id: ORDER } } }),
      },
      /shows this return as closed/,
    ],
    [
      { OrderRefundsForReturn: () => ({ order: { refunds: [refund(null)] } }) },
      /refunded in Shopify after the customer's request/,
    ],
  ] as const) {
    const shopify = fakeShopify(handlers);
    await assert.rejects(retryApprovedReturn(SHOP, "agent-return-1", shopify.admin), message);
    assert.ok(!shopify.names().includes("ProcessAutomaticReturn"));
    assert.ok(!shopify.names().includes("ApproveReturnRequest"));
    assert.equal(updates.at(-1)?.status, "NEEDS_ATTENTION");
  }
});

test("a retry approves a still-requested return, then processes it", async (t) => {
  mockRecords(t);
  const shopify = fakeShopify({
    OrderRefundsForReturn: (() => {
      let lookups = 0;
      return () => ({ order: { refunds: lookups++ ? [refund(RETURN)] : [] } });
    })(),
    ReturnStatusForRetry: () => ({ return: { status: "REQUESTED", order: { id: ORDER } } }),
    ApproveReturnRequest: () => ({
      returnApproveRequest: {
        return: { id: RETURN, status: "OPEN", order: { id: ORDER } },
        userErrors: [],
      },
    }),
    ReturnDetailsForProcessing: details,
    SuggestedReturnOutcome: outcome("12.60"),
    ProcessAutomaticReturn: processed,
  });
  await retryApprovedReturn(SHOP, "agent-return-1", shopify.admin);
  assert.deepEqual(shopify.names(), [
    "OrderRefundsForReturn",
    "ReturnStatusForRetry",
    "ApproveReturnRequest",
    "ReturnDetailsForProcessing",
    "SuggestedReturnOutcome",
    "ProcessAutomaticReturn",
    "OrderRefundsForReturn",
  ]);
});

test("only unrefunded returns needing attention can be retried, once at a time", async (t) => {
  const shopify = fakeShopify({});
  for (const record of [{ refundId: REFUND }, { status: "REFUND_SUBMITTED" }, { returnId: null }]) {
    mockRecords(t, record);
    await assert.rejects(
      retryApprovedReturn(SHOP, "agent-return-1", shopify.admin),
      /Only a return that needs attention/,
    );
  }
  mockRecords(t);
  mockDelegate(t, prisma.agentReturn, "updateMany", async () => ({ count: 0 }));
  await assert.rejects(
    retryApprovedReturn(SHOP, "agent-return-1", shopify.admin),
    /already being retried/,
  );
  assert.deepEqual(shopify.names(), []);
});
