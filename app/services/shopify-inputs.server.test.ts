import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReturnApprovalVariables,
  buildReturnProcessTransactions,
  type SuggestedRefundTransaction,
} from "./shopify-inputs.server";

test("return approval variables use Shopify's required id field", () => {
  assert.deepEqual(
    buildReturnApprovalVariables("gid://shopify/Return/123"),
    { input: { id: "gid://shopify/Return/123" } },
  );
});

test("suggested transactions become returnProcess order transaction inputs", () => {
  assert.deepEqual(
    buildReturnProcessTransactions(
      [
        {
          amountSet: { presentmentMoney: { amount: "42.00", currencyCode: "CAD" } },
          gateway: "shopify_payments",
          parentTransaction: { id: "gid://shopify/OrderTransaction/123", gateway: "shopify_payments", manualPaymentGateway: false },
        },
      ],
      { amount: "42.00", currencyCode: "CAD" },
    ),
    [
      {
        parentId: "gid://shopify/OrderTransaction/123",
        transactionAmount: { amount: "42.00", currencyCode: "CAD" },
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
  assert.equal(buildReturnProcessTransactions([transaction("0.10"), transaction("0.20", "124")],
    { amount: "0.30", currencyCode: "CAD" }).length, 2);
  assert.equal(buildReturnProcessTransactions([transaction("1.005"), transaction("2.010", "124")],
    { amount: "3.015", currencyCode: "CAD" }).length, 2);
  assert.throws(() => buildReturnProcessTransactions([transaction("13.99")],
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
    assert.throws(() => buildReturnProcessTransactions(transactions,
      { amount: "14", currencyCode: "CAD" }), /original payment processor/);
  }
});
