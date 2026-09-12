import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRefundTransactions,
  buildReturnApprovalVariables,
  type SuggestedRefundTransaction,
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
        amountSet: { presentmentMoney: { amount: "42.00", currencyCode: "CAD" } },
        gateway: "shopify_payments",
        parentTransaction: { id: "gid://shopify/OrderTransaction/123", gateway: "shopify_payments", manualPaymentGateway: false },
      },
    ], { amount: "42.00", currencyCode: "CAD" }),
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

function transaction(amount: string, id = "123"): SuggestedRefundTransaction {
  return {
    amountSet: { presentmentMoney: { amount, currencyCode: "CAD" } },
    gateway: "shopify_payments",
    parentTransaction: {
      id: `gid://shopify/OrderTransaction/${id}`,
      gateway: "shopify_payments",
      manualPaymentGateway: false,
    },
  };
}

test("split original payments must match the exact confirmed total", () => {
  assert.equal(buildRefundTransactions("order", [transaction("0.10"), transaction("0.20", "124")],
    { amount: "0.30", currencyCode: "CAD" }).length, 2);
  assert.equal(buildRefundTransactions("order", [transaction("1.005"), transaction("2.010", "124")],
    { amount: "3.015", currencyCode: "CAD" }).length, 2);
  assert.throws(() => buildRefundTransactions("order", [transaction("13.99")],
    { amount: "14", currencyCode: "CAD" }), /original payment processor/);
});

test("no refund can be routed to a replacement gateway, manual payment, missing parent, or different currency", () => {
  const wrongCurrency = transaction("14");
  wrongCurrency.amountSet.presentmentMoney.currencyCode = "USD";
  const manual = transaction("14");
  manual.parentTransaction!.manualPaymentGateway = true;
  for (const transactions of [
    [],
    [{ ...transaction("14"), parentTransaction: null }],
    [{ ...transaction("14"), gateway: "replacement_payout" }],
    [manual], [wrongCurrency],
    [transaction("7"), transaction("7")],
    [transaction("-14")], [transaction("0")], [transaction("NaN")],
  ]) {
    assert.throws(() => buildRefundTransactions("order", transactions,
      { amount: "14", currencyCode: "CAD" }), /original payment processor/);
  }
});
