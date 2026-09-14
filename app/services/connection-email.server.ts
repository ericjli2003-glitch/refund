import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import {
  customerIdentityHash,
  seal,
  unsealWithRotation,
} from "./customer-security.server";
import { adminData, adminFor, type AdminGraphql } from "./shopify-admin.server";
import { emailSubject } from "./verified-customer-returns.server";

export const connectionEmailContext = (connectionId: string) =>
  `connection-email:${connectionId}`;
export const storeLinkEmailContext = (connectionId: string, shop: string) =>
  `store-link-email:${connectionId}:${shop}`;

// Whether a store has an order placed with an email. Reading order emails
// needs Shopify's Level 2 protected customer data approval.
export type OrderEmailLookup = (shop: string, email: string) => Promise<boolean>;

const ORDERS_BY_EMAIL = `#graphql
  query OrdersForEmailCheck($query: String!) {
    orders(first: 5, query: $query) { nodes { id email } }
  }
`;

export async function hasOrdersForEmail(
  shop: string,
  email: string,
  admin?: AdminGraphql,
) {
  const client = admin ?? (await adminFor(shop));
  const { orders } = await adminData<{
    orders: { nodes: Array<{ id: string; email: string | null }> };
  }>(client, ORDERS_BY_EMAIL, { query: `email:"${email}"` }, "Shopify could not look up orders.");
  return orders.nodes.some((order) => order.email?.toLowerCase() === email);
}

export async function addConnectionEmail(
  db: Pick<Prisma.TransactionClient, "connectionEmail">,
  connectionId: string,
  email: string,
  source: "ONBOARDING" | "CHAT",
  sourceShop?: string,
) {
  const emailHash = customerIdentityHash(emailSubject(email));
  return db.connectionEmail.upsert({
    where: { connectionId_emailHash: { connectionId, emailHash } },
    create: {
      connectionId,
      emailHash,
      sealedEmail: seal(email, connectionEmailContext(connectionId)),
      source,
      sourceShop: sourceShop ?? null,
    },
    update: {},
  });
}

// Most recently confirmed first. Moved onto the current secret when read.
export async function listConnectionEmails(connectionId: string) {
  const rows = await prisma.connectionEmail.findMany({
    where: { connectionId },
    orderBy: { confirmedAt: "desc" },
    take: 20,
  });
  const context = connectionEmailContext(connectionId);
  const emails: Array<{
    id: string;
    email: string;
    emailHash: string;
    source: string;
    confirmedAt: Date;
  }> = [];
  for (const row of rows) {
    try {
      const opened = unsealWithRotation(row.sealedEmail, context);
      if (!opened.current)
        await prisma.connectionEmail
          .updateMany({
            where: { id: row.id },
            data: { sealedEmail: seal(opened.value, context) },
          })
          .catch(() => {});
      emails.push({
        id: row.id,
        email: opened.value,
        emailHash: row.emailHash,
        source: row.source,
        confirmedAt: row.confirmedAt,
      });
    } catch {
      // Unreadable once its secret is retired; it can't find orders anyway.
    }
  }
  return emails;
}

// Store links found through the email are removed with it.
export async function removeConnectionEmail(connectionId: string, emailId: string) {
  const { count } = await prisma.connectionEmail.deleteMany({
    where: { id: emailId, connectionId },
  });
  return { removed: count === 1 };
}

// One confirmation works at every store: looks for orders under the
// connection's confirmed emails and links the store to the first that has
// some. `only` limits the search to one address.
export async function linkStoreByConnectionEmail(
  connectionId: string,
  shop: string,
  lookup: OrderEmailLookup = hasOrdersForEmail,
  now = Date.now(),
  only?: string,
) {
  const emails = (await listConnectionEmails(connectionId)).filter(
    (entry) => !only || entry.email === only,
  );
  if (!emails.length) return { status: "no_emails" as const };
  for (const entry of emails) {
    let found: boolean;
    try {
      found = await lookup(shop, entry.email);
    } catch {
      return { status: "lookup_unavailable" as const };
    }
    if (!found) continue;
    const linkData = {
      verifiedBy: "EMAIL",
      customerSubjectHash: entry.emailHash,
      sealedEmail: seal(entry.email, storeLinkEmailContext(connectionId, shop)),
      connectionEmailId: entry.id,
      sealedCustomerId: null,
      sessionId: null,
      lastUsedAt: new Date(now),
    };
    const link = await prisma.agentStoreLink.upsert({
      where: { connectionId_shop: { connectionId, shop } },
      create: { connectionId, shop, ...linkData },
      update: { ...linkData, createdAt: new Date(now) },
      include: { session: true },
    });
    return { status: "linked" as const, link };
  }
  return { status: "no_match" as const };
}
