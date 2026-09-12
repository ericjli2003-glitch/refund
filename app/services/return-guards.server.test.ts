import assert from "node:assert/strict";
import test from "node:test";

import {
  hasDuplicateLineItems,
  hashCustomerId,
  moneyAmountsMatch,
  moneyIsAbove,
  refundFromReturnTotal,
  sameReturnItems,
} from "./return-guards.server";

test("idempotency item comparison ignores ordering but not quantities", () => {
  const original = [
    { lineItemId: "gid://shopify/LineItem/2", quantity: 1 },
    { lineItemId: "gid://shopify/LineItem/1", quantity: 2 },
  ];
  const reordered = [
    { lineItemId: "gid://shopify/LineItem/1", quantity: 2 },
    { lineItemId: "gid://shopify/LineItem/2", quantity: 1 },
  ];

  assert.equal(sameReturnItems(original, reordered), true);
  assert.equal(
    sameReturnItems(original, [{ ...reordered[0], quantity: 1 }]),
    false,
  );
});

test("idempotency survives PostgreSQL JSONB key ordering and rejects corrupt records", () => {
  const input = [{ lineItemId: "gid://shopify/LineItem/73", quantity: 1 }];
  assert.equal(sameReturnItems([{ quantity: 1, lineItemId: input[0].lineItemId }], input), true);
  assert.equal(sameReturnItems([{ quantity: 2, lineItemId: input[0].lineItemId }], input), false);
  assert.equal(sameReturnItems([null], input), false);
  assert.equal(sameReturnItems([{ quantity: "1", lineItemId: input[0].lineItemId }], input), false);
});

test("duplicate line items are rejected", () => {
  assert.equal(
    hasDuplicateLineItems([
      { lineItemId: "line-1", quantity: 1 },
      { lineItemId: "line-1", quantity: 1 },
    ]),
    true,
  );
});

test("money guards reject invalid and over-limit amounts", () => {
  assert.equal(moneyIsAbove("100.01", "100.00"), true);
  assert.equal(moneyIsAbove("99.99", "100.00"), false);
  assert.equal(moneyIsAbove("invalid", "100.00"), true);
  assert.equal(moneyAmountsMatch("49.0", "49.00"), true);
  assert.equal(moneyAmountsMatch("49.01", "49.00"), false);
});

test("customer identifiers are stable, secret-keyed hashes", () => {
  const customerId = "gid://shopify/Customer/123";
  assert.equal(
    hashCustomerId(customerId, "secret"),
    hashCustomerId(customerId, "secret"),
  );
  assert.notEqual(
    hashCustomerId(customerId, "secret"),
    hashCustomerId(customerId, "another-secret"),
  );
  assert.throws(() => hashCustomerId(customerId, ""));
});

test("Shopify return credits become exact positive refunds, never customer charges", () => {
  assert.deepEqual(
    refundFromReturnTotal({ amount: "-14.00", currencyCode: "CAD" }),
    {
      amount: "14.00",
      currencyCode: "CAD",
    },
  );
  assert.equal(
    refundFromReturnTotal({ amount: "-0.001", currencyCode: "KWD" }).amount,
    "0.001",
  );
  for (const amount of [
    "0",
    "-0.00",
    "14.00",
    "NaN",
    "Infinity",
    "-1e2",
    "",
    " -14.00",
  ]) {
    assert.throws(() => refundFromReturnTotal({ amount, currencyCode: "CAD" }));
  }
});
