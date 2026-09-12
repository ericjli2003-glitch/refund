import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { processWebhookOnce } from "../services/webhook-reconciliation.server";
import { refundPaymentStatus } from "../refund-status";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic, webhookId } =
    await authenticate.webhook(request);
  const refundId =
    typeof payload.admin_graphql_api_id === "string"
      ? payload.admin_graphql_api_id
      : null;
  const paymentStatus = refundPaymentStatus(
    Array.isArray(payload.transactions)
      ? payload.transactions.map((item: { kind?: string; status?: string }) => ({
          kind: typeof item.kind === "string" ? item.kind : "",
          status: typeof item.status === "string" ? item.status : "",
        }))
      : [],
  );

  await processWebhookOnce({
    webhookId,
    shop,
    topic: String(topic),
    process: async (transaction) => {
      if (!refundId) return;
      await transaction.agentReturn.updateMany({
        where: {
          shop,
          refundId,
          // A record-creation event must not clear a failed payment or a
          // cancelled return, nor regress stronger payment evidence.
          ...(paymentStatus === "FAILED" ? {} : {
            status: { in: ["REFUND_SUBMITTED", "REFUND_RECORDED"] },
            OR: [
              { refundStatus: null },
              { refundStatus: { notIn: paymentStatus === "UNKNOWN"
                ? ["SUCCESS", "FAILED", "PENDING"] : ["SUCCESS", "FAILED"] } },
            ],
          }),
        },
        data: {
          status: paymentStatus === "FAILED" ? "NEEDS_ATTENTION" : "REFUND_RECORDED",
          refundStatus: paymentStatus,
          ...(paymentStatus === "FAILED" ? {
            failureReason: "Shopify reported a failed refund transaction. Check all payments before retrying; part of the refund may have succeeded.",
          } : {}),
        },
      });
    },
  });

  return new Response();
};
