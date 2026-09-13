import { allStoresResource, agentScopes } from "../services/agent-access.server";
import {
  appOrigin,
  privateHeaders,
} from "../services/customer-security.server";

export const loader = async () => {
  const headers = { ...privateHeaders, "Access-Control-Allow-Origin": "*" };
  if (process.env.REFUND_OAUTH_HTTP_READY === "1")
    return Response.json(
      {
        resource: allStoresResource(),
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
        "Direct assistant connection is not available yet. Use a store's return portal.",
      continueUrl: new URL("/stores", appOrigin()).href,
    },
    { status: 503, headers },
  );
};
