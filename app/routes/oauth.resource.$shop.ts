import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { normalizeShopDomain } from "../services/customer-account.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  let shop: string;
  try {
    shop = normalizeShopDomain(params.shop ?? "");
  } catch {
    return Response.json({ error: "invalid_store" }, { status: 400 });
  }

  const installedStore = await prisma.session.findFirst({
    where: { shop },
    select: { id: true },
  });
  if (!installedStore) {
    return Response.json({ error: "store_not_connected" }, { status: 404 });
  }

  const discoveryResponse = await fetch(
    `https://${shop}/.well-known/openid-configuration`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!discoveryResponse.ok) {
    return Response.json(
      { error: "customer_account_authentication_unavailable" },
      { status: 502 },
    );
  }

  const discovery = (await discoveryResponse.json()) as { issuer?: string };
  if (!discovery.issuer) {
    return Response.json(
      { error: "customer_account_authentication_unavailable" },
      { status: 502 },
    );
  }

  return Response.json(
    {
      resource: new URL(`/mcp/${shop}`, request.url).toString(),
      authorization_servers: [discovery.issuer],
      scopes_supported: ["openid", "email", "customer-account-api:full"],
      bearer_methods_supported: ["header"],
      resource_documentation:
        "https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps/build-self-serve-returns",
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
};
