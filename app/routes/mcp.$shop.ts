import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createCustomerReturnsMcpServer } from "../mcp.server";
import { normalizeShopDomain } from "../services/customer-account.server";
import { authorizeAgent } from "../services/agent-access.server";
import { appOrigin } from "../services/customer-security.server";
import {
  handleAgentMcp,
  returnToolScopes,
} from "../services/agent-mcp-http.server";

const handle = (request: Request, shopParam: string) =>
  handleAgentMcp(request, () => {
    let shop: string;
    try {
      shop = normalizeShopDomain(shopParam);
    } catch {
      return new Response("Invalid store.", { status: 400 });
    }
    const resourceMetadataUrl = new URL(`/oauth/resource/${shop}`, appOrigin())
      .href;
    return {
      resourceMetadataUrl,
      continueUrl: new URL(`/returns/${shop}`, appOrigin()).href,
      note: "Complete Shopify sign-in and assistant consent through the OAuth connection. No return has been submitted.",
      scopesByTool: returnToolScopes,
      authorize: (authorization, scope) =>
        authorizeAgent(authorization, shop, scope),
      createServer: (authorization) =>
        createCustomerReturnsMcpServer({
          // Re-check consent, expiry and revocation at each tool invocation.
          authorize: (scope) => authorizeAgent(authorization, shop, scope),
          resourceMetadataUrl,
        }),
    };
  });

export const loader = ({ request, params }: LoaderFunctionArgs) =>
  handle(request, params.shop ?? "");
export const action = ({ request, params }: ActionFunctionArgs) =>
  handle(request, params.shop ?? "");
