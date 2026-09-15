import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleNetworkMcp } from "../services/network-mcp.server";

// The connector address customers paste into their assistant.
const handle = (request: Request) =>
  handleNetworkMcp(request, "/oauth/resource/mcp");

export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
