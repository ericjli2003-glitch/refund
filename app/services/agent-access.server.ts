import * as z from "zod/v4";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { normalizeShopDomain } from "./customer-account.server";
import {
  appOrigin,
  digest,
  randomToken,
  unseal,
} from "./customer-security.server";

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

export function agentResource(shop: string) {
  return new URL(`/mcp/${normalizeShopDomain(shop)}`, appOrigin()).href;
}

const approvedGrantSchema = z
  .object({
    sessionId: z.string().min(1),
    shop: z.string(),
    clientId: z.string().trim().min(1).max(2048),
    resource: z.string().url(),
    scopes: z
      .array(z.enum(agentScopes))
      .min(1)
      .max(agentScopes.length)
      .refine((values) => new Set(values).size === values.length),
    customerApproved: z.literal(true),
  })
  .strict();

// Internal broker primitive, deliberately NOT exposed by an HTTP/tool route.
// The future OAuth broker must validate the registered client, exact redirect,
// PKCE and resource, and obtain CSRF-protected consent for this client + scope
// set before calling this. Never pass a tool's "customerApproved" claim here.
export async function issueApprovedAgentGrant(
  input: unknown,
  now = Date.now(),
  db: Pick<
    Prisma.TransactionClient,
    "customerReturnSession" | "session" | "agentAccessGrant"
  > = prisma,
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
    },
  });
  return { accessToken, expiresAt, scopes: approved.scopes };
}

export async function authorizeAgent(
  authorization: string | null,
  shop: string,
  requiredScope?: AgentScope,
  now = Date.now(),
) {
  // Only Refund's opaque tokens are accepted, never Shopify access tokens,
  // browser cookies, intake links, ID tokens or signed return quotes.
  const token = authorization?.match(/^Bearer (rfa_[A-Za-z0-9_-]{43})$/i)?.[1];
  if (!token) throw new AgentAccessError("invalid_token");
  const grant = await prisma.agentAccessGrant.findUnique({
    where: { tokenHash: digest(token) },
    include: { session: true },
  });
  if (
    !grant ||
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
      `${grant.sessionId}:${shop}`,
    );
  } catch {
    throw new AgentAccessError("invalid_token");
  }
  return {
    shop,
    customerToken,
    clientId: grant.clientId,
    sessionId: grant.sessionId,
    customerSubjectHash: grant.customerSubjectHash,
  };
}

export async function revokeAgentGrant(tokenHash: string, sessionId: string) {
  // Session ownership is required even when the caller knows a grant identifier.
  return prisma.agentAccessGrant.updateMany({
    where: { tokenHash, sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function listAgentGrants(sessionId: string) {
  const grants = await prisma.agentAccessGrant.findMany({
    where: { sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { tokenHash: true, clientId: true, scopes: true, expiresAt: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return Promise.all(
    grants.map(async (grant) => {
      const client = await prisma.agentOAuthClient.findUnique({
        where: { id: grant.clientId },
      });
      const info = client
        ? (JSON.parse(
            unseal(client.sealedInformation, `agent-client:${grant.clientId}`),
          ) as { client_name?: string })
        : null;
      return {
        id: grant.tokenHash,
        name: info?.client_name || "Assistant",
        scopes: grant.scopes,
        expiresAt: grant.expiresAt.toISOString(),
      };
    }),
  );
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
