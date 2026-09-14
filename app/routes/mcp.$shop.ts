import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAgentMcp } from "../services/agent-mcp-http.server";
import { normalizeShopDomain } from "../services/customer-account.server";
import { handleNetworkMcp } from "../services/network-mcp.server";

// A store's address, saved from an earlier setup page, opens the same
// connection to every Refund store as /mcp/stores.
const handle = (request: Request, shopParam: string) => {
  let shop: string;
  try {
    shop = normalizeShopDomain(shopParam);
  } catch {
    return handleAgentMcp(request, () => new Response("Invalid store.", { status: 400 }));
  }
  return handleNetworkMcp(request, `/oauth/resource/${shop}`);
};

export const loader = ({ request, params }: LoaderFunctionArgs) =>
  handle(request, params.shop ?? "");
export const action = ({ request, params }: ActionFunctionArgs) =>
  handle(request, params.shop ?? "");
