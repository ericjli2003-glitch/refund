import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../../db.server";
import type { ReturnableOrder } from "../automatic-return.server";
import { ReturnNotCreatedError } from "../return-guards.server";
import { WixApiError, type WixApi } from "./wix-api.server";
import { WIX_STORES_APP_ID } from "./wix-catalog.server";
import {
  calculateWixReturn,
  currencyDigits,
  hasWixOrdersForEmail,
  listWixCollections,
  refundWixReturn,
  restockWixItems,
  wixCustomerOrders,
  wixRefundReference,
  wixRefundStatus,
} from "./wix-returns.server";

const shop = "wix-0b9a3c1e-5d7f-4a2b-9c8d-1e2f3a4b5c6d";
const email = "jane@example.com";
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

function policy(overrides: Record<string, unknown> = {}) {
  return {
    shop,
    verifiedStoreLinks: true,
    returnRulesConfirmedAt: confirmed,
    restockingFeePercent: "0",
    returnShippingFee: "0.00",
    finalSaleCollectionIds: [] as string[],
    currencyCode: "USD",
    ...overrides,
  };
}

// One mock per test; tests change what it answers through the returned setters.
function store(t: TestContext, overrides: Record<string, unknown> = {}) {
  let current: ReturnType<typeof policy> | null = policy(overrides);
  let install: { permissions: string[] } | null = {
    permissions: ["SCOPE.DC-STORES.READ-PRODUCTS"],
  };
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => current);
  mockDelegate(t, prisma.wixInstallation, "findUnique", async () => install);
  return {
    setPolicy: (next: Record<string, unknown>) => {
      current = policy(next);
    },
    setInstall: (next: { permissions: string[] } | null) => {
      install = next;
    },
  };
}

type Call = { method: string; path: string; body?: unknown; options?: unknown };
type Route = (body: unknown, path: string) => unknown;

// A fake Wix site: routes keyed "METHOD /path" (the query string is part of
// the key), every call recorded.
function fakeWix(routes: Record<string, Route | unknown>) {
  const calls: Call[] = [];
  const api = (async (method: string, path: string, body?: unknown, options?: unknown) => {
    calls.push({ method, path, body, options });
    const route = routes[`${method} ${path}`];
    if (route === undefined) throw new WixApiError(`No route for ${method} ${path}`, 404, true);
    return typeof route === "function" ? (route as Route)(body, path) : route;
  }) as WixApi;
  return { api, calls, called: (key: string) => calls.filter((call) => `${call.method} ${call.path}` === key) };
}

function line(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    productName: { original: `Product ${id}`, translated: null },
    catalogReference: { catalogItemId: `product-${id}`, appId: WIX_STORES_APP_ID, options: { variantId: `variant-${id}` } },
    quantity: 2,
    itemType: { preset: "PHYSICAL" },
    totalPriceAfterTax: { amount: "54.00" },
    ...overrides,
  };
}

function order(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    number: "1001",
    createdDate: "2026-09-10T12:00:00.000Z",
    currency: "USD",
    status: "APPROVED",
    paymentStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    archived: false,
    buyerInfo: { email: "Jane@Example.com" },
    lineItems: [line("line-a")],
    ...overrides,
  };
}

function refundability(
  lines: Array<[string, number, number]>,
  payments: Array<[string, string]> = [["payment-1", "1000.00"]],
) {
  return {
    payments: payments.map(([paymentId, maxRefund]) => ({
      refundable: true,
      payment: { paymentId, paymentMethod: "CreditCard", monetary: { maxRefund: { amount: maxRefund } } },
    })),
    lineItems: lines.map(([lineItemId, originalQuantity, refundedQuantity]) => ({
      lineItemId,
      originalQuantity,
      refundedQuantity,
      availableRefundQuantity: originalQuantity - refundedQuantity,
    })),
  };
}

test("lists only the customer's paid Wix orders with what's left to return", async (t) => {
  store(t);
  const orders = [
    order("order-1", {
      number: 1001,
      lineItems: [
        line("line-a", { quantity: 3, productName: { original: "Tee", translated: "T-shirt" } }),
        line("line-digital", { itemType: { preset: "DIGITAL" } }),
        line("line-gift", { itemType: { preset: "GIFT_CARD" } }),
        line("line-done", { quantity: 1 }),
      ],
    }),
    order("order-other", { buyerInfo: { email: "someone@example.com" } }),
    order("order-canceled", { status: "CANCELED" }),
    order("order-unpaid", { paymentStatus: "NOT_PAID" }),
    order("order-archived", { archived: true }),
    order("order-partial", {
      number: "1002",
      paymentStatus: "PARTIALLY_REFUNDED",
      fulfillmentStatus: "PARTIALLY_FULFILLED",
      lineItems: [line("line-p", { quantity: 4 }), line("line-q", { quantity: 1 })],
    }),
    order("order-unshipped", { fulfillmentStatus: "NOT_FULFILLED" }),
  ];
  const wix = fakeWix({
    "POST /ecom/v1/orders/search": { orders },
    "POST /ecom/v1/order-billing/get-order-refundability": (body) => {
      const { orderId } = body as { orderId: string };
      if (orderId === "order-1")
        return refundability([["line-a", 3, 1], ["line-digital", 2, 0], ["line-gift", 2, 0], ["line-done", 1, 1]]);
      if (orderId === "order-partial") return refundability([["line-p", 4, 1], ["line-q", 1, 0]]);
      return refundability([["line-a", 2, 0]]);
    },
    "POST /ecom/v1/fulfillments/list-by-ids": {
      ordersWithFulfillments: [
        { orderId: "order-partial", fulfillments: [{ lineItems: [{ id: "line-p", quantity: 2 }] }] },
      ],
    },
  });

  const result = await wixCustomerOrders(shop, { email }, wix.api);

  assert.equal(result.customerId, `email:${email}`);
  const [search] = wix.called("POST /ecom/v1/orders/search");
  assert.deepEqual(search.body, {
    search: {
      filter: { "buyerInfo.email": { $eq: email } },
      sort: [{ fieldName: "createdDate", order: "DESC" }],
      cursorPaging: { limit: 20 },
    },
  });
  // Someone else's order never comes back, even if the search returned it.
  assert.deepEqual(
    result.orders.map((entry) => entry.id),
    ["order-1", "order-canceled", "order-unpaid", "order-archived", "order-partial", "order-unshipped"],
  );
  const [first, canceled, unpaid, archived, partial, unshipped] = result.orders;
  assert.deepEqual(first, {
    id: "order-1",
    name: "#1001",
    processedAt: "2026-09-10T12:00:00.000Z",
    returnInformation: {
      nonReturnableSummary: null,
      returnableLineItems: {
        nodes: [
          {
            quantity: 2,
            lineItem: {
              id: "line-a",
              presentmentTitle: "T-shirt",
              currentTotalPrice: { amount: "54.00", currencyCode: "USD" },
            },
          },
        ],
      },
    },
  });
  for (const entry of [canceled, unpaid, archived, unshipped])
    assert.deepEqual(entry.returnInformation.returnableLineItems.nodes, []);
  // Two of line-p shipped, one of the four was refunded: one left to return.
  assert.deepEqual(
    partial.returnInformation.returnableLineItems.nodes.map((node) => [node.lineItem.id, node.quantity]),
    [["line-p", 1]],
  );
  // Refundability is only asked for orders that could be refunded.
  assert.deepEqual(
    wix.called("POST /ecom/v1/order-billing/get-order-refundability").map((call) => (call.body as { orderId: string }).orderId),
    ["order-1", "order-partial", "order-unshipped"],
  );
  // No final-sale collections, so no catalog lookups.
  assert.equal(wix.called("GET /stores/v3/provision/version").length, 0);
});

test("orders with no automatically refundable payment have nothing returnable", async (t) => {
  store(t);
  const wix = fakeWix({
    "POST /ecom/v1/orders/search": { orders: [order("order-1")] },
    "POST /ecom/v1/order-billing/get-order-refundability": {
      payments: [
        { manuallyRefundable: { reason: "OFFLINE" }, payment: { paymentId: "cash", offlinePayment: true } },
        { refundable: true, payment: { paymentId: "gift", paymentMethod: "GiftCard", monetary: { maxRefund: { amount: "10.00" } } } },
      ],
      lineItems: [{ lineItemId: "line-a", originalQuantity: 2, refundedQuantity: 0, availableRefundQuantity: 2 }],
    },
  });
  const { orders } = await wixCustomerOrders(shop, { email }, wix.api);
  assert.deepEqual(orders[0].returnInformation.returnableLineItems.nodes, []);
});

test("final-sale Catalog V1 collections exclude their products", async (t) => {
  store(t, { finalSaleCollectionIds: ["collection-sale"] });
  const wix = fakeWix({
    "POST /ecom/v1/orders/search": {
      orders: [order("order-1", { lineItems: [line("line-a"), line("line-b"), line("line-c", { catalogReference: { catalogItemId: "other-app-item", appId: "another-app" } })] })],
    },
    "POST /ecom/v1/order-billing/get-order-refundability": refundability([["line-a", 2, 0], ["line-b", 2, 0], ["line-c", 2, 0]]),
    "GET /stores/v3/provision/version": { catalogVersion: "V1_CATALOG" },
    "GET /stores-reader/v1/products/product-line-a": { product: { collectionIds: ["00000000-000000-000000-000000000001", "collection-sale"] } },
    "GET /stores-reader/v1/products/product-line-b": { product: { collectionIds: ["collection-new"] } },
  });
  const { orders } = await wixCustomerOrders(shop, { email }, wix.api);
  assert.deepEqual(orders[0].returnInformation.nonReturnableSummary, { nonReturnableReasons: ["FINAL_SALE"] });
  assert.deepEqual(
    orders[0].returnInformation.returnableLineItems.nodes.map((node) => node.lineItem.id),
    ["line-b", "line-c"],
  );
});

test("final-sale Catalog V3 categories, parents included, exclude their products", async (t) => {
  store(t, { finalSaleCollectionIds: ["category-clearance"] });
  const wix = fakeWix({
    "POST /ecom/v1/orders/search": { orders: [order("order-1", { lineItems: [line("line-a"), line("line-b"), line("line-gone")] })] },
    "POST /ecom/v1/order-billing/get-order-refundability": refundability([["line-a", 2, 0], ["line-b", 2, 0], ["line-gone", 2, 0]]),
    "GET /stores/v3/provision/version": { catalogVersion: "V3_CATALOG" },
    "GET /stores/v3/products/product-line-a?fields=ALL_CATEGORIES_INFO": {
      product: { allCategoriesInfo: { categories: [{ id: "category-shoes" }, { id: "category-clearance" }] } },
    },
    "GET /stores/v3/products/product-line-b?fields=ALL_CATEGORIES_INFO": {
      product: { allCategoriesInfo: { categories: [{ id: "category-shoes" }] } },
    },
    // product-line-gone has no route: the fake answers 404, a deleted product.
  });
  const { orders } = await wixCustomerOrders(shop, { email }, wix.api);
  assert.deepEqual(
    orders[0].returnInformation.returnableLineItems.nodes.map((node) => node.lineItem.id),
    ["line-b", "line-gone"],
  );
  assert.deepEqual(orders[0].returnInformation.nonReturnableSummary, { nonReturnableReasons: ["FINAL_SALE"] });
});

test("stores that haven't confirmed their rules are refused before Wix is asked", async (t) => {
  const site = store(t, { returnRulesConfirmedAt: null });
  site.setInstall({ permissions: [] });
  const wix = fakeWix({});
  await assert.rejects(wixCustomerOrders(shop, { email }, wix.api), /hasn't set up returns through assistants/);
  // Final-sale collections need product read access.
  site.setPolicy({ finalSaleCollectionIds: ["c"] });
  await assert.rejects(wixCustomerOrders(shop, { email }, wix.api), /hasn't set up returns/);
  // Not installed.
  site.setPolicy({});
  site.setInstall(null);
  await assert.rejects(wixCustomerOrders(shop, { email }, wix.api), /hasn't set up returns/);
  await assert.rejects(wixCustomerOrders("example.myshopify.com", { email }, wix.api), /isn't a Wix store/);
  await assert.rejects(wixCustomerOrders(shop, { email: 'bad"@x' }, wix.api), /invalid email/);
  assert.equal(wix.calls.length, 0);
});

function returnable(
  lines: Array<[string, number, string]>,
  currencyCode = "USD",
  id = "order-1",
): ReturnableOrder {
  return {
    id,
    name: "#1001",
    processedAt: "2026-09-10T12:00:00.000Z",
    returnInformation: {
      nonReturnableSummary: null,
      returnableLineItems: {
        nodes: lines.map(([lineId, quantity, amount]) => ({
          quantity,
          lineItem: { id: lineId, presentmentTitle: lineId, currentTotalPrice: { amount, currencyCode } },
        })),
      },
    },
  };
}

function calculated(
  lines: Array<[string, number, { subtotal: string; discount: string; tax: string; total: string }]>,
  total: string,
) {
  return {
    available: true,
    summary: { total: { amount: total } },
    calculatedRefundItems: {
      lineItems: lines.map(([lineItemId, quantity, summary]) => ({
        item: { lineItemId, quantity },
        summary: {
          subtotal: { amount: summary.subtotal },
          discount: { amount: summary.discount },
          tax: { amount: summary.tax },
          total: { amount: summary.total },
        },
      })),
    },
  };
}

test("applies the restocking and return shipping fees in exact decimals", async (t) => {
  store(t, { restockingFeePercent: "12.5", returnShippingFee: "4.99" });
  const wix = fakeWix({
    "POST /ecom/v1/order-billing/calculate-refund": calculated(
      [
        ["line-a", 1, { subtotal: "19.99", discount: "2.00", tax: "1.44", total: "19.43" }],
        ["line-b", 2, { subtotal: "10.10", discount: "0", tax: "0.81", total: "10.91" }],
      ],
      "30.34",
    ),
  });
  const items = [
    { lineItemId: "line-a", quantity: 1 },
    { lineItemId: "line-b", quantity: 2 },
  ];
  const result = await calculateWixReturn(shop, returnable([["line-a", 2, "40.00"], ["line-b", 2, "20.00"]]), items, wix.api);

  const [call] = wix.called("POST /ecom/v1/order-billing/calculate-refund");
  assert.deepEqual(call.body, { orderId: "order-1", refundItems: { lineItems: items } });
  // 12.5% of 17.99 = 2.24875 -> 2.25; of 10.10 = 1.2625 -> 1.26. 30.34 - 3.51 - 4.99 = 21.84.
  assert.deepEqual(result, {
    financialSummary: {
      returnTotalSet: {
        presentmentMoney: { amount: "-21.84", currencyCode: "USD" },
        shopMoney: { amount: "-21.84", currencyCode: "USD" },
      },
      restockingFeeSubtotalSet: { presentmentMoney: { amount: "3.51", currencyCode: "USD" } },
      returnShippingFeeSubtotalSet: { presentmentMoney: { amount: "4.99", currencyCode: "USD" } },
    },
    returnLineItems: {
      nodes: [
        { lineItem: { id: "line-a" }, quantity: 1 },
        { lineItem: { id: "line-b" }, quantity: 2 },
      ],
    },
  });
});

test("rounds fees to yen and dinar minor units", async (t) => {
  assert.equal(currencyDigits("JPY"), 0);
  assert.equal(currencyDigits("KWD"), 3);
  const site = store(t, { restockingFeePercent: "15", currencyCode: "JPY" });
  const yen = fakeWix({
    "POST /ecom/v1/order-billing/calculate-refund": calculated(
      [["line-a", 1, { subtotal: "1999", discount: "0", tax: "199", total: "2198" }]],
      "2198",
    ),
  });
  const jpy = await calculateWixReturn(shop, returnable([["line-a", 1, "2198"]], "JPY"), [{ lineItemId: "line-a", quantity: 1 }], yen.api);
  // 15% of 1999 = 299.85 -> 300 yen.
  assert.deepEqual(jpy.financialSummary.returnTotalSet.presentmentMoney, { amount: "-1898", currencyCode: "JPY" });
  assert.deepEqual(jpy.financialSummary.restockingFeeSubtotalSet?.presentmentMoney, { amount: "300", currencyCode: "JPY" });
  assert.equal(jpy.financialSummary.returnShippingFeeSubtotalSet, undefined);

  site.setPolicy({ restockingFeePercent: "10", returnShippingFee: "1.500", currencyCode: "KWD" });
  const dinar = fakeWix({
    "POST /ecom/v1/order-billing/calculate-refund": calculated(
      [["line-a", 1, { subtotal: "12.345", discount: "0.100", tax: "0", total: "12.245" }]],
      "12.245",
    ),
  });
  const kwd = await calculateWixReturn(shop, returnable([["line-a", 1, "12.245"]], "KWD"), [{ lineItemId: "line-a", quantity: 1 }], dinar.api);
  // 10% of 12.245 = 1.2245 -> 1.225; 12.245 - 1.225 - 1.500 = 9.520.
  assert.deepEqual(kwd.financialSummary.returnTotalSet.presentmentMoney, { amount: "-9.520", currencyCode: "KWD" });
  assert.deepEqual(kwd.financialSummary.restockingFeeSubtotalSet?.presentmentMoney, { amount: "1.225", currencyCode: "KWD" });
  assert.deepEqual(kwd.financialSummary.returnShippingFeeSubtotalSet?.presentmentMoney, { amount: "1.500", currencyCode: "KWD" });
});

test("never quotes a return that gives no money back, or items it can't return", async (t) => {
  const site = store(t, { returnShippingFee: "25.00" });
  const wix = fakeWix({
    "POST /ecom/v1/order-billing/calculate-refund": calculated(
      [["line-a", 1, { subtotal: "20.00", discount: "0", tax: "0", total: "20.00" }]],
      "20.00",
    ),
  });
  const order = returnable([["line-a", 1, "20.00"]]);
  await assert.rejects(
    calculateWixReturn(shop, order, [{ lineItemId: "line-a", quantity: 1 }], wix.api),
    /wouldn't give any money back/,
  );
  await assert.rejects(
    calculateWixReturn(shop, order, [{ lineItemId: "line-a", quantity: 2 }], wix.api),
    /not currently returnable/,
  );
  await assert.rejects(
    calculateWixReturn(shop, order, [{ lineItemId: "line-x", quantity: 1 }], wix.api),
    /not currently returnable/,
  );
  // The shipping fee is in USD; a EUR order can't be charged it.
  await assert.rejects(
    calculateWixReturn(shop, returnable([["line-a", 1, "20.00"]], "EUR"), [{ lineItemId: "line-a", quantity: 1 }], wix.api),
    /paid in EUR/,
  );
  assert.equal(wix.called("POST /ecom/v1/order-billing/calculate-refund").length, 1);

  const unavailable = fakeWix({
    "POST /ecom/v1/order-billing/calculate-refund": { notAvailable: { errors: [] }, calculatedRefundItems: { lineItems: [] } },
  });
  site.setPolicy({});
  await assert.rejects(
    calculateWixReturn(shop, order, [{ lineItemId: "line-a", quantity: 1 }], unavailable.api),
    /can't refund these items right now/,
  );
});

// A refundable order, its calculation and its transactions, for refund tests.
function refundSite(options: {
  refunds?: unknown[];
  refundPayments?: Route;
  payments?: Array<[string, string]>;
} = {}) {
  return fakeWix({
    "GET /ecom/v1/payments/orders/order-1": { orderTransactions: { orderId: "order-1", refunds: options.refunds ?? [] } },
    "GET /ecom/v1/orders/order-1": { order: order("order-1", { lineItems: [line("line-a", { quantity: 2 })] }) },
    "POST /ecom/v1/order-billing/get-order-refundability": refundability(
      [["line-a", 2, 0]],
      options.payments ?? [["payment-first", "10.00"], ["payment-card", "100.00"]],
    ),
    "POST /ecom/v1/order-billing/calculate-refund": calculated(
      [["line-a", 1, { subtotal: "25.00", discount: "0", tax: "2.00", total: "27.00" }]],
      "27.00",
    ),
    "POST /ecom/v1/order-billing/refund-payments":
      options.refundPayments ??
      (() => ({
        refund: {
          id: "refund-1",
          transactions: [
            { paymentId: "payment-first", refundStatus: "SUCCEEDED" },
            { paymentId: "payment-card", refundStatus: "PENDING" },
          ],
        },
      })),
  });
}

const refundInput = {
  shop,
  orderId: "order-1",
  items: [{ lineItemId: "line-a", quantity: 1 }],
  // 27.00 less a 10% restocking fee of 2.50.
  amount: { amount: "24.50", currencyCode: "USD" },
  restock: true,
  idempotencyKey: "return-record-1",
  reason: "Too small",
};

test("refunds the recalculated amount to the original payments", async (t) => {
  store(t, { restockingFeePercent: "10" });
  const wix = refundSite();
  const result = await refundWixReturn(refundInput, wix.api);
  assert.deepEqual(result, { refundId: "refund-1", status: "PENDING" });
  const [call] = wix.called("POST /ecom/v1/order-billing/refund-payments");
  assert.deepEqual(call.body, {
    orderId: "order-1",
    paymentRefunds: [
      { paymentId: "payment-first", amount: { amount: "10.00" }, externalRefund: false },
      { paymentId: "payment-card", amount: { amount: "14.50" }, externalRefund: false },
    ],
    refundItems: { lineItems: [{ lineItemId: "line-a", quantity: 1 }] },
    sideEffects: {
      restock: { lineItems: [{ lineItemId: "line-a", quantity: 1 }] },
      notifications: { sendCustomerEmail: true },
    },
    customerReason: `Too small (${wixRefundReference("return-record-1")})`,
  });
  assert.deepEqual(call.options, { idempotencyKey: "return-record-1" });
  // The lookup for an earlier refund runs before anything else.
  assert.equal(wix.calls[0].path, "/ecom/v1/payments/orders/order-1");
});

test("an immediate refund doesn't restock", async (t) => {
  store(t, { restockingFeePercent: "10" });
  const wix = refundSite();
  await refundWixReturn({ ...refundInput, restock: false, reason: undefined }, wix.api);
  const body = wix.called("POST /ecom/v1/order-billing/refund-payments")[0].body as {
    sideEffects: Record<string, unknown>;
    customerReason: string;
  };
  assert.deepEqual(body.sideEffects, { notifications: { sendCustomerEmail: true } });
  assert.match(body.customerReason, /^Returned with Gooper\.io ref [0-9a-f]{16}$/);
});

test("refuses when the amount no longer matches, before any money moves", async (t) => {
  store(t, { restockingFeePercent: "10" });
  const wix = refundSite();
  for (const amount of [
    { amount: "27.00", currencyCode: "USD" },
    { amount: "24.49", currencyCode: "USD" },
    { amount: "24.50", currencyCode: "EUR" },
  ])
    await assert.rejects(
      refundWixReturn({ ...refundInput, amount }, wix.api),
      (error: unknown) => error instanceof ReturnNotCreatedError && /changed since it was confirmed/.test(error.message),
    );
  // Exact decimals: 24.5 is the same amount as 24.50.
  await refundWixReturn({ ...refundInput, amount: { amount: "24.5", currencyCode: "USD" } }, wix.api);
  assert.equal(wix.called("POST /ecom/v1/order-billing/refund-payments").length, 1);
});

test("refuses when the payments can't cover the refund", async (t) => {
  store(t, { restockingFeePercent: "10" });
  const wix = refundSite({ payments: [["payment-card", "20.00"]] });
  await assert.rejects(refundWixReturn(refundInput, wix.api), ReturnNotCreatedError);
  assert.equal(wix.called("POST /ecom/v1/order-billing/refund-payments").length, 0);
});

test("a retry returns the earlier refund instead of refunding twice", async (t) => {
  store(t, { restockingFeePercent: "10" });
  const reference = wixRefundReference(refundInput.idempotencyKey);
  const wix = refundSite({
    refunds: [
      { id: "refund-other", details: { reason: "Something else" }, transactions: [{ refundStatus: "SUCCEEDED" }] },
      { id: "refund-earlier", details: { reason: `Too small (${reference})` }, transactions: [{ refundStatus: "SUCCEEDED" }] },
    ],
  });
  assert.deepEqual(await refundWixReturn(refundInput, wix.api), { refundId: "refund-earlier", status: "SUCCESS" });
  assert.equal(wix.called("POST /ecom/v1/order-billing/refund-payments").length, 0);
  assert.equal(wix.called("POST /ecom/v1/order-billing/calculate-refund").length, 0);

  // A refund that failed outright moved no money, so a retry refunds again.
  const failed = refundSite({
    refunds: [{ id: "refund-failed", details: { reason: `Too small (${reference})` }, transactions: [{ refundStatus: "FAILED" }] }],
  });
  assert.deepEqual(await refundWixReturn(refundInput, failed.api), { refundId: "refund-1", status: "PENDING" });
  assert.equal(failed.called("POST /ecom/v1/order-billing/refund-payments").length, 1);
});

test("only a clear refusal from Wix counts as nothing submitted", async (t) => {
  store(t, { restockingFeePercent: "10" });
  const refused = refundSite({
    refundPayments: () => {
      throw new WixApiError("Payment not refundable", 400, true, "PAYMENT_NOT_REFUNDABLE");
    },
  });
  await assert.rejects(refundWixReturn(refundInput, refused.api), (error: unknown) =>
    error instanceof ReturnNotCreatedError && /Wix didn't accept the refund/.test(error.message),
  );
  const timeout = new WixApiError("Wix timed out", 504, false);
  const unknown = refundSite({
    refundPayments: () => {
      throw timeout;
    },
  });
  await assert.rejects(refundWixReturn(refundInput, unknown.api), (error: unknown) => error === timeout);
  // Without a refund in the answer, nobody can say whether money moved.
  const empty = refundSite({ refundPayments: () => ({}) });
  await assert.rejects(refundWixReturn(refundInput, empty.api), (error: unknown) =>
    !(error instanceof ReturnNotCreatedError) && /didn't confirm the refund/.test((error as Error).message),
  );
  // A failed lookup for an earlier refund can't rule one out either.
  const lookup = fakeWix({});
  await assert.rejects(refundWixReturn(refundInput, lookup.api), (error: unknown) =>
    error instanceof WixApiError && !(error instanceof ReturnNotCreatedError),
  );
});

test("maps Wix refund transaction statuses", () => {
  const map = (...statuses: string[]) => wixRefundStatus(statuses.map((refundStatus) => ({ refundStatus })));
  assert.equal(map("SUCCEEDED"), "SUCCESS");
  assert.equal(map("SUCCEEDED", "SUCCEEDED"), "SUCCESS");
  assert.equal(map("PENDING"), "PENDING");
  assert.equal(map("SCHEDULED"), "PENDING");
  assert.equal(map("STARTED", "SUCCEEDED"), "PENDING");
  assert.equal(map("FAILED"), "FAILED");
  assert.equal(map("FAILED", "FAILED"), "FAILED");
  assert.equal(map("FAILED", "SUCCEEDED"), "UNKNOWN");
  assert.equal(map("SOMETHING_NEW"), "UNKNOWN");
  assert.equal(map(), "UNKNOWN");
});

test("checks whether a Wix site has orders for an email", async () => {
  const wix = fakeWix({
    "POST /ecom/v1/orders/search": (body) =>
      (body as { search: { filter: { "buyerInfo.email": { $eq: string } } } }).search.filter["buyerInfo.email"].$eq === email
        ? { orders: [order("order-1")] }
        : { orders: [order("order-2", { buyerInfo: { email: "someone@example.com" } })] },
  });
  assert.equal(await hasWixOrdersForEmail(shop, email, wix.api), true);
  assert.equal(await hasWixOrdersForEmail(shop, "other@example.com", wix.api), false);
  assert.equal(await hasWixOrdersForEmail("example.myshopify.com", email, wix.api), false);
});

test("lists Catalog V1 collections and Catalog V3 categories", async () => {
  const page = Array.from({ length: 100 }, (_, index) => ({ id: `c${index}`, name: `Collection ${String(index).padStart(3, "0")}` }));
  const v1 = fakeWix({
    "GET /stores/v3/provision/version": { catalogVersion: "V1_CATALOG" },
    "POST /stores-reader/v2/collections/query": (body) =>
      (body as { query: { paging: { offset: number } } }).query.paging.offset === 0
        ? { collections: page }
        : { collections: [{ id: "sale", name: "Final sale" }] },
  });
  const collections = await listWixCollections(v1.api);
  assert.equal(collections.length, 101);
  assert.deepEqual(collections.find((entry) => entry.id === "sale"), { id: "sale", name: "Final sale" });

  const v3 = fakeWix({
    "GET /stores/v3/provision/version": { catalogVersion: "V3_CATALOG" },
    "POST /categories/v1/categories/query": (body) =>
      (body as { query: { cursorPaging: { cursor?: string } } }).query.cursorPaging.cursor
        ? { categories: [{ id: "cat-2", name: "Clearance" }], pagingMetadata: { hasNext: false } }
        : { categories: [{ id: "cat-1", name: "Shoes" }], pagingMetadata: { hasNext: true, cursors: { next: "next" } } },
  });
  assert.deepEqual(await listWixCollections(v3.api), [
    { id: "cat-2", name: "Clearance" },
    { id: "cat-1", name: "Shoes" },
  ]);
  assert.deepEqual(v3.called("POST /categories/v1/categories/query")[0].body, {
    query: { cursorPaging: { limit: 100 } },
    treeReference: { appNamespace: "@wix/stores" },
    returnNonVisibleCategories: true,
  });

  const none = fakeWix({ "GET /stores/v3/provision/version": { catalogVersion: "STORES_NOT_INSTALLED" } });
  assert.deepEqual(await listWixCollections(none.api), []);
});

test("restocks returned items in Wix Stores inventory", async () => {
  const lines = [
    line("line-a", { locations: [{ id: "location-1", quantity: 2 }] }),
    line("line-b", { catalogReference: { catalogItemId: "product-b", appId: WIX_STORES_APP_ID, options: {} } }),
  ];
  const items = [
    { lineItemId: "line-a", quantity: 1 },
    { lineItemId: "line-b", quantity: 2 },
  ];
  const v1 = fakeWix({
    "GET /ecom/v1/orders/order-1": { order: order("order-1", { lineItems: lines }) },
    "GET /stores/v3/provision/version": { catalogVersion: "V1_CATALOG" },
    "POST /stores/v2/inventoryItems/increment": {},
  });
  await restockWixItems({ shop, orderId: "order-1", items }, v1.api);
  assert.deepEqual(v1.called("POST /stores/v2/inventoryItems/increment")[0].body, {
    incrementData: [
      { productId: "product-line-a", variantId: "variant-line-a", incrementBy: 1 },
      { productId: "product-b", variantId: "00000000-0000-0000-0000-000000000000", incrementBy: 2 },
    ],
  });

  const v3 = fakeWix({
    "GET /ecom/v1/orders/order-1": { order: order("order-1", { lineItems: lines }) },
    "GET /stores/v3/provision/version": { catalogVersion: "V3_CATALOG" },
    "POST /stores/v3/bulk/inventory-items/increment-by-variant-and-location": {
      results: [{ itemMetadata: { success: true } }, { itemMetadata: { success: false } }],
    },
  });
  await assert.rejects(restockWixItems({ shop, orderId: "order-1", items: [items[0]] }, v3.api), /couldn't restock one item/);
  assert.deepEqual(v3.called("POST /stores/v3/bulk/inventory-items/increment-by-variant-and-location")[0].body, {
    incrementData: [{ variantId: "variant-line-a", locationId: "location-1", incrementBy: 1 }],
  });

  await assert.rejects(
    restockWixItems({ shop, orderId: "order-1", items: [{ lineItemId: "line-a", quantity: 3 }] }, v1.api),
    /only restock Wix Stores products/,
  );
});
