import { randomUUID } from "node:crypto";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Prisma } from "@prisma/client";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import prisma from "../db.server";
import {
  agentScopes,
  authorizeAgent,
  authorizeConnection,
  isAllStoresResource,
  issueApprovedAgentGrant,
  issueConnectionGrant,
} from "./agent-access.server";
import {
  agentFlowCookie,
  assistantForRedirect,
  checkedScopes,
  shopFromAgentResource,
} from "./agent-oauth-flow.server";
import {
  appOrigin,
  digest,
  randomToken,
  seal,
  unsealWithRotation,
} from "./customer-security.server";

export function agentOAuthMetadata() {
  const issuer = appOrigin();
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...agentScopes],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}

async function revokeGrantChain(
  db: Pick<Prisma.TransactionClient, "agentAccessGrant">,
  firstTokenHash: string,
  revokedAt = new Date(),
) {
  let tokenHash: string | null = firstTokenHash;
  const visited = new Set<string>();
  while (tokenHash && visited.size < 100 && !visited.has(tokenHash)) {
    visited.add(tokenHash);
    const grant: { rotatedToTokenHash: string | null } | null =
      await db.agentAccessGrant.findUnique({
        where: { tokenHash },
        select: { rotatedToTokenHash: true },
      });
    if (!grant) break;
    await db.agentAccessGrant.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt },
    });
    tokenHash = grant.rotatedToTokenHash;
  }
}

export function createAgentOAuthProvider(): OAuthServerProvider {
  const provider: OAuthServerProvider = {
    clientsStore: {
      async getClient(id) {
        if (id.length > 128) return undefined;
        const row = await prisma.agentOAuthClient.findUnique({ where: { id } });
        if (!row) return undefined;
        const context = `agent-client:${id}`;
        const opened = unsealWithRotation(row.sealedInformation, context);
        // Registrations are durable: move them onto the current secret instead
        // of depending on a retired one indefinitely. Reading must not fail
        // just because that best-effort write did.
        if (!opened.current)
          await prisma.agentOAuthClient
            .update({
              where: { id },
              data: { sealedInformation: seal(opened.value, context) },
            })
            .catch(() => {});
        return JSON.parse(opened.value) as OAuthClientInformationFull;
      },
      async registerClient(input) {
        // Keep metadata failures distinct from persistence failures. Never echo
        // client metadata, secrets or database errors into a public response.
        if (!input.redirect_uris.length || input.redirect_uris.length > 5)
          throw new InvalidClientMetadataError(
            "[registration_redirect_count] Supply between one and five assistant callback URLs.",
          );
        let assistants: string[];
        try {
          assistants = input.redirect_uris.map(assistantForRedirect);
        } catch {
          throw new InvalidClientMetadataError(
            "[registration_callback] A callback URL is not an allowed hosted ChatGPT or Claude callback.",
          );
        }
        if (new Set(assistants).size !== 1)
          throw new InvalidClientMetadataError(
            "[registration_mixed_hosts] Register only one assistant host per client.",
          );
        if (
          input.token_endpoint_auth_method &&
          !["none", "client_secret_post"].includes(
            input.token_endpoint_auth_method,
          )
        )
          throw new InvalidClientMetadataError(
            "[registration_auth_method] Supported token authentication methods are none and client_secret_post.",
          );
        const requestedGrantTypes = input.grant_types || [
          "authorization_code",
          "refresh_token",
        ];
        if (
          new Set(requestedGrantTypes).size !== requestedGrantTypes.length ||
          !requestedGrantTypes.includes("authorization_code") ||
          requestedGrantTypes.some(
            (type) => !["authorization_code", "refresh_token"].includes(type),
          )
        )
          throw new InvalidClientMetadataError(
            "[registration_grant_type] authorization_code is required; refresh_token is the only optional additional grant.",
          );
        if (input.response_types?.some((type) => type !== "code"))
          throw new InvalidClientMetadataError(
            "[registration_response_type] Only the code response type is supported.",
          );
        if (input.scope) {
          try {
            checkedScopes(input.scope.split(" "));
          } catch {
            throw new InvalidClientMetadataError(
              "[registration_scopes] Use only returns:read, returns:quote and returns:submit, without duplicates.",
            );
          }
        }
        try {
          // Refuse unbounded client accumulation during the initial hosted rollout.
          if ((await prisma.agentOAuthClient.count()) >= 5000)
            throw new ServerError(
              "[registration_capacity] Refund cannot register more assistant clients at this time.",
            );
          const id = randomUUID();
          const client: OAuthClientInformationFull = {
            client_id: id,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            client_name: assistants[0],
            redirect_uris: [...new Set(input.redirect_uris)],
            token_endpoint_auth_method:
              input.token_endpoint_auth_method || "client_secret_post",
            ...(input.token_endpoint_auth_method === "none"
              ? {}
              : {
                  client_secret: input.client_secret || randomToken(),
                  client_secret_expires_at: 0,
                }),
            grant_types: [
              "authorization_code",
              ...(requestedGrantTypes.includes("refresh_token")
                ? ["refresh_token"]
                : []),
            ],
            response_types: ["code"],
            scope: agentScopes.join(" "),
          };
          await prisma.agentOAuthClient.create({
            data: {
              id,
              sealedInformation: seal(
                JSON.stringify(client),
                `agent-client:${id}`,
              ),
            },
          });
          return client;
        } catch (error) {
          if (error instanceof ServerError) throw error;
          throw new ServerError(
            "[registration_storage] Refund could not save the assistant registration. The service operator must check storage and encryption configuration.",
          );
        }
      },
    },
    async authorize(client, params, res) {
      // The resource is either one store's connection or the all-stores one.
      let shop: string | null = null;
      try {
        if (!isAllStoresResource(params.resource))
          shop = shopFromAgentResource(params.resource);
        assistantForRedirect(params.redirectUri);
        if (
          !client.redirect_uris.includes(params.redirectUri) ||
          !/^[\w-]{43}$/.test(params.codeChallenge) ||
          (params.state?.length || 0) > 2048
        )
          throw new Error();
      } catch {
        throw new InvalidRequestError(
          "Invalid merchant resource, callback or PKCE challenge.",
        );
      }
      let scopes: string[];
      try {
        scopes = checkedScopes(params.scopes);
      } catch {
        throw new InvalidScopeError("Unsupported Refund permissions.");
      }
      if (
        shop &&
        !(await prisma.session.findFirst({
          where: { shop, isOnline: false },
          select: { id: true },
        }))
      )
        throw new InvalidRequestError(
          "This merchant has not connected Refund.",
        );
      const rawId = randomToken();
      const id = digest(rawId);
      const browser = randomToken();
      await prisma.$transaction([
        prisma.agentOAuthRequest.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        }),
        prisma.agentOAuthRequest.create({
          data: {
            id,
            shop,
            clientId: client.client_id,
            resource: params.resource!.href,
            redirectUri: params.redirectUri,
            scopes,
            codeChallenge: params.codeChallenge,
            sealedState:
              params.state === undefined
                ? null
                : seal(params.state, `agent-oauth:${id}`),
            browserHash: digest(browser),
            csrfToken: randomToken(),
            expiresAt: new Date(Date.now() + 1200_000),
          },
        }),
      ]);
      res.append("Set-Cookie", await agentFlowCookie.serialize(browser));
      res.redirect(302, `${appOrigin()}/agent/authorize/${rawId}`);
    },
    async challengeForAuthorizationCode(client, code) {
      if (!/^[\w-]{43}$/.test(code))
        throw new InvalidGrantError("Invalid authorization code.");
      const flow = await prisma.agentOAuthRequest.findUnique({
        where: { codeHash: digest(code) },
      });
      if (
        !flow ||
        flow.clientId !== client.client_id ||
        !["APPROVED", "EXCHANGED"].includes(flow.status) ||
        !flow.codeExpiresAt ||
        flow.codeExpiresAt.getTime() <= Date.now() ||
        flow.expiresAt.getTime() <= Date.now()
      )
        throw new InvalidGrantError(
          "Authorization code expired or is invalid.",
        );
      return flow.codeChallenge;
    },
    async exchangeAuthorizationCode(
      client,
      code,
      _verifier,
      redirectUri,
      resource,
    ) {
      // SDK tokenHandler verified S256 PKCE immediately before this call.
      if (!/^[\w-]{43}$/.test(code))
        throw new InvalidGrantError("Invalid authorization code.");
      const result = await prisma.$transaction(async (tx) => {
        const flow = await tx.agentOAuthRequest.findUnique({
          where: { codeHash: digest(code) },
        });
        if (
          !flow ||
          flow.clientId !== client.client_id ||
          flow.redirectUri !== redirectUri ||
          flow.resource !== resource?.href ||
          !(flow.sessionId || flow.connectionId) ||
          !flow.codeExpiresAt ||
          flow.codeExpiresAt.getTime() <= Date.now() ||
          flow.expiresAt.getTime() <= Date.now()
        )
          throw new InvalidGrantError(
            "Authorization code does not match this exchange.",
          );
        const claim = await tx.agentOAuthRequest.updateMany({
          where: {
            id: flow.id,
            status: "APPROVED",
            codeExpiresAt: { gt: new Date() },
          },
          data: { status: "EXCHANGED" },
        });
        if (claim.count !== 1) {
          const used = await tx.agentOAuthRequest.findUnique({
            where: { id: flow.id },
          });
          if (used?.grantHash) await revokeGrantChain(tx, used.grantHash);
          return null; // Commit replay revocation; throw only outside transaction.
        }
        const refreshEnabled = Boolean(
          client.grant_types?.includes("refresh_token"),
        );
        const grant = flow.connectionId
          ? await issueConnectionGrant(
              {
                connectionId: flow.connectionId,
                clientId: flow.clientId,
                resource: flow.resource,
                scopes: flow.scopes,
              },
              Date.now(),
              tx,
              refreshEnabled,
            )
          : await issueApprovedAgentGrant(
              {
                sessionId: flow.sessionId,
                shop: flow.shop,
                clientId: flow.clientId,
                resource: flow.resource,
                scopes: flow.scopes,
                customerApproved: true,
              },
              Date.now(),
              tx,
              refreshEnabled,
            );
        await tx.agentOAuthRequest.update({
          where: { id: flow.id },
          data: { grantHash: digest(grant.accessToken) },
        });
        return {
          access_token: grant.accessToken,
          token_type: "Bearer",
          scope: grant.scopes.join(" "),
          expires_in: Math.max(
            1,
            Math.floor((grant.expiresAt.getTime() - Date.now()) / 1000),
          ),
          ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
        };
      });
      if (!result)
        throw new InvalidGrantError(
          "Authorization code was already exchanged. Start a new connection.",
        );
      return result;
    },
    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      if (
        !client.grant_types?.includes("refresh_token") ||
        !/^rfr_[A-Za-z0-9_-]{43}$/.test(refreshToken)
      )
        throw new InvalidGrantError("Invalid refresh token.");
      let requestedScopes: string[] | undefined;
      if (scopes) {
        try {
          requestedScopes = checkedScopes(scopes);
        } catch {
          throw new InvalidScopeError("Unsupported Refund permissions.");
        }
      }
      const result = await prisma.$transaction(async (tx) => {
        const now = new Date();
        const refreshTokenHash = digest(refreshToken);
        const grant = await tx.agentAccessGrant.findUnique({
          where: { refreshTokenHash },
          include: { session: true, connection: true },
        });
        if (!grant || grant.clientId !== client.client_id) return null;
        if (grant.revokedAt) {
          if (grant.rotatedToTokenHash)
            await revokeGrantChain(tx, grant.rotatedToTokenHash, now);
          return null;
        }
        // A connection grant stays refreshable for the connection's lifetime;
        // a single-store grant only while its customer session lasts.
        const stillValid = grant.connection
          ? !grant.connection.revokedAt &&
            grant.connection.expiresAt.getTime() > now.getTime()
          : Boolean(
              grant.session &&
                grant.session.shop === grant.shop &&
                grant.customerSubjectHash === grant.session.customerSubjectHash &&
                grant.session.customerSubjectHash &&
                grant.session.accessToken &&
                grant.session.expiresAt.getTime() > now.getTime(),
            );
        if (
          !grant.refreshExpiresAt ||
          grant.refreshExpiresAt.getTime() <= now.getTime() ||
          (resource && resource.href !== grant.resource) ||
          !stillValid
        )
          return null;
        const nextScopes = requestedScopes || grant.scopes;
        if (nextScopes.some((scope) => !grant.scopes.includes(scope)))
          throw new InvalidScopeError(
            "Refresh cannot add permissions that the customer did not approve.",
          );
        const claim = await tx.agentAccessGrant.updateMany({
          where: {
            tokenHash: grant.tokenHash,
            revokedAt: null,
            refreshTokenHash,
            refreshExpiresAt: { gt: now },
          },
          data: { revokedAt: now },
        });
        if (claim.count !== 1) {
          const used = await tx.agentAccessGrant.findUnique({
            where: { tokenHash: grant.tokenHash },
          });
          if (used?.rotatedToTokenHash)
            await revokeGrantChain(tx, used.rotatedToTokenHash, now);
          return null;
        }
        const next = grant.connectionId
          ? await issueConnectionGrant(
              {
                connectionId: grant.connectionId,
                clientId: grant.clientId,
                resource: grant.resource,
                scopes: nextScopes,
              },
              now.getTime(),
              tx,
              true,
            )
          : await issueApprovedAgentGrant(
              {
                sessionId: grant.sessionId,
                shop: grant.shop,
                clientId: grant.clientId,
                resource: grant.resource,
                scopes: nextScopes,
                customerApproved: true,
              },
              now.getTime(),
              tx,
              true,
            );
        await tx.agentAccessGrant.update({
          where: { tokenHash: grant.tokenHash },
          data: { rotatedToTokenHash: digest(next.accessToken) },
        });
        return {
          access_token: next.accessToken,
          refresh_token: next.refreshToken!,
          token_type: "Bearer" as const,
          scope: next.scopes.join(" "),
          expires_in: Math.max(
            1,
            Math.floor((next.expiresAt.getTime() - Date.now()) / 1000),
          ),
        };
      });
      if (!result) throw new InvalidGrantError("Invalid refresh token.");
      return result;
    },
    async verifyAccessToken(token) {
      const grant = await prisma.agentAccessGrant.findUnique({
        where: { tokenHash: digest(token) },
      });
      if (!grant) throw new InvalidGrantError("Invalid access token.");
      if (grant.connectionId) await authorizeConnection(`Bearer ${token}`);
      else await authorizeAgent(`Bearer ${token}`, grant.shop ?? "");
      return {
        token,
        clientId: grant.clientId,
        scopes: grant.scopes,
        expiresAt: Math.floor(grant.expiresAt.getTime() / 1000),
        resource: new URL(grant.resource),
      };
    },
    async revokeToken(client, request) {
      await prisma.$transaction(async (tx) => {
        const tokenHash = digest(request.token);
        const grant = await tx.agentAccessGrant.findFirst({
          where: {
            clientId: client.client_id,
            OR: [{ tokenHash }, { refreshTokenHash: tokenHash }],
          },
          select: { tokenHash: true },
        });
        if (grant) await revokeGrantChain(tx, grant.tokenHash);
      });
    },
  };
  return provider;
}
