import assert from "node:assert/strict";
import test from "node:test";
import prisma from "../../db.server";
import { ReturnNotCreatedError } from "../return-guards.server";
import type { WixApi } from "./wix-api.server";
import {
  receiveWixReturn,
  retryWixReturn,
  submitWixReturn,
  wixReturnId,
  type WixReturnDeps,
} from "./wix-return-flow.server";

const shop = "wix-0f8a7c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const api: WixApi = async () => {
  throw new Error("The flow must go through its deps, not the API.");
};
const items = [{ lineItemId: "line-1", quantity: 1 }];
const confirmed = { amount: "40.00", currencyCode: "EUR" };

const record = (overrides: Record<string, unknown> = {}) => ({
  id: "return-1",
  shop,
  orderId: "order-1",
  idempotencyKey: "key-1",
  refundTiming: "IMMEDIATE",
  amount: "40.00",
  currencyCode: "EUR",
  itemReceivedAt: null,
  ...overrides,
});

function recordUpdates(t: test.TestContext) {
  const updates: Array<Record<string, unknown>> = [];
  const original = prisma.agentReturn.update;
  Reflect.set(
    prisma.agentReturn,
    "update",
    t.mock.fn(async (args: { data: Record<string, unknown> }) => {
      updates.push(args.data);
      return args.data;
    }),
  );
  t.after(() => Reflect.set(prisma.agentReturn, "update", original));
  return updates;
}

function fakeDeps(result: Awaited<ReturnType<WixReturnDeps["refundWixReturn"]>> | Error) {
  const refunds: Array<Parameters<WixReturnDeps["refundWixReturn"]>[0]> = [];
  const restocks: Array<Parameters<WixReturnDeps["restockWixItems"]>[0]> = [];
  const deps: WixReturnDeps = {
    refundWixReturn: async (input) => {
      refunds.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
    restockWixItems: async (input) => {
      restocks.push(input);
    },
  };
  return { deps, refunds, restocks };
}

test("an immediate Wix return refunds now without restocking", async (t) => {
  const updates = recordUpdates(t);
  const { deps, refunds } = fakeDeps({ refundId: "refund-1", status: "PENDING" });
  await submitWixReturn({ record: record(), items, confirmed, api, deps });
  assert.equal(refunds.length, 1);
  assert.deepEqual(refunds[0], {
    shop,
    orderId: "order-1",
    items,
    amount: confirmed,
    restock: false,
    idempotencyKey: "key-1",
  });
  assert.equal(updates[0].returnId, wixReturnId("return-1"));
  assert.deepEqual(updates.at(-1), {
    status: "REFUND_SUBMITTED",
    refundId: "refund-1",
    refundStatus: "PENDING",
    failureReason: null,
  });
});

test("an on-receipt Wix return waits for the item and moves no money", async (t) => {
  const updates = recordUpdates(t);
  const { deps, refunds } = fakeDeps({ refundId: "refund-1", status: "SUCCESS" });
  await submitWixReturn({
    record: record({ refundTiming: "ON_RECEIPT" }),
    items,
    confirmed,
    api,
    deps,
  });
  assert.equal(refunds.length, 0);
  assert.equal(updates.at(-1)?.status, "AWAITING_ITEM");
});

test("a clear refusal from Wix leaves the request safe to confirm again", async (t) => {
  const updates = recordUpdates(t);
  const { deps } = fakeDeps(new ReturnNotCreatedError("The order isn't refundable."));
  await assert.rejects(
    submitWixReturn({ record: record(), items, confirmed, api, deps }),
    /Nothing was submitted and no refund was issued/,
  );
  assert.deepEqual(updates.at(-1), {
    status: "NOT_SUBMITTED",
    returnId: null,
    returnStatus: null,
    failureReason: "The order isn't refundable.",
  });
});

test("an unclear outcome goes to the merchant, never back to the customer to retry", async (t) => {
  const updates = recordUpdates(t);
  const { deps } = fakeDeps(new Error("Wix timed out"));
  await assert.rejects(
    submitWixReturn({ record: record(), items, confirmed, api, deps }),
    /Wix timed out/,
  );
  assert.equal(updates.at(-1)?.status, "NEEDS_ATTENTION");
});

test("a refund Wix reports as failed needs the merchant's attention", async (t) => {
  const updates = recordUpdates(t);
  const { deps } = fakeDeps({ refundId: "refund-1", status: "FAILED" });
  await submitWixReturn({ record: record(), items, confirmed, api, deps });
  assert.equal(updates.at(-1)?.status, "NEEDS_ATTENTION");
  assert.equal(updates.at(-1)?.refundStatus, "FAILED");
});

test("receiving an on-receipt return refunds and restocks together", async (t) => {
  recordUpdates(t);
  const { deps, refunds, restocks } = fakeDeps({ refundId: "refund-2", status: "SUCCESS" });
  await receiveWixReturn(record({ refundTiming: "ON_RECEIPT" }), items, true, api, deps);
  assert.equal(refunds[0].restock, true);
  assert.equal(restocks.length, 0);
});

test("receiving an already refunded return only restocks, and only when asked", async (t) => {
  recordUpdates(t);
  const first = fakeDeps({ refundId: "unused", status: "SUCCESS" });
  await receiveWixReturn(record(), items, true, api, first.deps);
  assert.equal(first.refunds.length, 0);
  assert.deepEqual(first.restocks, [{ shop, orderId: "order-1", items }]);

  const second = fakeDeps({ refundId: "unused", status: "SUCCESS" });
  await receiveWixReturn(record(), items, false, api, second.deps);
  assert.equal(second.refunds.length + second.restocks.length, 0);
});

test("a retry of an on-receipt return whose item isn't back refunds nothing", async (t) => {
  const updates = recordUpdates(t);
  const { deps, refunds } = fakeDeps({ refundId: "refund-3", status: "SUCCESS" });
  await retryWixReturn(record({ refundTiming: "ON_RECEIPT" }), items, api, deps);
  assert.equal(refunds.length, 0);
  assert.equal(updates.at(-1)?.status, "AWAITING_ITEM");

  await retryWixReturn(
    record({ refundTiming: "ON_RECEIPT", itemReceivedAt: new Date() }),
    items,
    api,
    deps,
  );
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].restock, true);
  assert.equal(refunds[0].idempotencyKey, "key-1");
});
