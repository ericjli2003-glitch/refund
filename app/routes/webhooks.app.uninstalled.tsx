import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.$transaction([
      db.agentReturn.deleteMany({ where: { shop } }),
      db.privacyRequest.deleteMany({ where: { shop } }),
      db.webhookReceipt.deleteMany({ where: { shop } }),
      db.storePolicy.deleteMany({ where: { shop } }),
      db.session.deleteMany({ where: { shop } }),
    ]);
  }

  return new Response();
};
