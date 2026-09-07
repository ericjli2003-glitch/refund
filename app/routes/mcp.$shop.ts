import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createCustomerReturnsMcpServer } from "../mcp.server";
import { normalizeShopDomain } from "../services/customer-account.server";
import {
  AgentAccessError,
  agentChallenge,
  authorizeAgent,
} from "../services/agent-access.server";
import {
  appOrigin,
  privateHeaders,
} from "../services/customer-security.server";
import { readIntakeBody } from "../services/public-intake-http.server";

const corsHeaders = {
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "WWW-Authenticate, mcp-protocol-version",
};

function privateResponse(response: Response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries({
    ...privateHeaders,
    ...corsHeaders,
  })) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

async function handleMcpRequest(request: Request, shopParam: string) {
  if (request.method === "OPTIONS")
    return privateResponse(new Response(null, { status: 204 }));
  if (request.method !== "POST")
    return privateResponse(
      new Response("Use POST.", {
        status: 405,
        headers: { Allow: "POST, OPTIONS" },
      }),
    );
  let shop: string;
  try {
    shop = normalizeShopDomain(shopParam);
  } catch {
    return privateResponse(new Response("Invalid store.", { status: 400 }));
  }

  let server: ReturnType<typeof createCustomerReturnsMcpServer> | undefined;
  try {
    const resourceMetadataUrl = new URL(`/oauth/resource/${shop}`, appOrigin())
      .href;
    const authorization = request.headers.get("Authorization");
    try {
      await authorizeAgent(authorization, shop);
    } catch (error) {
      if (!(error instanceof AgentAccessError)) throw error;
      return privateResponse(
        Response.json(
          {
            error: error.code,
            message: error.message,
            continueUrl: new URL(`/returns/${shop}`, appOrigin()).href,
            note: "Browser sign-in does not grant remote assistant access. Remote OAuth connection is not available yet.",
          },
          {
            status: 401,
            headers: {
              "WWW-Authenticate": agentChallenge(resourceMetadataUrl, error),
            },
          },
        ),
      );
    }
    const parsedBody = await readIntakeBody(request, 65_536);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    server = createCustomerReturnsMcpServer({
      // Re-check consent, expiry and revocation at each tool invocation.
      authorize: (scope) => authorizeAgent(authorization, shop, scope),
      resourceMetadataUrl,
    });
    await server.connect(transport);
    return privateResponse(
      await transport.handleRequest(request, { parsedBody }),
    );
  } catch (error) {
    return privateResponse(
      error instanceof Response
        ? error
        : new Response("Assistant return access is unavailable.", {
            status: 503,
          }),
    );
  } finally {
    await server?.close();
  }
}

export const loader = ({ request, params }: LoaderFunctionArgs) =>
  handleMcpRequest(request, params.shop ?? "");
export const action = ({ request, params }: ActionFunctionArgs) =>
  handleMcpRequest(request, params.shop ?? "");
