import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { processWebhookOnce } from "../services/webhook-reconciliation.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic, webhookId } =
    await authenticate.webhook(request);
  const refundId =
    typeof payload.admin_graphql_api_id === "string"
      ? payload.admin_graphql_api_id
      : null;

  await processWebhookOnce({
    webhookId,
    shop,
    topic: String(topic),
    process: async (transaction) => {
      if (!refundId) return;
      await transaction.agentReturn.updateMany({
        where: { shop, refundId },
        data: {
          status: "REFUND_RECORDED",
          refundStatus: "RECORDED",
        },
      });
    },
  });

  return new Response();
};
