import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import type { AdminGraphql } from "./shopify-admin.server";
import {
  calculateVerifiedReturn,
  noteReturnRulesDrift,
  requestVerifiedReturn,
  verifiedCustomerOrders,
  verifiedLinksAllowed,
} from "./verified-customer-returns.server";

const shop = "example.myshopify.com";
const customerId = "gid://shopify/Customer/42";
const confirmed = new Date("2026-09-01T00:00:00Z");

function mockDelegate(
  t: TestContext,
  target: object,
  name: string,
  implementation: (...args: never[]) => unknown,
) {
  const original = Reflect.get(target, name);
  const mock = t.mock.fn(implementation);
  Reflect.set(target, name, mock);
  t.after(() => Reflect.set(target, name, original));
  return mock;
}

function confirmedRules(t: TestContext) {
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => ({
    shop,
    verifiedStoreLinks: true,
    returnRulesConfirmedAt: confirmed,
    restockingFeePercent: "10",
    returnShippingFee: "5.00",
    finalSaleCollectionIds: ["gid://shopify/Collection/9"],
    currencyCode: "USD",
  }));
  mockDelegate(t, prisma.session, "findFirst", async () => ({
    scope: "read_orders,read_products,read_returns",
  }));
}

type Call = { query: string; variables: Record<string, unknown> };
function adminMock(respond: (call: Call) => unknown) {
  const calls: Call[] = [];
  const admin: AdminGraphql = {
    graphql: async (query, options) => {
      const call = { query, variables: options?.variables ?? {} };
      calls.push(call);
      return Response.json({ data: respond(call) });
    },
  };
  const find = (name: string) => calls.find((call) => call.query.includes(name))!;
  return { admin, calls, find };
}

const money = (amount: string, currencyCode = "USD") => ({ amount, currencyCode });
const bag = (amount: string) => ({
  presentmentMoney: money(amount),
  shopMoney: money(amount),
});
const fulfillmentLine = (quantity: number, id: number, lineItem: number) => ({
  quantity,
  fulfillmentLineItem: {
    id: `gid://shopify/FulfillmentLineItem/${id}`,
    lineItem: { id: `gid://shopify/LineItem/${lineItem}` },
  },
});
// Two of line item 1 shipped in separate fulfillments, and one of line item 3.
const returnable = {
  o0: {
    nodes: [
      {
        returnableFulfillmentLineItems: {
          nodes: [fulfillmentLine(1, 1, 1), fulfillmentLine(1, 3, 3)],
        },
      },
      { returnableFulfillmentLineItems: { nodes: [fulfillmentLine(1, 2, 1)] } },
    ],
  },
};

const order = {
  id: "gid://shopify/Order/1",
  name: "#1001",
  processedAt: "2026-09-01T00:00:00Z",
  returnInformation: {
    nonReturnableSummary: null,
    returnableLineItems: {
      nodes: [
        {
          quantity: 2,
          lineItem: {
            id: "gid://shopify/LineItem/1",
            presentmentTitle: "Shirt",
            currentTotalPrice: money("40.00"),
          },
        },
      ],
    },
  },
};

test("a verified customer's orders come only from their own account, without final-sale items", async (t) => {
  confirmedRules(t);
  const { admin, calls, find } = adminMock(({ query }) => {
    if (query.includes("VerifiedCustomerOrders"))
      return {
        orders: {
          nodes: [
            {
              id: order.id,
              name: order.name,
              processedAt: order.processedAt,
              customer: { id: customerId },
              lineItems: {
                nodes: [
                  {
                    id: "gid://shopify/LineItem/1",
                    title: "Shirt",
                    product: { id: "gid://shopify/Product/1" },
                    discountedTotalSet: { presentmentMoney: money("40.00") },
                  },
                  {
                    id: "gid://shopify/LineItem/3",
                    title: "Clearance hat",
                    product: { id: "gid://shopify/Product/3" },
                    discountedTotalSet: { presentmentMoney: money("10.00") },
                  },
                ],
              },
            },
            {
              id: "gid://shopify/Order/2",
              name: "#1002",
              processedAt: order.processedAt,
              customer: { id: "gid://shopify/Customer/43" },
              lineItems: { nodes: [] },
            },
          ],
        },
      };
    if (query.includes("VerifiedReturnableFulfillments")) return returnable;
    if (query.includes("FinalSaleProducts"))
      return {
        nodes: [
          { id: "gid://shopify/Product/1", c0: false },
          { id: "gid://shopify/Product/3", c0: true },
        ],
      };
    throw new Error(`Unexpected query: ${query}`);
  });
  const result = await verifiedCustomerOrders(shop, { customerId }, admin);
  assert.equal(calls[0].variables.query, "customer_id:42");
  assert.equal(calls[0].variables.withProducts, true);
  // Another customer's order is dropped even if the search returned it.
  assert.deepEqual(
    result.orders.map((entry) => entry.id),
    [order.id],
  );
  assert.deepEqual(find("VerifiedReturnableFulfillments").variables, {
    o0: order.id,
  });
  assert.deepEqual(find("FinalSaleProducts").variables, {
    ids: ["gid://shopify/Product/1", "gid://shopify/Product/3"],
    c0: "gid://shopify/Collection/9",
  });
  assert.deepEqual(result.orders[0].returnInformation, {
    ...order.returnInformation,
    nonReturnableSummary: { nonReturnableReasons: ["FINAL_SALE"] },
  });
  await assert.rejects(
    verifiedCustomerOrders(shop, { customerId: "42" }, admin),
    /invalid customer/,
  );
});

test("an email-confirmed link sees only orders placed with that email, including guest checkouts", async (t) => {
  confirmedRules(t);
  const { admin, calls } = adminMock(({ query }) => {
    if (query.includes("VerifiedCustomerOrders"))
      return {
        orders: {
          nodes: [
            {
              id: order.id,
              name: order.name,
              processedAt: order.processedAt,
              customer: null,
              email: "Pat@Example.com",
              lineItems: {
                nodes: [
                  {
                    id: "gid://shopify/LineItem/1",
                    title: "Shirt",
                    product: { id: "gid://shopify/Product/1" },
                    discountedTotalSet: { presentmentMoney: money("40.00") },
                  },
                ],
              },
            },
            {
              id: "gid://shopify/Order/2",
              name: "#1002",
              processedAt: order.processedAt,
              customer: null,
              email: "someone.else@example.com",
              lineItems: { nodes: [] },
            },
          ],
        },
      };
    if (query.includes("VerifiedReturnableFulfillments")) return returnable;
    if (query.includes("FinalSaleProducts"))
      return { nodes: [{ id: "gid://shopify/Product/1", c0: false }] };
    throw new Error(`Unexpected query: ${query}`);
  });
  const result = await verifiedCustomerOrders(shop, { email: "pat@example.com" }, admin);
  assert.equal(calls[0].variables.query, 'email:"pat@example.com"');
  assert.equal(calls[0].variables.withEmail, true);
  assert.equal(result.customerId, "email:pat@example.com");
  assert.deepEqual(
    result.orders.map((entry) => entry.id),
    [order.id],
  );
  await assert.rejects(
    verifiedCustomerOrders(shop, { email: 'pat"@example.com' }, admin),
    /invalid email/,
  );
});

test("verified quotes and return requests apply the merchant's confirmed fees across fulfillments", async (t) => {
  confirmedRules(t);
  const { admin, find } = adminMock(({ query }) => {
    if (query.includes("VerifiedReturnableFulfillments")) return returnable;
    if (query.includes("VerifiedReturnCalculation"))
      return {
        returnCalculate: {
          returnLineItems: [1, 2].map(() => ({
            quantity: 1,
            fulfillmentLineItem: { lineItem: { id: "gid://shopify/LineItem/1" } },
            subtotalSet: bag("20.00"),
            totalTaxSet: bag("2.00"),
            restockingFee: { amountSet: bag("2.00") },
          })),
          returnShippingFee: { amountSet: bag("5.00") },
        },
      };
    if (query.includes("RequestVerifiedCustomerReturn"))
      return {
        returnRequest: {
          return: { id: "gid://shopify/Return/1", status: "REQUESTED" },
          userErrors: [],
        },
      };
    throw new Error(`Unexpected query: ${query}`);
  });
  const items = [{ lineItemId: "gid://shopify/LineItem/1", quantity: 2 }];
  const lines = [1, 2].map((id) => ({
    fulfillmentLineItemId: `gid://shopify/FulfillmentLineItem/${id}`,
    quantity: 1,
    restockingFee: { percentage: 10 },
  }));
  const returnShippingFee = { amount: { amount: "5.00", currencyCode: "USD" } };

  const calculation = await calculateVerifiedReturn(shop, order, items, admin);
  assert.deepEqual(find("VerifiedReturnCalculation").variables, {
    input: { orderId: order.id, returnLineItems: lines, returnShippingFee },
  });
  // 40.00 + 4.00 tax - 4.00 restocking - 5.00 shipping, owed to the customer.
  assert.deepEqual(calculation.financialSummary, {
    returnTotalSet: {
      presentmentMoney: money("-35.00"),
      shopMoney: money("-35.00"),
    },
    restockingFeeSubtotalSet: { presentmentMoney: money("4.00") },
    returnShippingFeeSubtotalSet: { presentmentMoney: money("5.00") },
  });
  assert.deepEqual(calculation.returnLineItems.nodes, [
    { lineItem: { id: "gid://shopify/LineItem/1" }, quantity: 2 },
  ]);

  assert.equal(
    await requestVerifiedReturn(shop, order, items, "Too small", admin),
    "gid://shopify/Return/1",
  );
  assert.deepEqual(find("RequestVerifiedCustomerReturn").variables, {
    input: {
      orderId: order.id,
      returnLineItems: lines.map((line) => ({ ...line, customerNote: "Too small" })),
      returnShippingFee,
    },
  });

  await assert.rejects(
    calculateVerifiedReturn(
      shop,
      order,
      [{ lineItemId: "gid://shopify/LineItem/1", quantity: 3 }],
      admin,
    ),
    /not currently returnable/,
  );
});

test("Shopify's negative line credits quote as money back to the customer", async (t) => {
  confirmedRules(t);
  const { admin } = adminMock(({ query }) => {
    if (query.includes("VerifiedReturnableFulfillments")) return returnable;
    if (query.includes("VerifiedReturnCalculation"))
      return {
        returnCalculate: {
          returnLineItems: [
            {
              quantity: 1,
              fulfillmentLineItem: { lineItem: { id: "gid://shopify/LineItem/1" } },
              subtotalSet: bag("-20.00"),
              totalTaxSet: bag("-2.00"),
              restockingFee: null,
            },
          ],
          returnShippingFee: null,
        },
      };
    throw new Error(`Unexpected query: ${query}`);
  });
  const calculation = await calculateVerifiedReturn(
    shop,
    order,
    [{ lineItemId: "gid://shopify/LineItem/1", quantity: 1 }],
    admin,
  );
  assert.deepEqual(calculation.financialSummary, {
    returnTotalSet: { presentmentMoney: money("-22.00"), shopMoney: money("-22.00") },
  });
});

test("verified links need confirmed rules, and product access when final-sale collections are set", () => {
  const policy = {
    verifiedStoreLinks: true,
    returnRulesConfirmedAt: confirmed,
    finalSaleCollectionIds: [] as string[],
  };
  assert.equal(verifiedLinksAllowed(policy, "read_orders"), true);
  assert.equal(verifiedLinksAllowed(null, "read_products"), false);
  assert.equal(
    verifiedLinksAllowed({ ...policy, verifiedStoreLinks: false }, "read_products"),
    false,
  );
  assert.equal(
    verifiedLinksAllowed({ ...policy, returnRulesConfirmedAt: null }, "read_products"),
    false,
  );
  const finalSale = {
    ...policy,
    finalSaleCollectionIds: ["gid://shopify/Collection/9"],
  };
  assert.equal(verifiedLinksAllowed(finalSale, "read_orders,read_returns"), false);
  assert.equal(verifiedLinksAllowed(finalSale, "read_orders, read_products"), true);
});

test("a signed-in quote with fees or final sale the saved rules miss pauses verified links", async (t) => {
  const updates: Array<{
    where: unknown;
    data: { returnRulesConfirmedAt: null; returnRulesMismatch: string };
  }> = [];
  mockDelegate(t, prisma.storePolicy, "updateMany", async (args: never) => {
    updates.push(args);
    return { count: 1 };
  });
  const policy = {
    verifiedStoreLinks: true,
    returnRulesConfirmedAt: confirmed,
    restockingFeePercent: "0",
    returnShippingFee: "5.00",
    finalSaleCollectionIds: [] as string[],
    currencyCode: "USD",
  };
  const calculation = (restocking?: string, shipping?: string) => ({
    financialSummary: {
      returnTotalSet: {
        presentmentMoney: money("-30.00"),
        shopMoney: money("-30.00"),
      },
      ...(restocking
        ? { restockingFeeSubtotalSet: { presentmentMoney: money(restocking) } }
        : {}),
      ...(shipping
        ? { returnShippingFeeSubtotalSet: { presentmentMoney: money(shipping) } }
        : {}),
    },
    returnLineItems: { nodes: [] },
  });
  const finalSaleOrder = {
    ...order,
    returnInformation: {
      ...order.returnInformation,
      nonReturnableSummary: { nonReturnableReasons: ["FINAL_SALE"] },
    },
  };

  // Rules that charge at least what Shopify does change nothing.
  await noteReturnRulesDrift(shop, policy, order, calculation(undefined, "5.00"));
  await noteReturnRulesDrift(
    shop,
    { ...policy, restockingFeePercent: "15" },
    order,
    calculation("-3.00"),
  );
  assert.equal(updates.length, 0);

  await noteReturnRulesDrift(shop, policy, order, calculation("-3.00", "-7.50"));
  await noteReturnRulesDrift(shop, policy, finalSaleOrder, calculation());
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].where, {
    shop,
    returnRulesConfirmedAt: { not: null },
  });
  assert.equal(updates[0].data.returnRulesConfirmedAt, null);
  assert.match(updates[0].data.returnRulesMismatch, /restocking fee/);
  assert.match(updates[0].data.returnRulesMismatch, /7\.50 USD return shipping fee/);
  assert.match(updates[1].data.returnRulesMismatch, /final sale/);

  // Already paused: nothing more to record.
  await noteReturnRulesDrift(
    shop,
    { ...policy, returnRulesConfirmedAt: null },
    finalSaleOrder,
    calculation(),
  );
  assert.equal(updates.length, 2);
});
