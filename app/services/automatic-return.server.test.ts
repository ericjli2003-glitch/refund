import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import {
  canRemoveReturn,
  executeAutomaticReturn,
  processApprovedReturn,
  receiveReturnedItems,
  removeUnsubmittedReturn,
  retryApprovedReturn,
  type AdminGraphql,
  wantsRestock,
} from "./automatic-return.server";
import { customerIdentityHash } from "./customer-security.server";

const SHOP = "retry.myshopify.com";
const ORDER = "gid://shopify/Order/1";
const RETURN = "gid://shopify/Return/2";
const LINE_ITEM = "gid://shopify/LineItem/3";
const RETURN_LINE_ITEM = "gid://shopify/ReturnLineItem/4";
const LOCATION = "gid://shopify/Location/5";
const REVERSE_LINE_ITEM = "gid://shopify/ReverseFulfillmentOrderLineItem/6";
const REFUND = "gid://shopify/Refund/8";
const REASON = "gid://shopify/ReturnReasonDefinition/9";

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

// Units Gooper funded on this order; empty unless a test says otherwise.
function mockFunded(
  t: TestContext,
  funded: Array<{ lineItemId: string; quantity: number; shopifyReturnId: string | null }>,
) {
  mockDelegate(t, prisma.fundedEntitlement, "findMany", async () => funded);
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
  return {
    admin,
    variables: (name: string) => calls.find((call) => call.name === name)!.variables,
    names: () => calls.map((call) => call.name),
  };
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
                id: REVERSE_LINE_ITEM,
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

// The first lookup finds nothing; later ones find the refund returnProcess made.
const refundsAfterProcessing = () => {
  let lookups = 0;
  return () => ({ order: { refunds: lookups++ ? [refund(RETURN)] : [] } });
};

const processed = () => ({
  returnProcess: { return: { id: RETURN, status: "CLOSED" }, userErrors: [] },
});
// returnProcess's response for any other outcome. An immediate refund carries
// no dispositions, so Shopify leaves the return OPEN until the item is received.
const processedAs = (value: string, id = RETURN) => () => ({
  returnProcess: { return: { id, status: value }, userErrors: [] },
});
const status = (value: string) => () => ({
  return: { status: value, order: { id: ORDER } },
});

const RESTOCKED = {
  reverseFulfillmentOrderLineItemId: REVERSE_LINE_ITEM,
  quantity: 1,
  locationId: LOCATION,
  dispositionType: "RESTOCKED",
};

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
    refundTiming: null,
    itemReceivedAt: null,
    amount: CONFIRMED.amount,
    currencyCode: CONFIRMED.currencyCode,
    requestedLineItems: [{ lineItemId: LINE_ITEM, quantity: 1 }],
    createdAt: new Date(Date.now() - 60_000),
    ...record,
  };
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => ({
    returnLocationId: null,
  }));
  mockFunded(t, []);
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

const approvedReturn = (admin: AdminGraphql, dispose: boolean) =>
  processApprovedReturn({
    admin,
    shop: SHOP,
    recordId: "agent-return-1",
    orderId: ORDER,
    returnId: RETURN,
    items: [{ lineItemId: LINE_ITEM, quantity: 1 }],
    confirmed: CONFIRMED,
    dispose,
  });

test("processing refunds the fee-net amount, restocks returned items, and records the refund", async (t) => {
  const updates = mockRecords(t);
  const shopify = fakeShopify({
    ReturnDetailsForProcessing: details,
    SuggestedReturnOutcome: outcome("12.60"),
    ProcessAutomaticReturn: processed,
    OrderRefundsForReturn: () => ({ order: { refunds: [refund(RETURN)] } }),
  });
  await approvedReturn(shopify.admin, true);
  const input = shopify.variables("ProcessAutomaticReturn").input as Record<string, unknown>;
  assert.deepEqual(input.returnLineItems, [
    { id: RETURN_LINE_ITEM, quantity: 1, dispositions: [RESTOCKED] },
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

test("an immediate refund disposes nothing and records the refund while the return stays open", async (t) => {
  const updates = mockRecords(t);
  const shopify = fakeShopify({
    ReturnDetailsForProcessing: details,
    SuggestedReturnOutcome: outcome("12.60"),
    // What Shopify returns for a refund with no dispositions: still open.
    ProcessAutomaticReturn: processedAs("OPEN"),
    OrderRefundsForReturn: () => ({ order: { refunds: [refund(RETURN)] } }),
  });
  await approvedReturn(shopify.admin, false);
  const input = shopify.variables("ProcessAutomaticReturn").input as Record<string, unknown>;
  assert.deepEqual(input.returnLineItems, [
    { id: RETURN_LINE_ITEM, quantity: 1, dispositions: [] },
  ]);
  // The refund succeeded, so it is recorded, not flagged for attention.
  assert.deepEqual(updates.at(-1), {
    refundId: REFUND,
    returnStatus: "PROCESSED",
    status: "REFUND_SUBMITTED",
    refundStatus: "SUCCESS",
    failureReason: null,
  });
});

test("a refund on receipt still requires Shopify to close the return", async (t) => {
  const updates = mockRecords(t);
  const shopify = fakeShopify({
    ReturnDetailsForProcessing: details,
    SuggestedReturnOutcome: outcome("12.60"),
    // Disposing in the same call should close the return; OPEN means it didn't.
    ProcessAutomaticReturn: processedAs("OPEN"),
    OrderRefundsForReturn: () => ({ order: { refunds: [refund(RETURN)] } }),
  });
  await assert.rejects(
    approvedReturn(shopify.admin, true),
    /Shopify did not confirm that this return was processed/,
  );
  assert.equal(shopify.names().includes("OrderRefundsForReturn"), false);
  assert.equal(updates.some((update) => "refundId" in update), false);
});

test("an immediate refund still rejects a response for a different return", async (t) => {
  const updates = mockRecords(t);
  const shopify = fakeShopify({
    ReturnDetailsForProcessing: details,
    SuggestedReturnOutcome: outcome("12.60"),
    ProcessAutomaticReturn: processedAs("OPEN", "gid://shopify/Return/999"),
    OrderRefundsForReturn: () => ({ order: { refunds: [refund(RETURN)] } }),
  });
  await assert.rejects(
    approvedReturn(shopify.admin, false),
    /Shopify did not confirm that this return was processed/,
  );
  assert.equal(shopify.names().includes("OrderRefundsForReturn"), false);
  assert.equal(updates.some((update) => "refundId" in update), false);
});

test("a refund amount that ignores return fees, or an invoice outcome, stops before returnProcess", async (t) => {
  mockRecords(t);
  for (const transfer of [outcome("14.00"), () => ({ return: { suggestedFinancialOutcome: { financialTransfer: {} } } })]) {
    const shopify = fakeShopify({
      ReturnDetailsForProcessing: details,
      SuggestedReturnOutcome: transfer,
      ProcessAutomaticReturn: processed,
    });
    await assert.rejects(approvedReturn(shopify.admin, false), /amount changed|could not calculate/);
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
      { OrderRefundsForReturn: () => ({ order: { refunds: [] } }), ReturnStatusForRetry: status("CLOSED") },
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
    OrderRefundsForReturn: refundsAfterProcessing(),
    ReturnStatusForRetry: status("REQUESTED"),
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

test("a retried on-receipt return goes back to waiting for its item instead of refunding", async (t) => {
  const updates = mockRecords(t, { refundTiming: "ON_RECEIPT" });
  const shopify = fakeShopify({
    OrderRefundsForReturn: () => ({ order: { refunds: [] } }),
    ReturnStatusForRetry: status("OPEN"),
  });
  await retryApprovedReturn(SHOP, "agent-return-1", shopify.admin);
  assert.ok(!shopify.names().includes("ProcessAutomaticReturn"));
  assert.deepEqual(updates.at(-1), {
    status: "AWAITING_ITEM",
    returnStatus: "OPEN",
    failureReason: null,
  });
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

test("receiving an immediately refunded return restocks it without touching the refund", async (t) => {
  const updates = mockRecords(t, {
    status: "REFUND_SUBMITTED",
    refundTiming: "IMMEDIATE",
    refundId: REFUND,
  });
  const shopify = fakeShopify({
    ReturnDetailsForProcessing: details,
    ReceiveReturnedItems: () => ({
      reverseFulfillmentOrderDispose: {
        reverseFulfillmentOrderLineItems: [{ id: REVERSE_LINE_ITEM }],
        userErrors: [],
      },
    }),
  });
  await receiveReturnedItems(SHOP, "agent-return-1", shopify.admin);
  assert.deepEqual(shopify.names(), ["ReturnDetailsForProcessing", "ReceiveReturnedItems"]);
  assert.deepEqual(shopify.variables("ReceiveReturnedItems").dispositionInputs, [RESTOCKED]);
  assert.deepEqual(updates.at(-1), { failureReason: null });
});

test("an item can be marked received without going back into sellable stock", async (t) => {
  const updates = mockRecords(t, {
    status: "REFUND_SUBMITTED",
    refundTiming: "IMMEDIATE",
    refundId: REFUND,
  });
  const shopify = fakeShopify({
    ReturnDetailsForProcessing: details,
    ReceiveReturnedItems: () => ({
      reverseFulfillmentOrderDispose: {
        reverseFulfillmentOrderLineItems: [{ id: REVERSE_LINE_ITEM }],
        userErrors: [],
      },
    }),
  });
  await receiveReturnedItems(SHOP, "agent-return-1", shopify.admin, false);

  // Shopify still records the item as back, but not as sellable, and no
  // restock location is sent.
  // No location is sent at all: a location only means something for stock
  // going back on the shelf.
  assert.deepEqual(shopify.variables("ReceiveReturnedItems").dispositionInputs, [
    {
      reverseFulfillmentOrderLineItemId: REVERSE_LINE_ITEM,
      quantity: 1,
      dispositionType: "NOT_RESTOCKED",
    },
  ]);
  assert.deepEqual(updates.at(-1), { failureReason: null });
});

test("receiving an on-receipt return rechecks Shopify, then refunds and restocks in one call", async (t) => {
  const updates = mockRecords(t, { status: "AWAITING_ITEM", refundTiming: "ON_RECEIPT" });
  const shopify = fakeShopify({
    OrderRefundsForReturn: refundsAfterProcessing(),
    ReturnStatusForRetry: status("OPEN"),
    ReturnDetailsForProcessing: details,
    SuggestedReturnOutcome: outcome("12.60"),
    ProcessAutomaticReturn: processed,
  });
  await receiveReturnedItems(SHOP, "agent-return-1", shopify.admin);
  assert.ok(!shopify.names().includes("ApproveReturnRequest"));
  const input = shopify.variables("ProcessAutomaticReturn").input as Record<string, unknown>;
  assert.deepEqual(input.returnLineItems, [
    { id: RETURN_LINE_ITEM, quantity: 1, dispositions: [RESTOCKED] },
  ]);
  assert.equal(updates.at(-1)?.status, "REFUND_SUBMITTED");
  assert.equal(updates.at(-1)?.refundId, REFUND);
});

test("a failed receipt puts the return back to waiting for its item", async (t) => {
  const updates = mockRecords(t, { status: "AWAITING_ITEM", refundTiming: "ON_RECEIPT" });
  const shopify = fakeShopify({
    OrderRefundsForReturn: () => ({ order: { refunds: [] } }),
    ReturnStatusForRetry: status("CLOSED"),
  });
  await assert.rejects(
    receiveReturnedItems(SHOP, "agent-return-1", shopify.admin),
    /shows this return as closed/,
  );
  assert.ok(!shopify.names().includes("ProcessAutomaticReturn"));
  assert.equal(updates.at(-1)?.itemReceivedAt, null);
  assert.equal(updates.at(-1)?.status, "AWAITING_ITEM");
  assert.match(String(updates.at(-1)?.failureReason), /closed/);
});

test("only approved returns not yet received can be marked received, once at a time", async (t) => {
  const shopify = fakeShopify({});
  for (const record of [
    { status: "REFUND_SUBMITTED", refundTiming: null },
    { status: "REFUND_SUBMITTED", refundTiming: "IMMEDIATE", itemReceivedAt: new Date() },
    { status: "REFUND_SUBMITTED", refundTiming: "ON_RECEIPT" },
    { status: "AWAITING_ITEM", refundTiming: "IMMEDIATE" },
  ]) {
    mockRecords(t, record);
    await assert.rejects(
      receiveReturnedItems(SHOP, "agent-return-1", shopify.admin),
      /Only an approved return/,
    );
  }
  mockRecords(t, { status: "AWAITING_ITEM", refundTiming: "ON_RECEIPT" });
  mockDelegate(t, prisma.agentReturn, "updateMany", async () => ({ count: 0 }));
  await assert.rejects(
    receiveReturnedItems(SHOP, "agent-return-1", shopify.admin),
    /already being marked received/,
  );
  assert.deepEqual(shopify.names(), []);
});

test("a request Shopify refuses outright is not submitted, and the same confirmation can try again", async (t) => {
  process.env.SHOPIFY_API_SECRET ||= "test-secret";
  const shop = "refused.myshopify.com";
  const customerId = "gid://shopify/Customer/1";
  const items = [{ lineItemId: LINE_ITEM, quantity: 1 }];
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => ({
    automaticRefundsEnabled: true,
    returnWindowDays: 30,
    currencyCode: "CAD",
    maxAutoRefundAmount: "100.00",
    refundTiming: "IMMEDIATE",
  }));
  mockFunded(t, []);
  let existing: Record<string, unknown> | null = null;
  mockDelegate(t, prisma.agentReturn, "findUnique", async () => existing);
  const created: Array<Record<string, unknown>> = [];
  mockDelegate(
    t,
    prisma.agentReturn,
    "create",
    async ({ data }: { data: Record<string, unknown> }) => {
      created.push(data);
      return { id: "agent-return-1", ...data };
    },
  );
  const claims: Array<{ where: Record<string, unknown> }> = [];
  mockDelegate(t, prisma.agentReturn, "updateMany", async (args: never) => {
    claims.push(args);
    return { count: 1 };
  });
  const updates: Array<Record<string, unknown>> = [];
  mockDelegate(
    t,
    prisma.agentReturn,
    "update",
    async ({ data }: { data: Record<string, unknown> }) => {
      updates.push(data);
      return data;
    },
  );
  const requested: Array<{ requestedLineItems: Array<Record<string, unknown>> }> = [];
  let request = () =>
    Response.json({
      data: null,
      errors: [
        {
          message:
            "Access denied for orderRequestReturn field. Required access: `customer_write_customers` access scope.",
          extensions: { code: "ACCESS_DENIED" },
        },
      ],
    });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (!init?.body)
      return Response.json({
        graphql_api: "https://shopify.com/1/customer/api/2026-07/graphql",
      });
    const { query, variables } = JSON.parse(String(init.body));
    if (query.includes("RequestCustomerReturn")) requested.push(variables);
    if (query.includes("CustomerReturnableOrders"))
      return Response.json({
        data: {
          customer: {
            id: customerId,
            orders: {
              nodes: [
                {
                  id: ORDER,
                  name: "#1001",
                  processedAt: new Date().toISOString(),
                  returnInformation: {
                    nonReturnableSummary: null,
                    returnableLineItems: {
                      nodes: [{ lineItem: { id: LINE_ITEM }, quantity: 1 }],
                    },
                  },
                },
              ],
            },
          },
        },
      });
    if (query.includes("CalculateCustomerReturn"))
      return Response.json({
        data: {
          returnCalculate: {
            financialSummary: {
              returnTotalSet: {
                presentmentMoney: { amount: "-14.00", currencyCode: "CAD" },
                shopMoney: { amount: "-14.00", currencyCode: "CAD" },
              },
            },
            returnLineItems: { nodes: [] },
          },
        },
      });
    if (query.includes("RequestCustomerReturn")) return request();
    throw new Error(`Unexpected request: ${query}`);
  });
  const submit = () =>
    executeAutomaticReturn({
      shop,
      customerToken: "customer-token",
      orderId: ORDER,
      items,
      idempotencyKey: "quote-1",
      expectedRefund: { amount: "14.00", currencyCode: "CAD" },
      refundTiming: "IMMEDIATE",
      lookupReturnReason: async () => REASON,
    });

  await assert.rejects(submit(), /Nothing was submitted.*customer_write_customers/);
  // Shopify requires a return reason; the customer is never asked for one.
  assert.equal(requested[0].requestedLineItems[0].returnReasonDefinitionId, REASON);
  assert.equal(created.length, 1);
  assert.equal(updates.at(-1)?.status, "NOT_SUBMITTED");
  assert.match(String(updates.at(-1)?.failureReason), /customer_write_customers/);

  // The same confirmation tries again on that record instead of a new one.
  existing = {
    id: "agent-return-1",
    shop,
    orderId: ORDER,
    requestedLineItems: items,
    customerSubjectHash: customerIdentityHash(customerId),
    status: "NOT_SUBMITTED",
  };
  request = () =>
    Response.json({
      data: {
        orderRequestReturn: {
          return: null,
          userErrors: [{ message: "Item was already returned" }],
        },
      },
    });
  await assert.rejects(submit(), /Nothing was submitted.*already returned/);
  assert.equal(created.length, 1);
  assert.deepEqual(claims.at(-1)?.where, {
    id: "agent-return-1",
    shop,
    status: "NOT_SUBMITTED",
  });
  assert.equal(updates.at(-1)?.status, "NOT_SUBMITTED");

  // A request that fails without a clear answer may have created a return.
  request = () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(submit(), /fetch failed/);
  assert.equal(updates.at(-1)?.status, "NEEDS_ATTENTION");

  // Any other earlier attempt stands as it is and is never sent again.
  existing = { ...existing, status: "NEEDS_ATTENTION" };
  let sent = false;
  request = () => {
    sent = true;
    return Response.json({});
  };
  assert.equal((await submit()).status, "NEEDS_ATTENTION");
  assert.equal(sent, false);
});

test("only a request Shopify never created a return for can be removed", async (t) => {
  const none = { returnId: null, refundId: null };
  assert.equal(canRemoveReturn({ status: "NOT_SUBMITTED", ...none }), true);
  assert.equal(canRemoveReturn({ status: "NEEDS_ATTENTION", ...none }), true);
  assert.equal(canRemoveReturn({ status: "NEEDS_ATTENTION", ...none, returnId: RETURN }), false);
  assert.equal(canRemoveReturn({ status: "NEEDS_ATTENTION", ...none, refundId: REFUND }), false);
  assert.equal(canRemoveReturn({ status: "IN_PROGRESS", ...none }), false);
  const deletes: unknown[] = [];
  let count = 1;
  mockDelegate(t, prisma.agentReturn, "deleteMany", async (args: never) => {
    deletes.push(args);
    return { count };
  });
  await removeUnsubmittedReturn(SHOP, "agent-return-1");
  assert.deepEqual(deletes[0], {
    where: {
      id: "agent-return-1",
      shop: SHOP,
      status: { in: ["NOT_SUBMITTED", "NEEDS_ATTENTION"] },
      returnId: null,
      refundId: null,
    },
  });
  count = 0;
  await assert.rejects(removeUnsubmittedReturn(SHOP, "agent-return-1"), /never created a return/);
});

test("a return Gooper funded is never refunded to the original payment method", async (t) => {
  mockRecords(t);
  mockFunded(t, [{ lineItemId: LINE_ITEM, quantity: 1, shopifyReturnId: RETURN }]);
  const shopify = fakeShopify({
    ReturnDetailsForProcessing: details,
    SuggestedReturnOutcome: outcome("12.60"),
    ProcessAutomaticReturn: processed,
  });
  await assert.rejects(approvedReturn(shopify.admin, false), /Gooper funded this return.*No refund was issued/);
  assert.deepEqual(shopify.names(), [], "Stopped before any Shopify call");
});

test("funded units not yet in a Shopify return block a refund of that line item", async (t) => {
  mockRecords(t);
  mockFunded(t, [{ lineItemId: LINE_ITEM, quantity: 1, shopifyReturnId: null }]);
  const shopify = fakeShopify({ ProcessAutomaticReturn: processed });
  await assert.rejects(approvedReturn(shopify.admin, true), /already funded some of these items/);
  assert.deepEqual(shopify.names(), []);
});

test("funded units on another line item or return don't block this refund", async (t) => {
  mockRecords(t);
  mockFunded(t, [
    { lineItemId: "gid://shopify/LineItem/99", quantity: 1, shopifyReturnId: null },
    { lineItemId: LINE_ITEM, quantity: 1, shopifyReturnId: "gid://shopify/Return/77" },
  ]);
  const shopify = fakeShopify({
    ReturnDetailsForProcessing: details,
    SuggestedReturnOutcome: outcome("12.60"),
    ProcessAutomaticReturn: processed,
    OrderRefundsForReturn: () => ({ order: { refunds: [refund(RETURN)] } }),
  });
  await approvedReturn(shopify.admin, false);
  assert.ok(shopify.names().includes("ProcessAutomaticReturn"));
});

test("a customer can't request a return of units Gooper already funded", async (t) => {
  process.env.SHOPIFY_API_SECRET ||= "test-secret";
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => ({
    automaticRefundsEnabled: true,
    returnWindowDays: 30,
    currencyCode: "CAD",
    maxAutoRefundAmount: "100.00",
    refundTiming: "IMMEDIATE",
  }));
  mockDelegate(t, prisma.agentReturn, "findUnique", async () => null);
  let created = 0;
  mockDelegate(t, prisma.agentReturn, "create", async () => {
    created++;
    return {};
  });
  // Two units are returnable in Shopify, but one is funded and not yet in a return.
  mockFunded(t, [{ lineItemId: LINE_ITEM, quantity: 1, shopifyReturnId: null }]);
  const queries: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (!init?.body)
      return Response.json({
        graphql_api: "https://shopify.com/1/customer/api/2026-07/graphql",
      });
    const { query } = JSON.parse(String(init.body));
    queries.push(query);
    if (query.includes("CustomerReturnableOrders"))
      return Response.json({
        data: {
          customer: {
            id: "gid://shopify/Customer/1",
            orders: {
              nodes: [
                {
                  id: ORDER,
                  name: "#1001",
                  processedAt: new Date().toISOString(),
                  returnInformation: {
                    nonReturnableSummary: null,
                    returnableLineItems: {
                      nodes: [{ lineItem: { id: LINE_ITEM }, quantity: 2 }],
                    },
                  },
                },
              ],
            },
          },
        },
      });
    throw new Error(`Unexpected request: ${query}`);
  });
  const submit = (quantity: number) =>
    executeAutomaticReturn({
      shop: "funded.myshopify.com",
      customerToken: "customer-token",
      orderId: ORDER,
      items: [{ lineItemId: LINE_ITEM, quantity }],
      idempotencyKey: `quote-${quantity}`,
      expectedRefund: { amount: "14.00", currencyCode: "CAD" },
      refundTiming: "IMMEDIATE",
      lookupReturnReason: async () => REASON,
    });
  await assert.rejects(submit(2), /already funded/);
  assert.equal(created, 0, "No return record was created");
  assert.ok(
    !queries.some((query) => /Calculate|RequestCustomerReturn/.test(query)),
    "Shopify was never asked to calculate or create the return",
  );
  // The other, unfunded unit is still returnable the ordinary way: the funded
  // check passes and the return proceeds to Shopify's calculation.
  await assert.rejects(submit(1), /Unexpected request.*CalculateCustomerReturn/s);
});

test("the dashboard's two received buttons map to restocking or not", () => {
  // "Mark received and restock" sends no field at all.
  assert.equal(wantsRestock(null), true);
  assert.equal(wantsRestock(undefined), true);
  assert.equal(wantsRestock("true"), true);
  // "Mark received" is the only thing that stops an item going back on sale.
  assert.equal(wantsRestock("false"), false);
  // Anything unexpected restocks, which is what the single button used to do.
  assert.equal(wantsRestock(""), true);
  assert.equal(wantsRestock("False"), true);
});
