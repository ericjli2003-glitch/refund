import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { customerIdentityHashes } from "../services/customer-security.server";

function customerIdFromPayload(payload: Record<string, unknown>) {
  const customer = payload.customer;
  if (!customer || typeof customer !== "object" || !("id" in customer)) {
    return null;
  }

  const id = customer.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic, webhookId } =
    await authenticate.webhook(request);
  const numericCustomerId = customerIdFromPayload(payload);
  // Match every configured secret so records hashed before a rotation are
  // still redacted and reported, not silently missed.
  const subjectHashes = numericCustomerId
    ? customerIdentityHashes(
        numericCustomerId.startsWith("gid://shopify/Customer/")
          ? numericCustomerId
          : `gid://shopify/Customer/${numericCustomerId}`,
      )
    : [];
  const customerSubjectHash = { in: subjectHashes };

  if (topic === "CUSTOMERS_REDACT") {
    if (!subjectHashes.length) {
      throw new Error(
        "Customer redaction payload is missing a usable identity.",
      );
    }
    // Deleting the customer's sessions also removes their assistant grants and
    // all-stores store links, which reference those sessions.
    await prisma.$transaction([
      prisma.customerReturnSession.deleteMany({
        where: { shop, customerSubjectHash },
      }),
      prisma.returnDraft.deleteMany({ where: { shop, customerSubjectHash } }),
      prisma.agentReturn.deleteMany({ where: { shop, customerSubjectHash } }),
      prisma.privacyRequest.deleteMany({
        where: { shop, customerSubjectHash },
      }),
    ]);
  }

  if (topic === "CUSTOMERS_DATA_REQUEST") {
    if (!subjectHashes.length) {
      throw new Error("Customer data request is missing a usable identity.");
    }
    const records = await prisma.agentReturn.findMany({
      where: { shop, customerSubjectHash },
      select: {
        orderId: true,
        orderName: true,
        returnId: true,
        refundId: true,
        status: true,
        returnStatus: true,
        refundStatus: true,
        amount: true,
        currencyCode: true,
        requestedLineItems: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const drafts = await prisma.returnDraft.findMany({
      where: { shop, customerSubjectHash },
      select: {
        id: true,
        stage: true,
        orderId: true,
        orderName: true,
        selectedItems: true,
        quoteSnapshot: true,
        quoteExpiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const returns = records.map((record) => ({
      ...record,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    }));
    const grants = await prisma.agentAccessGrant.findMany({
      where: { shop, customerSubjectHash },
      select: {
        clientId: true,
        resource: true,
        scopes: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    const authorizations = await prisma.agentOAuthRequest.findMany({
      where: { shop, session: { customerSubjectHash } },
      select: {
        clientId: true,
        resource: true,
        scopes: true,
        status: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    const storeLinks = await prisma.agentStoreLink.findMany({
      where: { shop, session: { customerSubjectHash } },
      select: {
        createdAt: true,
        connection: { select: { clientId: true, scopes: true } },
        session: { select: { expiresAt: true } },
      },
    });
    const reportData = {
      returns,
      returnDrafts: drafts.map((value) => ({
        ...value,
        quoteExpiresAt: value.quoteExpiresAt?.toISOString() ?? null,
        createdAt: value.createdAt.toISOString(),
        updatedAt: value.updatedAt.toISOString(),
      })),
      assistantAuthorizations: authorizations.map((value) => ({
        ...value,
        createdAt: value.createdAt.toISOString(),
        expiresAt: value.expiresAt.toISOString(),
      })),
      assistantAccess: grants.map((grant) => ({
        ...grant,
        createdAt: grant.createdAt.toISOString(),
        expiresAt: grant.expiresAt.toISOString(),
        revokedAt: grant.revokedAt?.toISOString() ?? null,
      })),
      assistantStoreLinks: storeLinks.map((link) => ({
        clientId: link.connection.clientId,
        scopes: link.connection.scopes,
        createdAt: link.createdAt.toISOString(),
        expiresAt: link.session.expiresAt.toISOString(),
      })),
    };
    await prisma.privacyRequest.upsert({
      where: { id: webhookId },
      create: {
        id: webhookId,
        shop,
        type: String(topic),
        customerSubjectHash: subjectHashes[0],
        reportData,
      },
      update: { reportData },
    });
  }

  if (topic === "SHOP_REDACT") {
    await prisma.$transaction([
      prisma.merchantOpportunity.deleteMany({ where: { knownShop: shop } }),
      prisma.merchantDirectory.deleteMany({ where: { shop } }),
      prisma.agentStoreLinkRequest.deleteMany({ where: { shop } }),
      prisma.customerReturnSession.deleteMany({ where: { shop } }),
      prisma.returnDraft.deleteMany({ where: { shop } }),
      prisma.agentOAuthRequest.deleteMany({ where: { shop } }),
      prisma.agentReturn.deleteMany({ where: { shop } }),
      prisma.privacyRequest.deleteMany({ where: { shop } }),
      prisma.webhookReceipt.deleteMany({ where: { shop } }),
      prisma.storePolicy.deleteMany({ where: { shop } }),
      prisma.session.deleteMany({ where: { shop } }),
    ]);
  }

  return new Response();
};
