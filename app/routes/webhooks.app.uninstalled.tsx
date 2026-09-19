import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Deletions are idempotent, including when Shopify retries after the session
  // was removed by an earlier delivery.
  await db.$transaction([
    db.merchantOpportunity.deleteMany({ where: { knownShop: shop } }),
    db.merchantDirectory.deleteMany({ where: { shop } }),
    db.agentStoreLinkRequest.deleteMany({ where: { shop } }),
    db.agentStoreLink.deleteMany({ where: { shop } }),
    db.emailVerification.deleteMany({ where: { shop } }),
    // Emails confirmed in a chat about this store; setup emails are the
    // customer's own and stay with their connection.
    db.connectionEmail.deleteMany({ where: { sourceShop: shop } }),
    db.customerReturnSession.deleteMany({ where: { shop } }),
    db.returnDraft.deleteMany({ where: { shop } }),
    db.agentOAuthRequest.deleteMany({ where: { shop } }),
    db.agentReturn.deleteMany({ where: { shop } }),
    db.fundedReturnSandbox.deleteMany({ where: { shop } }),
    db.fundedPaymentEvent.deleteMany({ where: { shop } }),
    db.fundedPaymentIntent.deleteMany({ where: { shop } }),
    db.fundedSandboxProviderPayment.deleteMany({ where: { shop } }),
    db.fundedEntitlement.deleteMany({ where: { shop } }),
    db.privacyRequest.deleteMany({ where: { shop } }),
    db.webhookReceipt.deleteMany({ where: { shop } }),
    db.storePolicy.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
