import { randomUUID } from "node:crypto";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  UnsupportedGrantTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import prisma from "../db.server";
import {
  agentScopes,
  authorizeAgent,
  issueApprovedAgentGrant,
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
  unseal,
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
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...agentScopes],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}

export function createAgentOAuthProvider(): OAuthServerProvider {
  const provider: OAuthServerProvider = {
    clientsStore: {
      async getClient(id) {
        if (id.length > 128) return undefined;
        const row = await prisma.agentOAuthClient.findUnique({ where: { id } });
        return row
          ? (JSON.parse(
              unseal(row.sealedInformation, `agent-client:${id}`),
            ) as OAuthClientInformationFull)
          : undefined;
      },
      async registerClient(input) {
        try {
          if (!input.redirect_uris.length || input.redirect_uris.length > 5)
            throw new Error();
          const assistants = input.redirect_uris.map(assistantForRedirect);
          if (new Set(assistants).size !== 1) throw new Error();
          if (
            input.token_endpoint_auth_method &&
            !["none", "client_secret_post"].includes(
              input.token_endpoint_auth_method,
            )
          )
            throw new Error();
          if (
            input.grant_types?.some((type) => type !== "authorization_code") ||
            input.response_types?.some((type) => type !== "code")
          )
            throw new Error();
          if (input.scope) checkedScopes(input.scope.split(" "));
          // Refuse unbounded client accumulation during the initial hosted rollout.
          if ((await prisma.agentOAuthClient.count()) >= 5000)
            throw new Error();
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
            grant_types: ["authorization_code"],
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
        } catch {
          throw new InvalidClientMetadataError(
            "Use a documented ChatGPT or hosted Claude callback and the authorization-code flow.",
          );
        }
      },
    },
    async authorize(client, params, res) {
      let shop: string;
      try {
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
          !flow.sessionId ||
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
          if (used?.grantHash)
            await tx.agentAccessGrant.updateMany({
              where: { tokenHash: used.grantHash },
              data: { revokedAt: new Date() },
            });
          return null; // Commit replay revocation; throw only outside transaction.
        }
        const grant = await issueApprovedAgentGrant(
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
        };
      });
      if (!result)
        throw new InvalidGrantError(
          "Authorization code was already exchanged. Start a new connection.",
        );
      return result;
    },
    async exchangeRefreshToken() {
      throw new UnsupportedGrantTypeError(
        "Reconnect your assistant when access expires. Refresh tokens are not issued.",
      );
    },
    async verifyAccessToken(token) {
      const grant = await prisma.agentAccessGrant.findUnique({
        where: { tokenHash: digest(token) },
      });
      if (!grant) throw new InvalidGrantError("Invalid access token.");
      await authorizeAgent(`Bearer ${token}`, grant.shop);
      return {
        token,
        clientId: grant.clientId,
        scopes: grant.scopes,
        expiresAt: Math.floor(grant.expiresAt.getTime() / 1000),
        resource: new URL(grant.resource),
      };
    },
    async revokeToken(client, request) {
      await prisma.agentAccessGrant.updateMany({
        where: { tokenHash: digest(request.token), clientId: client.client_id },
        data: { revokedAt: new Date() },
      });
    },
  };
  return provider;
}
