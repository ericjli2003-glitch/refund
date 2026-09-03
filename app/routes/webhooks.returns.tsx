import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { processWebhookOnce } from "../services/webhook-reconciliation.server";

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
