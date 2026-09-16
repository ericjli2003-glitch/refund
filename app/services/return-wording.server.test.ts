import assert from "node:assert/strict";
import test from "node:test";

import type { ReturnableOrder } from "./automatic-return.server";
import { resolveReturning } from "./return-wording.server";

const money = { amount: "14.00", currencyCode: "CAD" };
const order = (
  id: string,
  name: string,
  items: Array<[string, string]>,
): ReturnableOrder => ({
  id: `gid://shopify/Order/${id}`,
  name,
  processedAt: "2026-09-01T00:00:00Z",
  returnInformation: {
    nonReturnableSummary: null,
    returnableLineItems: {
      nodes: items.map(([lineItemId, title]) => ({
        quantity: 2,
        lineItem: {
          id: `gid://shopify/LineItem/${lineItemId}`,
          presentmentTitle: title,
          currentTotalPrice: money,
        },
      })),
    },
  },
});

const ORDERS = [
  order("1", "#1001", [["11", "Refund Test Product"]]),
  order("2", "#1002", [["21", "Blue Mug"]]),
  order("3", "#1003", [
    ["31", "Twin Candle"],
    ["32", "Twin Candle"],
  ]),
];

test("a product name and order number become the customer's own Shopify IDs", () => {
  assert.deepEqual(
    resolveReturning(
      [{ order: "#1001", product: "refund test product", quantity: 2 }],
      ORDERS,
    ),
    [
      {
        orderId: "gid://shopify/Order/1",
        items: [{ lineItemId: "gid://shopify/LineItem/11", quantity: 2 }],
      },
    ],
  );
  // Without an order number, the only order holding that product is used, and
  // one is the default quantity.
  assert.deepEqual(resolveReturning([{ product: "Blue Mug" }], ORDERS), [
    {
      orderId: "gid://shopify/Order/2",
      items: [{ lineItemId: "gid://shopify/LineItem/21", quantity: 1 }],
    },
  ]);
  // Items from several orders are one basket, grouped by order.
  assert.deepEqual(
    resolveReturning(
      [{ product: "Blue Mug" }, { order: "1001", product: "Refund Test Product" }],
      ORDERS,
    ),
    [
      {
        orderId: "gid://shopify/Order/2",
        items: [{ lineItemId: "gid://shopify/LineItem/21", quantity: 1 }],
      },
      {
        orderId: "gid://shopify/Order/1",
        items: [{ lineItemId: "gid://shopify/LineItem/11", quantity: 1 }],
      },
    ],
  );
});

test("a product title on two line items is refused rather than guessed", () => {
  assert.throws(
    () => resolveReturning([{ product: "Twin Candle" }], ORDERS),
    /More than one returnable item matches "Twin Candle"/,
  );
  // Naming the order doesn't help when both items are on it.
  assert.throws(
    () => resolveReturning([{ order: "#1003", product: "Twin Candle" }], ORDERS),
    /More than one returnable item matches/,
  );
});

test("an order number that isn't the customer's is refused", () => {
  assert.throws(
    () =>
      resolveReturning(
        [{ order: "#9999", product: "Refund Test Product" }],
        ORDERS,
      ),
    /no returnable order #9999 at this store/,
  );
});

test("a product from a different order is refused, and says which order has it", () => {
  assert.throws(
    () => resolveReturning([{ order: "#1001", product: "Blue Mug" }], ORDERS),
    /"Blue Mug" isn't on order #1001\. It's on Blue Mug on order #1002/,
  );
  assert.throws(
    () => resolveReturning([{ product: "Nothing Like This" }], ORDERS),
    /Nothing called "Nothing Like This" is returnable/,
  );
});

test("the same item listed twice is refused rather than silently merged", () => {
  assert.throws(
    () =>
      resolveReturning(
        [{ product: "Blue Mug" }, { order: "#1002", product: "blue mug" }],
        ORDERS,
      ),
    /listed twice/,
  );
});
