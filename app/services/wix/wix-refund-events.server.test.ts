import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";

import {
  WIX_REFUND_FAILED_REASON,
  WixRefundNotYetRecorded,
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

function fakeDb(
  count = 1,
  { known = false, inFlight = false }: { known?: boolean; inFlight?: boolean } = {},
) {
  const calls: unknown[] = [];
  const lookups: unknown[] = [];
  const db = {
    agentReturn: {
      updateMany: async (args: unknown) => {
        calls.push(args);
        return { count };
      },
      findFirst: async (args: { where: { refundId: string | null } }) => {
        lookups.push(args);
        const match = args.where.refundId === null ? inFlight : known;
        return match ? { id: "return-1" } : null;
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { db, calls, lookups };
}

const withReason = (reason: string, ...statuses: string[]) => {
  const event = body(...statuses);
  return { ...event, refund: { ...event.refund, details: { reason } } };
};

test("a refund is successful only when every transaction succeeded", () => {
  // A mix of succeeded and failed transactions is a failure: part of the
  // money did not move, so a person has to look.
  assert.equal(wixRefundOutcome(body("SUCCEEDED", "FAILED", "SUCCEEDED"))?.refundStatus, "FAILED");
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

test("a result for a refund whose return has not saved its ID yet is retried", async () => {
  for (const statuses of [["SUCCEEDED"], ["SUCCEEDED", "FAILED"]]) {
    const { db, lookups } = fakeDb(0, { inFlight: true });
    await assert.rejects(recordWixRefundCompleted(db, shop, body(...statuses)), WixRefundNotYetRecorded);
    assert.deepEqual(lookups[1], {
      where: {
        shop,
        orderId: "order-1",
        refundId: null,
        status: {
          in: [
            "RETURN_OPEN",
            "AWAITING_ITEM",
            "RECEIVING",
            "RETRYING",
            "IN_PROGRESS",
            "NEEDS_ATTENTION",
            "REFUND_SUBMITTED",
          ],
        },
      },
      select: { id: true },
    });
  }
});

test("a refund carrying Gooper.io's reference is retried even with no return waiting", async () => {
  const { db } = fakeDb(0);
  await assert.rejects(
    recordWixRefundCompleted(db, shop, withReason("Changed my mind (Gooper.io ref 0123456789abcdef)", "SUCCEEDED")),
    WixRefundNotYetRecorded,
  );
});

test("a refund someone else made in Wix is acknowledged", async () => {
  const { db } = fakeDb(0);
  assert.equal(await recordWixRefundCompleted(db, shop, withReason("Damaged in transit", "SUCCEEDED")), 0);
  assert.equal(await recordWixRefundCompleted(db, shop, body("FAILED")), 0);
});

test("a repeated result for a refund already recorded is acknowledged", async () => {
  // Even while another return on the same order waits for its own refund.
  const { db } = fakeDb(0, { known: true, inFlight: true });
  assert.equal(
    await recordWixRefundCompleted(db, shop, withReason("Returned with Gooper.io ref 0123456789abcdef", "SUCCEEDED")),
    0,
  );
});
