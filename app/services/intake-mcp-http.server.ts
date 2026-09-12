import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createIntakeMcpServer } from "../intake-mcp.server";
import { intakeResponse, readIntakeBody } from "./public-intake-http.server";

const methodResponse = (request: Request) =>
  intakeResponse(
    request.method === "OPTIONS"
      ? new Response(null, { status: 204 })
      : new Response("Use POST for the public Refund intake MCP endpoint.", {
          status: 405,
          headers: { Allow: "POST, OPTIONS" },
        }),
  );

export async function handleIntakeMcp(request: Request, shop?: string) {
  if (request.method === "OPTIONS")
    return intakeResponse(new Response(null, { status: 204 }));
  if (request.method !== "POST") return methodResponse(request);
  let server: ReturnType<typeof createIntakeMcpServer> | undefined;
  try {
    const parsedBody = await readIntakeBody(request);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    server = createIntakeMcpServer(shop);
    await server.connect(transport);
    return intakeResponse(
      await transport.handleRequest(request, { parsedBody }),
    );
  } catch (error) {
    return intakeResponse(
      error instanceof Response
        ? error
        : new Response("Return intake unavailable.", { status: 503 }),
    );
  } finally {
    await server?.close();
  }
}
