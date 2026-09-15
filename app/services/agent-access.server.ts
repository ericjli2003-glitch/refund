import * as z from "zod/v4";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { normalizeShopDomain } from "./customer-account.server";
import {
  appOrigin,
  customerIdentityHashes,
  digest,
  randomToken,
  seal,
  unseal,
  unsealWithRotation,
} from "./customer-security.server";
import {
  emailSubject,
  verifiedLinksAllowed,
  type CustomerAccess,
} from "./verified-customer-returns.server";
import {
  linkStoreByConnectionEmail,
  storeLinkEmailContext,
  type OrderEmailLookup,
} from "./connection-email.server";

export { storeLinkEmailContext };

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
// stopped working. Linking the store again fixes both, unless the store isn't
// set up for returns through assistants.
export class StoreLinkRequiredError extends Error {
  constructor(
    public readonly shop: string,
    public readonly reason:
      | "not_linked"
      | "expired"
      | "email_not_found"
      | "store_not_ready",
  ) {
    super(
      reason === "store_not_ready"
        ? `${shop} hasn't set up returns through assistants yet, so this one can't be done in chat. Let the customer know kindly, and suggest the store's own returns page or reaching out to the store. Nothing was submitted.`
        : reason === "email_not_found"
          ? `None of the emails the customer confirmed has an order at ${shop}. Ask warmly, something like "Did you use a different email for that one?", and call link_store with it.`
          : reason === "expired"
            ? `The link to ${shop} stopped working. Use link_store to connect it again; it usually needs nothing from the customer.`
            : `This connection isn't linked to ${shop} yet. Use link_store to connect it; it only takes the customer a moment.`,
    );
  }
}

export function agentResource(shop: string) {
  return new URL(`/mcp/${normalizeShopDomain(shop)}`, appOrigin()).href;
}

// One assistant connection covering every Gooper.io store. It reaches a store's
// purchases through the emails the customer confirmed.
export const allStoresResource = () => new URL("/mcp/stores", appOrigin()).href;

// Every Gooper.io MCP address opens the same connection to the whole network:
// /mcp/stores, and store addresses (/mcp/<shop>) saved from earlier setup
// pages, which reach every store too.
export function isConnectionResource(value: URL | string | null | undefined) {
  const href = typeof value === "string" ? value : value?.href;
  if (!href) return false;
  if (href === allStoresResource()) return true;
  const prefix = `${appOrigin()}/mcp/`;
  const shop = href.startsWith(prefix) ? href.slice(prefix.length) : "";
  try {
    return Boolean(shop) && agentResource(shop) === href;
  } catch {
    return false;
  }
}

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

const connectionGrantSchema = z
  .object({
    connectionId: z.string().uuid(),
    clientId: z.string().trim().min(1).max(2048),
    resource: z.string().url(),
    scopes: scopeListSchema,
  })
  .strict();

// Internal broker primitive, deliberately not exposed by an HTTP or tool
// route. The OAuth broker validates the registered client, exact redirect,
// PKCE, resource and CSRF-protected consent before calling this. The grant
// carries no Shopify credential; store links do. Each grant, including every
// refresh, keeps the connection for another year.
export async function issueConnectionGrant(
  input: unknown,
  now = Date.now(),
  db: Pick<Prisma.TransactionClient, "agentConnection" | "agentAccessGrant"> = prisma,
  issueRefreshToken = false,
) {
  const approved = connectionGrantSchema.parse(input);
  if (!isConnectionResource(approved.resource))
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

// Authorizes a connection itself. Only Gooper.io's opaque tokens are accepted,
// never Shopify access tokens, browser cookies, intake links, ID tokens or
// signed return quotes; grants from retired single-store connections have no
// connection and open nothing. Store access is a separate check
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
    !isConnectionResource(grant.resource) ||
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
  verifiedBy: string;
  sealedCustomerId: string | null;
  sealedEmail: string | null;
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
// it; otherwise not at all.
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
  if (!verifiedLinksAllowed(policy, grantedScopes)) return null;
  try {
    if (link.verifiedBy === "EMAIL") {
      if (!link.sealedEmail) return null;
      const email = unseal(
        link.sealedEmail,
        storeLinkEmailContext(link.connectionId, link.shop),
      );
      return customerIdentityHashes(emailSubject(email)).includes(
        link.customerSubjectHash,
      )
        ? { email }
        : null;
    }
    if (!link.sealedCustomerId) return null;
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
  lookup?: OrderEmailLookup,
) {
  const shop = normalizeShopDomain(shopInput);
  const [existing, installed, policy] = await Promise.all([
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
  if (!installed) throw new Error(`${shop} no longer uses Gooper.io.`);
  let link = existing;
  let access = link ? storeLinkAccess(link, policy, installed.scope, now) : null;
  if (!access) {
    // Customers connect stores only by email, which needs the store's
    // confirmed return rules; there's no Shopify sign-in to fall back on.
    if (!verifiedLinksAllowed(policy, installed.scope))
      throw new StoreLinkRequiredError(shop, "store_not_ready");
    // One confirmation works at every store: look for orders under the emails
    // this connection confirmed, with nothing for the customer to do.
    const found = await linkStoreByConnectionEmail(connectionId, shop, lookup, now);
    if (found.status === "linked") {
      link = found.link;
      access = storeLinkAccess(found.link, policy, installed.scope, now);
    } else if (found.status === "no_match")
      throw new StoreLinkRequiredError(shop, "email_not_found");
  }
  if (!link || !access)
    throw new StoreLinkRequiredError(shop, existing ? "expired" : "not_linked");
  // A link can last years while used; move its customer ID onto the current
  // secret so retiring an old secret never silently breaks it.
  let reseal: { sealedCustomerId?: string; sealedEmail?: string } = {};
  if (typeof access !== "string" && "customerId" in access && link.sealedCustomerId) {
    const context = storeLinkCustomerContext(connectionId, shop);
    if (!unsealWithRotation(link.sealedCustomerId, context).current)
      reseal = { sealedCustomerId: seal(access.customerId, context) };
  }
  if (typeof access !== "string" && "email" in access && link.sealedEmail) {
    const context = storeLinkEmailContext(connectionId, shop);
    if (!unsealWithRotation(link.sealedEmail, context).current)
      reseal = { sealedEmail: seal(access.email, context) };
  }
  if (
    now - link.lastUsedAt.getTime() > LINK_USE_RECORD_INTERVAL_MS ||
    Object.keys(reseal).length > 0
  )
    await prisma.agentStoreLink.updateMany({
      where: { id: link.id },
      data: { lastUsedAt: new Date(now), ...reseal },
    });
  return {
    shop,
    customerToken: access,
    customerSubjectHash: link.customerSubjectHash,
    draftId: typeof access === "string" ? link.session?.draftId : null,
  };
}

// Ends an all-stores connection outright: every grant it issued stops working,
// and its store links, link requests and confirmed emails are deleted.
export async function endConnection(
  db: Pick<
    Prisma.TransactionClient,
    | "agentConnection"
    | "agentAccessGrant"
    | "agentStoreLink"
    | "agentStoreLinkRequest"
    | "connectionEmail"
  >,
  connectionId: string,
  revokedAt = new Date(),
) {
  await db.agentConnection.updateMany({
    where: { id: connectionId, revokedAt: null },
    data: { revokedAt },
  });
  await db.agentAccessGrant.updateMany({
    where: { connectionId, revokedAt: null },
    data: { revokedAt },
  });
  await db.agentStoreLink.deleteMany({ where: { connectionId } });
  await db.agentStoreLinkRequest.deleteMany({ where: { connectionId } });
  await db.connectionEmail.deleteMany({ where: { connectionId } });
}

// Revoked connections are kept a day so a late replayed token still finds its
// connection revoked rather than missing.
const REVOKED_CONNECTION_RETENTION_MS = 86_400_000;

// Deletes access that can no longer be used, so nothing is kept longer than
// needed: ended connections (with their grants, store links and link
// requests), store links unused for a year, and expired sign-ins, grants and
// authorization requests. Runs with background maintenance.
export async function pruneExpiredCustomerAccess(now = Date.now()) {
  const current = new Date(now);
  await prisma.$transaction([
    prisma.agentConnection.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: current } },
          { revokedAt: { lt: new Date(now - REVOKED_CONNECTION_RETENTION_MS) } },
        ],
      },
    }),
    prisma.agentStoreLink.deleteMany({
      where: { lastUsedAt: { lt: new Date(now - STORE_LINK_IDLE_MS) } },
    }),
    prisma.agentStoreLinkRequest.deleteMany({
      where: { expiresAt: { lt: current } },
    }),
    prisma.agentOAuthRequest.deleteMany({ where: { expiresAt: { lt: current } } }),
    // Kept an hour past expiry so email sending stays rate limited.
    prisma.emailVerification.deleteMany({
      where: { expiresAt: { lt: new Date(now - 3_600_000) } },
    }),
    prisma.agentAccessGrant.deleteMany({
      where: {
        expiresAt: { lt: current },
        OR: [{ refreshExpiresAt: null }, { refreshExpiresAt: { lt: current } }],
      },
    }),
    prisma.customerReturnSession.deleteMany({
      where: { expiresAt: { lt: current } },
    }),
  ]);
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
      linkedWith: link.verifiedBy === "EMAIL" ? "email" : "shopify",
      staysLinkedWithoutSignIn: Boolean(
        (link.sealedCustomerId || link.sealedEmail) &&
          verifiedLinksAllowed(policy, scope),
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
            sealedEmail: true,
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
      expiresAt: (link.sealedCustomerId || link.sealedEmail
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
