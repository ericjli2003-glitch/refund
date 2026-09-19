import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { processWebhookOnce } from "../services/webhook-reconciliation.server";
import { flagFundedReturnChanges } from "../services/funded-shopify-return.server";

const returnStatusByTopic: Record<string, string> = {
  RETURNS_REQUEST: "REQUESTED",
  RETURNS_APPROVE: "OPEN",
  RETURNS_CANCEL: "CANCELLED",
  RETURNS_CLOSE: "CLOSED",
  RETURNS_DECLINE: "DECLINED",
  RETURNS_PROCESS: "PROCESSED",
  RETURNS_REOPEN: "OPEN",
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic, webhookId } =
    await authenticate.webhook(request);
  const normalizedTopic = String(topic);
  const returnId =
    typeof payload.admin_graphql_api_id === "string"
      ? payload.admin_graphql_api_id
      : null;
  const returnStatus =
    returnStatusByTopic[normalizedTopic] ??
    (typeof payload.status === "string" ? payload.status.toUpperCase() : null);

  await processWebhookOnce({
    webhookId,
    shop,
    topic: normalizedTopic,
    process: async (transaction) => {
      if (!returnId || !returnStatus) return;

      // A Gooper-funded return changed outside Gooper: record it for review.
      await flagFundedReturnChanges(transaction, shop, returnId, returnStatus);

      // A return waiting for its item that Shopify processes or closes outside
      // Gooper.io may already have been refunded there. Flag it so Retry refund
      // records that refund instead of the merchant refunding twice. Gooper.io's
      // own receipt processing holds the record in RECEIVING, so it is skipped.
      if (["PROCESSED", "CLOSED"].includes(returnStatus))
        await transaction.agentReturn.updateMany({
          where: { shop, returnId, status: "AWAITING_ITEM" },
          data: {
            status: "NEEDS_ATTENTION",
            failureReason:
              "Shopify processed this return outside Gooper.io while it waited for the item. Use Retry refund to record any refund, or check the order in Shopify.",
          },
        });

      const terminalFailure = ["CANCELLED", "DECLINED"].includes(returnStatus);
      await transaction.agentReturn.updateMany({
        where: { shop, returnId },
        data: {
          returnStatus,
          ...(terminalFailure
            ? {
                status: "NEEDS_ATTENTION",
                failureReason: `Shopify marked the return ${returnStatus.toLowerCase()}.`,
              }
            : {}),
        },
      });
    },
  });

  return new Response();
};
