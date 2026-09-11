import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createIntakeMcpServer } from "../intake-mcp.server";
import {
  intakeResponse,
  readIntakeBody,
} from "../services/public-intake-http.server";

export const loader = ({ request }: Pick<LoaderFunctionArgs, "request">) =>
  intakeResponse(
    request.method === "OPTIONS" ? new Response(null, { status: 204 }) : new Response("Use POST for the public Refund intake MCP endpoint.", {
      status: 405,
      headers: { Allow: "POST, OPTIONS" },
    }),
  );

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS")
    return intakeResponse(new Response(null, { status: 204 }));
  if (request.method !== "POST") return loader({ request });
  let server: ReturnType<typeof createIntakeMcpServer> | undefined;
  try {
    const parsedBody = await readIntakeBody(request);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    server = createIntakeMcpServer();
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
