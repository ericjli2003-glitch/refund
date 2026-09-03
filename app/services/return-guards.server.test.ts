import assert from "node:assert/strict";
import test from "node:test";

import {
  hasDuplicateLineItems,
  hashCustomerId,
  moneyAmountsMatch,
  moneyIsAbove,
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
