import type { LoaderFunctionArgs } from "react-router";
import { normalizeShopDomain } from "../services/customer-account.server";
import {
  appOrigin,
  privateHeaders,
} from "../services/customer-security.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const headers = { ...privateHeaders, "Access-Control-Allow-Origin": "*" };
  let shop: string;
  try {
    shop = normalizeShopDomain(params.shop ?? "");
  } catch {
    return Response.json({ error: "invalid_store" }, { status: 400, headers });
  }
  // Shopify is the upstream customer identity provider, NOT Refund's OAuth
  // authorization server. Do not advertise it as an issuer for our resource.
  // Replace this response only when the consent + code/PKCE broker is ready.
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
