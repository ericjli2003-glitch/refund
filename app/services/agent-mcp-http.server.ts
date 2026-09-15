import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  AgentAccessError,
  agentChallenge,
  agentScopes,
  type AgentScope,
} from "./agent-access.server";
import { privateHeaders } from "./customer-security.server";
import { readIntakeBody } from "./public-intake-http.server";

export const returnToolScopes: Record<string, AgentScope> = {
  get_return_session: "returns:read",
  check_return_status: "returns:read",
  find_returnable_items: "returns:read",
  quote_return: "returns:quote",
  confirm_return: "returns:submit",
  add_return_tracking: "returns:submit",
};

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

export type AgentMcpEndpoint = {
  resourceMetadataUrl: string;
  continueUrl: string;
  note: string;
  scopesByTool: Record<string, AgentScope>;
  authorize: (authorization: string | null, scope?: AgentScope) => Promise<unknown>;
  createServer: (authorization: string | null) => McpServer;
};

// Every request needs a Gooper.io access token, and a tool call is also checked
// against that tool's permission before the MCP server runs it, so hosts get
// an HTTP challenge rather than only a tool error.
export async function handleAgentMcp(
  request: Request,
  endpoint: () => AgentMcpEndpoint | Response,
) {
  if (request.method === "OPTIONS")
    return privateResponse(new Response(null, { status: 204 }));
  if (request.method !== "POST")
    return privateResponse(
      new Response("Use POST.", {
        status: 405,
        headers: { Allow: "POST, OPTIONS" },
      }),
    );

  let server: McpServer | undefined;
  try {
    const config = endpoint();
    if (config instanceof Response) return privateResponse(config);
    const authorization = request.headers.get("Authorization");
    let parsedBody: unknown;
    try {
      await config.authorize(authorization);
      parsedBody = await readIntakeBody(request, 65_536);
      const call = parsedBody as {
        method?: string;
        params?: { name?: string };
      } | null;
      if (
        call?.method === "tools/call" &&
        typeof call.params?.name === "string" &&
        Object.hasOwn(config.scopesByTool, call.params.name)
      )
        await config.authorize(authorization, config.scopesByTool[call.params.name]);
    } catch (error) {
      if (!(error instanceof AgentAccessError)) throw error;
      return privateResponse(
        Response.json(
          {
            error: error.code,
            message: error.message,
            continueUrl: config.continueUrl,
            note: config.note,
          },
          {
            status: error.code === "insufficient_scope" ? 403 : 401,
            headers: {
              "WWW-Authenticate":
                agentChallenge(config.resourceMetadataUrl, error) +
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
    server = config.createServer(authorization);
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
