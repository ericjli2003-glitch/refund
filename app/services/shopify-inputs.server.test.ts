import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRefundTransactions,
  buildReturnApprovalVariables,
} from "./shopify-inputs.server";

test("return approval variables use Shopify's required id field", () => {
  assert.deepEqual(
    buildReturnApprovalVariables("gid://shopify/Return/123"),
    { input: { id: "gid://shopify/Return/123" } },
  );
});

test("suggested transactions become refundCreate transaction inputs", () => {
  assert.deepEqual(
    buildRefundTransactions("gid://shopify/Order/123", [
      {
        amountSet: { presentmentMoney: { amount: "42.00" } },
        gateway: "shopify_payments",
        parentTransaction: { id: "gid://shopify/OrderTransaction/123" },
      },
    ]),
    [
      {
        amount: "42.00",
        gateway: "shopify_payments",
        kind: "REFUND",
        orderId: "gid://shopify/Order/123",
        parentId: "gid://shopify/OrderTransaction/123",
      },
    ],
  );
});
