import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createCustomerReturnsMcpServer } from "../mcp.server";
import { normalizeShopDomain } from "../services/customer-account.server";
import {
  AgentAccessError,
  agentChallenge,
  authorizeAgent,
  agentScopes,
  type AgentScope,
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
    let parsedBody: unknown;
    try {
      await authorizeAgent(authorization, shop);
      parsedBody = await readIntakeBody(request, 65_536);
      const call = parsedBody as {
        method?: string;
        params?: { name?: string };
      } | null;
      const scopesByTool: Record<string, AgentScope> = {
        find_returnable_items: "returns:read",
        quote_return: "returns:quote",
        confirm_return: "returns:submit",
      };
      if (
        call?.method === "tools/call" &&
        typeof call.params?.name === "string" &&
        Object.hasOwn(scopesByTool, call.params.name)
      )
        await authorizeAgent(
          authorization,
          shop,
          scopesByTool[call.params.name],
        );
    } catch (error) {
      if (!(error instanceof AgentAccessError)) throw error;
      return privateResponse(
        Response.json(
          {
            error: error.code,
            message: error.message,
            continueUrl: new URL(`/returns/${shop}`, appOrigin()).href,
            note: "Complete Shopify sign-in and assistant consent through the OAuth connection. No return has been submitted.",
          },
          {
            status: error.code === "insufficient_scope" ? 403 : 401,
            headers: {
              "WWW-Authenticate":
                agentChallenge(resourceMetadataUrl, error) +
                (error.requiredScope
                  ? ""
                  : `, scope="${agentScopes.join(" ")}"`),
            },
          },
        ),
      );
    }
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
