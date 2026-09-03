import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { createCustomerReturnsMcpServer } from "../mcp.server";
import { normalizeShopDomain } from "../services/customer-account.server";

const corsHeaders = {
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Last-Event-ID, mcp-protocol-version, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "mcp-protocol-version, mcp-session-id",
};

function withCors(response: Response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleMcpRequest(request: Request, shopParam: string) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let shop: string;
  try {
    shop = normalizeShopDomain(shopParam);
  } catch {
    return withCors(new Response("Invalid store.", { status: 400 }));
  }

  const installedStore = await prisma.session.findFirst({
    where: { shop },
    select: { id: true },
  });
  if (!installedStore) {
    return withCors(new Response("Store is not connected.", { status: 404 }));
  }

  const authorization = request.headers.get("Authorization");
  const customerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!customerToken) {
    const resourceMetadata = new URL(
      `/oauth/resource/${shop}`,
      request.url,
    ).toString();
    return withCors(
      new Response("Customer authentication is required.", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
        },
      }),
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createCustomerReturnsMcpServer({ shop, customerToken });
  await server.connect(transport);
  return withCors(await transport.handleRequest(request));
}

export const loader = ({ request, params }: LoaderFunctionArgs) =>
  handleMcpRequest(request, params.shop ?? "");

export const action = ({ request, params }: ActionFunctionArgs) =>
  handleMcpRequest(request, params.shop ?? "");
