import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleMerchantProxy } from "../services/merchant-proxy-http.server";

export const loader = ({ request, params }: LoaderFunctionArgs) =>
  handleMerchantProxy(request, params["*"] || "");
export const action = ({ request, params }: ActionFunctionArgs) =>
  handleMerchantProxy(request, params["*"] || "");
