import type { LoaderFunctionArgs } from "react-router";
import { agentResource, agentScopes } from "../services/agent-access.server";
import { normalizeShopDomain } from "../services/customer-account.server";
import {
  appOrigin,
  privateHeaders,
} from "../services/customer-security.server";

// Resource metadata for a store's MCP address. That address opens the same
// connection to every Refund store; the resource stays the address itself,
// because hosts check that it matches the URL they connected to.
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const headers = { ...privateHeaders, "Access-Control-Allow-Origin": "*" };
  let shop: string;
  try {
    shop = normalizeShopDomain(params.shop ?? "");
  } catch {
    return Response.json({ error: "invalid_store" }, { status: 400, headers });
  }
  if (process.env.REFUND_OAUTH_HTTP_READY === "1")
    return Response.json(
      {
        resource: agentResource(shop),
        authorization_servers: [appOrigin()],
        scopes_supported: [...agentScopes],
        bearer_methods_supported: ["header"],
        resource_name: "Refund returns for every store",
      },
      { headers },
    );
  return Response.json(
    {
      error: "agent_authorization_not_configured",
      message:
        "Direct assistant connection is not available yet. Use the customer return portal.",
      continueUrl: new URL(`/returns/${shop}`, appOrigin()).href,
    },
    { status: 503, headers },
  );
};
