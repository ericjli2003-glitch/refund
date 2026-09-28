import type { Prisma } from "@prisma/client";
import { WIX_REFUND_REFERENCE_PREFIX } from "./wix-returns.server";

// Wix refunds can finish after Refund Payments returns (transactions PENDING,
// SCHEDULED or STARTED). Wix sends wix.ecom.v1.order_transactions_refund_completed
// once every transaction in the refund has reached SUCCEEDED or FAILED; its
// action body is { orderId, refund: { id, transactions: [{ refundStatus }] }, ... }
// (per @wix/auto_sdk_ecom_order-transactions RefundCompleted).

type RefundCompletedBody = {
  orderId?: unknown;
  refund?: { id?: unknown; transactions?: unknown; details?: { reason?: unknown } };
};

export type WixRefundOutcome = {
  orderId: string;
  refundId: string;
  refundStatus: "SUCCESS" | "FAILED";
  // The refund's reason, where Gooper.io writes its reference.
  reason: string | null;
};

// Every refund Gooper.io submits carries WIX_REFUND_REFERENCE_PREFIX and a
// hash in its reason (wixRefundReference in wix-returns.server.ts).
export { WIX_REFUND_REFERENCE_PREFIX };

// A return that may be waiting to save the ID of a refund it just submitted.
const REFUND_IN_FLIGHT_STATUSES = [
  "RETURN_OPEN",
  "AWAITING_ITEM",
  "RECEIVING",
  "RETRYING",
  "IN_PROGRESS",
  "NEEDS_ATTENTION",
  "REFUND_SUBMITTED",
];

// Thrown when a refund result arrives before its return is ready to take it.
// processWebhookOnce rolls back (no receipt), the route answers 5xx, and Wix
// delivers the event again later.
export class WixRefundNotYetRecorded extends Error {
  constructor() {
    super("The Wix refund result arrived before its return saved the refund. Wix will retry.");
    this.name = "WixRefundNotYetRecorded";
  }
}

export function wixRefundOutcome(body: unknown): WixRefundOutcome | null {
  if (!body || typeof body !== "object") return null;
  const { orderId, refund } = body as RefundCompletedBody;
  const refundId = refund?.id;
  if (typeof orderId !== "string" || !orderId || typeof refundId !== "string" || !refundId)
    return null;
  const statuses = Array.isArray(refund?.transactions)
    ? refund.transactions.map((transaction: { refundStatus?: unknown }) =>
        transaction?.refundStatus,
      )
    : [];
  // Complete means every transaction is final; anything short of all
  // SUCCEEDED (including a partial failure) needs a person to look.
  const succeeded = statuses.length > 0 && statuses.every((status) => status === "SUCCEEDED");
  const reason = refund?.details?.reason;
  return {
    orderId,
    refundId,
    refundStatus: succeeded ? "SUCCESS" : "FAILED",
    reason: typeof reason === "string" ? reason : null,
  };
}

export const WIX_REFUND_FAILED_REASON =
  "Wix reported that part or all of this refund failed. Check the order's payments in Wix before trying again; part of the refund may have gone through.";

// Records the final refund result on the matching Gooper return. Mirrors the
// Shopify refunds webhook: success never overwrites a failure or a record
// outside the refund stages; failure always lands.
//
// Wix can deliver this before the return flow has saved the refund's ID (the
// refund completes while our write is still in flight). Acknowledging then
// would lose the result, so when nothing matches and the refund looks like
// ours (its reason carries our reference, or a return on that order is still
// waiting for a refund ID), this throws and Wix retries. Anything else, such
// as a refund the merchant made in Wix, is acknowledged.
export async function recordWixRefundCompleted(
  db: Prisma.TransactionClient,
  shop: string,
  body: unknown,
) {
  const outcome = wixRefundOutcome(body);
  if (!outcome) return 0;
  const failed = outcome.refundStatus === "FAILED";
  const { count } = await db.agentReturn.updateMany({
    where: {
      shop,
      orderId: outcome.orderId,
      refundId: outcome.refundId,
      ...(failed
        ? {}
        : {
            status: { in: ["REFUND_SUBMITTED", "REFUND_RECORDED"] },
            OR: [{ refundStatus: null }, { refundStatus: { notIn: ["SUCCESS", "FAILED"] } }],
          }),
    },
    data: failed
      ? {
          status: "NEEDS_ATTENTION",
          refundStatus: "FAILED",
          failureReason: WIX_REFUND_FAILED_REASON,
        }
      : { status: "REFUND_RECORDED", refundStatus: "SUCCESS" },
  });
  if (count) return count;
  // Already recorded (a repeated success, or a result a failure beat to it).
  const known = await db.agentReturn.findFirst({
    where: { shop, orderId: outcome.orderId, refundId: outcome.refundId },
    select: { id: true },
  });
  if (known) return 0;
  const ours = outcome.reason?.includes(WIX_REFUND_REFERENCE_PREFIX);
  const waiting =
    ours ||
    (await db.agentReturn.findFirst({
      where: {
        shop,
        orderId: outcome.orderId,
        refundId: null,
        status: { in: REFUND_IN_FLIGHT_STATUSES },
      },
      select: { id: true },
    }));
  if (waiting) throw new WixRefundNotYetRecorded();
  return 0;
}
