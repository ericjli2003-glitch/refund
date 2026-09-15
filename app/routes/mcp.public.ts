import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleIntakeMcp } from "../services/intake-mcp-http.server";

export const loader = ({ request }: Pick<LoaderFunctionArgs, "request">) =>
  handleIntakeMcp(request);
export const action = ({ request }: ActionFunctionArgs) => handleIntakeMcp(request);
