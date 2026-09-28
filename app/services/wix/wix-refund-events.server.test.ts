import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";

import {
  WIX_REFUND_FAILED_REASON,
  recordWixRefundCompleted,
  wixRefundOutcome,
} from "./wix-refund-events.server";

const shop = "wix-1b4f3c2a-9d8e-4f7a-8b6c-5d4e3f2a1b0c";

const body = (...statuses: string[]) => ({
  orderId: "order-1",
  refund: {
    id: "refund-1",
    transactions: statuses.map((refundStatus) => ({ paymentId: "p", refundStatus })),
  },
});

function fakeDb(count = 1) {
  const calls: unknown[] = [];
  const db = {
    agentReturn: {
      updateMany: async (args: unknown) => {
        calls.push(args);
        return { count };
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { db, calls };
}

test("a refund is successful only when every transaction succeeded", () => {
  assert.equal(wixRefundOutcome(body("SUCCEEDED", "SUCCEEDED"))?.refundStatus, "SUCCESS");
  assert.equal(wixRefundOutcome(body("SUCCEEDED", "FAILED"))?.refundStatus, "FAILED");
  assert.equal(wixRefundOutcome(body("FAILED"))?.refundStatus, "FAILED");
  assert.equal(wixRefundOutcome(body())?.refundStatus, "FAILED");
  for (const bad of [null, "x", {}, { orderId: "o" }, { orderId: "o", refund: {} }, { refund: { id: "r" } }])
    assert.equal(wixRefundOutcome(bad), null);
});

test("success moves a submitted refund to recorded without overwriting a final result", async () => {
  const { db, calls } = fakeDb();
  assert.equal(await recordWixRefundCompleted(db, shop, body("SUCCEEDED")), 1);
  assert.deepEqual(calls[0], {
    where: {
      shop,
      orderId: "order-1",
      refundId: "refund-1",
      status: { in: ["REFUND_SUBMITTED", "REFUND_RECORDED"] },
      OR: [{ refundStatus: null }, { refundStatus: { notIn: ["SUCCESS", "FAILED"] } }],
    },
    data: { status: "REFUND_RECORDED", refundStatus: "SUCCESS" },
  });
});

test("failure always flags the return for attention with a plain reason", async () => {
  const { db, calls } = fakeDb();
  await recordWixRefundCompleted(db, shop, body("SUCCEEDED", "FAILED"));
  assert.deepEqual(calls[0], {
    where: { shop, orderId: "order-1", refundId: "refund-1" },
    data: {
      status: "NEEDS_ATTENTION",
      refundStatus: "FAILED",
      failureReason: WIX_REFUND_FAILED_REASON,
    },
  });
  assert.doesNotMatch(WIX_REFUND_FAILED_REASON, /—/);
});

test("an unreadable event changes nothing", async () => {
  const { db, calls } = fakeDb();
  assert.equal(await recordWixRefundCompleted(db, shop, null), 0);
  assert.equal(calls.length, 0);
});
