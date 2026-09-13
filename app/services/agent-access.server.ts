import * as z from "zod/v4";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { normalizeShopDomain } from "./customer-account.server";
import {
  appOrigin,
  customerIdentityHashes,
  digest,
  randomToken,
  unseal,
} from "./customer-security.server";
import {
  verifiedLinksAllowed,
  type CustomerAccess,
} from "./verified-customer-returns.server";

export const agentScopes = [
  "returns:read",
  "returns:quote",
  "returns:submit",
] as const;
export type AgentScope = (typeof agentScopes)[number];

export class AgentAccessError extends Error {
  constructor(
    public readonly code: "invalid_token" | "insufficient_scope",
    public readonly requiredScope?: AgentScope,
  ) {
    super(
      code === "insufficient_scope"
        ? "The customer has not granted this assistant permission for this action."
        : "Customer-approved assistant access is required or has expired.",
    );
  }
}

// An all-stores connection asked for a store it hasn't linked, or whose link
// now needs the customer to sign in again. Linking the store again fixes both.
export class StoreLinkRequiredError extends Error {
  constructor(
    public readonly shop: string,
    public readonly reason: "not_linked" | "expired",
  ) {
    super(
      reason === "expired"
        ? `The link to ${shop} needs the customer to sign in again. Use link_store to renew it; if they're still signed in to that store, it's one click.`
        : `This connection isn't linked to ${shop} yet. Use link_store so the customer can sign in to that store.`,
    );
  }
}

export function agentResource(shop: string) {
  return new URL(`/mcp/${normalizeShopDomain(shop)}`, appOrigin()).href;
}

// One assistant connection covering every Refund store. It reaches a store's
// purchases only after the customer links that store with its own Shopify
// sign-in, because Shopify customer accounts are separate for every store.
export const allStoresResource = () => new URL("/mcp/stores", appOrigin()).href;
export const isAllStoresResource = (value: URL | string | null | undefined) =>
  (typeof value === "string" ? value : value?.href) === allStoresResource();

// A connection, and each of its store links, lasts while it's used and ends
// after a year without use.
export const CONNECTION_IDLE_MS = 365 * 86_400_000;
export const STORE_LINK_IDLE_MS = 365 * 86_400_000;
const LINK_USE_RECORD_INTERVAL_MS = 3_600_000;

export const storeLinkCustomerContext = (connectionId: string, shop: string) =>
  `store-link:${connectionId}:${shop}`;

const REFUND_ACCESS_TOKEN = /^Bearer (rfa_[A-Za-z0-9_-]{43})$/i;

const scopeListSchema = z
  .array(z.enum(agentScopes))
  .min(1)
  .max(agentScopes.length)
  .refine((values) => new Set(values).size === values.length);

const approvedGrantSchema = z
  .object({
    sessionId: z.string().min(1),
    shop: z.string(),
    clientId: z.string().trim().min(1).max(2048),
    resource: z.string().url(),
    scopes: scopeListSchema,
    customerApproved: z.literal(true),
  })
  .strict();

// Internal broker primitive, deliberately NOT exposed by an HTTP/tool route.
// The OAuth broker must validate the registered client, exact redirect,
// PKCE and resource, and obtain CSRF-protected consent for this client + scope
// set before calling this. Never pass a tool's "customerApproved" claim here.
export async function issueApprovedAgentGrant(
  input: unknown,
  now = Date.now(),
  db: Pick<
    Prisma.TransactionClient,
    "customerReturnSession" | "session" | "agentAccessGrant"
  > = prisma,
  issueRefreshToken = false,
) {
  const approved = approvedGrantSchema.parse(input);
  const shop = normalizeShopDomain(approved.shop);
  if (approved.resource !== agentResource(shop))
    throw new AgentAccessError("invalid_token");
  const session = await db.customerReturnSession.findUnique({
    where: { id: approved.sessionId },
  });
  const installed = await db.session.findFirst({
    where: { shop, isOnline: false },
    select: { id: true },
  });
  if (
    !installed ||
    !session ||
    session.shop !== shop ||
    !session.accessToken ||
    !session.customerSubjectHash ||
    session.expiresAt.getTime() <= now
  ) {
    throw new AgentAccessError("invalid_token");
  }
  const accessToken = `rfa_${randomToken()}`;
  const refreshToken = issueRefreshToken ? `rfr_${randomToken()}` : undefined;
  const expiresAt = new Date(
    Math.min(now + 60 * 60_000, session.expiresAt.getTime()),
  );
  await db.agentAccessGrant.create({
    data: {
      tokenHash: digest(accessToken),
      sessionId: session.id,
      shop,
      customerSubjectHash: session.customerSubjectHash,
      clientId: approved.clientId,
      resource: approved.resource,
      scopes: approved.scopes,
      expiresAt,
      refreshTokenHash: refreshToken ? digest(refreshToken) : null,
      refreshExpiresAt: refreshToken ? session.expiresAt : null,
    },
  });
  return {
    accessToken,
    refreshToken,
    expiresAt,
    refreshExpiresAt: refreshToken ? session.expiresAt : undefined,
    scopes: approved.scopes,
  };
}

const connectionGrantSchema = z
  .object({
    connectionId: z.string().uuid(),
    clientId: z.string().trim().min(1).max(2048),
    resource: z.string().url(),
    scopes: scopeListSchema,
  })
  .strict();

// Same broker contract as issueApprovedAgentGrant, for an approved all-stores
// connection. The grant carries no Shopify credential; store links do. Each
// grant, including every refresh, keeps the connection for another year.
export async function issueConnectionGrant(
  input: unknown,
  now = Date.now(),
  db: Pick<Prisma.TransactionClient, "agentConnection" | "agentAccessGrant"> = prisma,
  issueRefreshToken = false,
) {
  const approved = connectionGrantSchema.parse(input);
  if (!isAllStoresResource(approved.resource))
    throw new AgentAccessError("invalid_token");
  const connection = await db.agentConnection.findUnique({
    where: { id: approved.connectionId },
  });
  if (
    !connection ||
    connection.revokedAt ||
    connection.expiresAt.getTime() <= now ||
    connection.clientId !== approved.clientId ||
    approved.scopes.some((scope) => !connection.scopes.includes(scope))
  )
    throw new AgentAccessError("invalid_token");
  const connectionExpiresAt = new Date(now + CONNECTION_IDLE_MS);
  await db.agentConnection.update({
    where: { id: connection.id },
    data: { expiresAt: connectionExpiresAt },
  });
  const accessToken = `rfa_${randomToken()}`;
  const refreshToken = issueRefreshToken ? `rfr_${randomToken()}` : undefined;
  const expiresAt = new Date(now + 60 * 60_000);
  await db.agentAccessGrant.create({
    data: {
      tokenHash: digest(accessToken),
      connectionId: connection.id,
      clientId: approved.clientId,
      resource: approved.resource,
      scopes: approved.scopes,
      expiresAt,
      refreshTokenHash: refreshToken ? digest(refreshToken) : null,
      refreshExpiresAt: refreshToken ? connectionExpiresAt : null,
    },
  });
  return {
    accessToken,
    refreshToken,
    expiresAt,
    refreshExpiresAt: refreshToken ? connectionExpiresAt : undefined,
    scopes: approved.scopes,
  };
}

export async function authorizeAgent(
  authorization: string | null,
  shop: string,
  requiredScope?: AgentScope,
  now = Date.now(),
) {
  // Only Refund's opaque tokens are accepted, never Shopify access tokens,
  // browser cookies, intake links, ID tokens or signed return quotes.
  const token = authorization?.match(REFUND_ACCESS_TOKEN)?.[1];
  if (!token) throw new AgentAccessError("invalid_token");
  const grant = await prisma.agentAccessGrant.findUnique({
    where: { tokenHash: digest(token) },
    include: { session: true },
  });
  if (
    !grant ||
    // An all-stores grant never authorizes a single-store endpoint.
    grant.connectionId ||
    grant.revokedAt ||
    grant.expiresAt.getTime() <= now ||
    grant.shop !== shop ||
    grant.resource !== agentResource(shop) ||
    !grant.clientId ||
    !grant.scopes.length ||
    grant.scopes.some((scope) => !agentScopes.includes(scope as AgentScope)) ||
    !grant.session ||
    grant.session.shop !== shop ||
    grant.customerSubjectHash !== grant.session.customerSubjectHash ||
    !grant.session.customerSubjectHash ||
    !grant.session.accessToken ||
    grant.session.expiresAt.getTime() <= now
  ) {
    throw new AgentAccessError("invalid_token");
  }
  const installed = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    select: { id: true },
  });
  if (!installed) throw new AgentAccessError("invalid_token");
  if (requiredScope && !grant.scopes.includes(requiredScope)) {
    throw new AgentAccessError("insufficient_scope", requiredScope);
  }
  let customerToken: string;
  try {
    customerToken = unseal(
      grant.session.accessToken,
      `${grant.session.id}:${shop}`,
    );
  } catch {
    throw new AgentAccessError("invalid_token");
  }
  return {
    shop,
    customerToken,
    clientId: grant.clientId,
    sessionId: grant.session.id,
    customerSubjectHash: grant.session.customerSubjectHash,
    draftId: grant.session.draftId,
  };
}

// Authorizes an all-stores connection itself. Store access is a separate check
// (connectionStore), made for the specific store each tool call names.
export async function authorizeConnection(
  authorization: string | null,
  requiredScope?: AgentScope,
  now = Date.now(),
) {
  const token = authorization?.match(REFUND_ACCESS_TOKEN)?.[1];
  if (!token) throw new AgentAccessError("invalid_token");
  const grant = await prisma.agentAccessGrant.findUnique({
    where: { tokenHash: digest(token) },
    include: { connection: true },
  });
  if (
    !grant ||
    grant.revokedAt ||
    grant.expiresAt.getTime() <= now ||
    !grant.connection ||
    grant.connection.revokedAt ||
    grant.connection.expiresAt.getTime() <= now ||
    grant.connection.clientId !== grant.clientId ||
    !isAllStoresResource(grant.resource) ||
    !grant.scopes.length ||
    grant.scopes.some((scope) => !agentScopes.includes(scope as AgentScope))
  )
    throw new AgentAccessError("invalid_token");
  if (requiredScope && !grant.scopes.includes(requiredScope))
    throw new AgentAccessError("insufficient_scope", requiredScope);
  return {
    connectionId: grant.connection.id,
    clientId: grant.clientId,
    scopes: grant.scopes,
  };
}

type StoreLinkState = {
  connectionId: string;
  shop: string;
  customerSubjectHash: string;
  sealedCustomerId: string | null;
  lastUsedAt: Date;
  session: {
    id: string;
    shop: string;
    accessToken: string | null;
    customerSubjectHash: string | null;
    expiresAt: Date;
  } | null;
};

// How a store link reaches the customer's purchases right now: their live
// Shopify session while it lasts, which applies Shopify's own return rules;
// after that, the customer verified at link time, only where the store allows
// it; otherwise not at all, and the customer needs to sign in again.
export function storeLinkAccess(
  link: StoreLinkState,
  policy: Parameters<typeof verifiedLinksAllowed>[0],
  grantedScopes: string | null | undefined,
  now = Date.now(),
): CustomerAccess | null {
  if (now - link.lastUsedAt.getTime() > STORE_LINK_IDLE_MS) return null;
  const { session } = link;
  if (
    session &&
    session.shop === link.shop &&
    session.accessToken &&
    session.customerSubjectHash === link.customerSubjectHash &&
    session.expiresAt.getTime() > now
  ) {
    try {
      return unseal(session.accessToken, `${session.id}:${link.shop}`);
    } catch {
      // Fall back to the verified customer.
    }
  }
  if (!link.sealedCustomerId || !verifiedLinksAllowed(policy, grantedScopes))
    return null;
  try {
    const customerId = unseal(
      link.sealedCustomerId,
      storeLinkCustomerContext(link.connectionId, link.shop),
    );
    return customerIdentityHashes(customerId).includes(link.customerSubjectHash)
      ? { customerId }
      : null;
  } catch {
    return null;
  }
}

// The customer's access for one store linked to a connection.
export async function connectionStore(
  connectionId: string,
  shopInput: string,
  now = Date.now(),
) {
  const shop = normalizeShopDomain(shopInput);
  const [link, installed, policy] = await Promise.all([
    prisma.agentStoreLink.findUnique({
      where: { connectionId_shop: { connectionId, shop } },
      include: { session: true },
    }),
    prisma.session.findFirst({
      where: { shop, isOnline: false },
      select: { id: true, scope: true },
    }),
    prisma.storePolicy.findUnique({ where: { shop } }),
  ]);
  if (!installed) throw new Error(`${shop} no longer uses Refund.`);
  if (!link) throw new StoreLinkRequiredError(shop, "not_linked");
  const access = storeLinkAccess(link, policy, installed.scope, now);
  if (!access) throw new StoreLinkRequiredError(shop, "expired");
  if (now - link.lastUsedAt.getTime() > LINK_USE_RECORD_INTERVAL_MS)
    await prisma.agentStoreLink.updateMany({
      where: { id: link.id },
      data: { lastUsedAt: new Date(now) },
    });
  return {
    shop,
    customerToken: access,
    customerSubjectHash: link.customerSubjectHash,
    draftId: typeof access === "string" ? link.session?.draftId : null,
  };
}

export async function listConnectionStores(connectionId: string, now = Date.now()) {
  const links = await prisma.agentStoreLink.findMany({
    where: { connectionId },
    include: { session: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const shops = links.map((link) => link.shop);
  const [directory, policies, installs] = await Promise.all([
    prisma.merchantDirectory.findMany({
      where: { shop: { in: shops } },
      select: { shop: true, name: true },
    }),
    prisma.storePolicy.findMany({ where: { shop: { in: shops } } }),
    prisma.session.findMany({
      where: { shop: { in: shops }, isOnline: false },
      select: { shop: true, scope: true },
    }),
  ]);
  return links.map((link) => {
    const policy = policies.find((entry) => entry.shop === link.shop);
    const scope = installs.find((entry) => entry.shop === link.shop)?.scope;
    return {
      shop: link.shop,
      name: directory.find((entry) => entry.shop === link.shop)?.name ?? link.shop,
      active: Boolean(storeLinkAccess(link, policy, scope, now)),
      staysLinkedWithoutSignIn: Boolean(
        link.sealedCustomerId && verifiedLinksAllowed(policy, scope),
      ),
    };
  });
}

export async function assistantName(clientId: string) {
  const client = await prisma.agentOAuthClient.findUnique({
    where: { id: clientId },
  });
  if (!client) return "Assistant";
  try {
    const info = JSON.parse(
      unseal(client.sealedInformation, `agent-client:${clientId}`),
    ) as { client_name?: string };
    return info.client_name || "Assistant";
  } catch {
    return "Assistant";
  }
}

// Store links belong to the customer at that store, not to the sign-in that
// created them: any later sign-in to the same store can see and remove them.
async function customerStoreLinks(sessionId: string) {
  const owner = await prisma.customerReturnSession.findUnique({
    where: { id: sessionId },
    select: { shop: true, customerSubjectHash: true },
  });
  return owner?.customerSubjectHash
    ? { shop: owner.shop, customerSubjectHash: owner.customerSubjectHash }
    : null;
}

export async function revokeAgentGrant(publicId: string, sessionId: string) {
  // Session ownership is required even when the caller knows an identifier.
  // The identifier is either a single-store grant or an all-stores store link.
  const revoked = await prisma.agentAccessGrant.updateMany({
    where: { publicId, sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const owned = await customerStoreLinks(sessionId);
  const unlinked = owned
    ? await prisma.agentStoreLink.deleteMany({
        where: { id: publicId, ...owned },
      })
    : { count: 0 };
  return { count: revoked.count + unlinked.count };
}

export async function listAgentGrants(sessionId: string) {
  const owned = await customerStoreLinks(sessionId);
  const [grants, links] = await Promise.all([
    prisma.agentAccessGrant.findMany({
      where: { sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { publicId: true, clientId: true, scopes: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    owned
      ? prisma.agentStoreLink.findMany({
          where: owned,
          select: {
            id: true,
            lastUsedAt: true,
            sealedCustomerId: true,
            connection: { select: { clientId: true, scopes: true } },
            session: { select: { expiresAt: true } },
          },
          take: 100,
        })
      : [],
  ]);
  return Promise.all([
    ...grants.map(async (grant) => ({
      id: grant.publicId,
      name: await assistantName(grant.clientId),
      scopes: grant.scopes,
      expiresAt: grant.expiresAt.toISOString(),
    })),
    ...links.map(async (link) => ({
      id: link.id,
      name: `${await assistantName(link.connection.clientId)} (all-stores connection)`,
      scopes: link.connection.scopes,
      expiresAt: (link.sealedCustomerId
        ? new Date(link.lastUsedAt.getTime() + STORE_LINK_IDLE_MS)
        : (link.session?.expiresAt ?? link.lastUsedAt)
      ).toISOString(),
    })),
  ]);
}

export function agentChallenge(
  resourceMetadataUrl: string,
  error: AgentAccessError,
) {
  return (
    `Bearer resource_metadata="${resourceMetadataUrl}", error="${error.code}"` +
    (error.requiredScope ? `, scope="${error.requiredScope}"` : "")
  );
}
