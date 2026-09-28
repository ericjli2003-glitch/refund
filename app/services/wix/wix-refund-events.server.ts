import type { Prisma } from "@prisma/client";

// Wix refunds can finish after Refund Payments returns (transactions PENDING,
// SCHEDULED or STARTED). Wix sends wix.ecom.v1.order_transactions_refund_completed
// once every transaction in the refund has reached SUCCEEDED or FAILED; its
// action body is { orderId, refund: { id, transactions: [{ refundStatus }] }, ... }
// (per @wix/auto_sdk_ecom_order-transactions RefundCompleted).

type RefundCompletedBody = {
  orderId?: unknown;
  refund?: { id?: unknown; transactions?: unknown };
};

export type WixRefundOutcome = {
  orderId: string;
  refundId: string;
  refundStatus: "SUCCESS" | "FAILED";
};

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
  return { orderId, refundId, refundStatus: succeeded ? "SUCCESS" : "FAILED" };
}

export const WIX_REFUND_FAILED_REASON =
  "Wix reported that part or all of this refund failed. Check the order's payments in Wix before trying again; part of the refund may have gone through.";

// Records the final refund result on the matching Gooper return. Mirrors the
// Shopify refunds webhook: success never overwrites a failure or a record
// outside the refund stages; failure always lands.
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
  return count;
}
