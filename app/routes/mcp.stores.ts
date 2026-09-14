import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleNetworkMcp } from "../services/network-mcp.server";

const handle = (request: Request) =>
  handleNetworkMcp(request, "/oauth/resource/stores");

export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
