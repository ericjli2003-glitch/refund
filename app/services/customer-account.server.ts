const CUSTOMER_API_VERSION = "2026-07";
const endpointCache = new Map<string, string>();

type GraphqlEnvelope<T> = {
  data?: T | null;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};

export class CustomerAccountApiError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    // Shopify answered without running the operation, so nothing changed.
    public readonly rejected = false,
  ) {
    super(message);
    this.name = "CustomerAccountApiError";
  }
}

export function normalizeShopDomain(value: string) {
  const shop = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new CustomerAccountApiError("Invalid Shopify store domain.", 400);
  }

  return shop;
}

export async function discoverCustomerGraphqlEndpoint(shop: string) {
  shop = normalizeShopDomain(shop);
  const cached = endpointCache.get(shop);
  if (cached) return cached;

  const response = await fetch(
    `https://${shop}/.well-known/customer-account-api`,
    {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    },
  );

  if (!response.ok) {
    throw new CustomerAccountApiError(
      "This store has not enabled Shopify customer accounts.",
      response.status,
    );
  }

  const discovery = (await response.json()) as { graphql_api?: string };
  const endpoint = discovery.graphql_api;
  if (!endpoint) {
    throw new CustomerAccountApiError(
      "Shopify did not provide a Customer Account API endpoint.",
    );
  }

  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== "https:" || endpointUrl.username || endpointUrl.password || endpointUrl.port ||
      !(endpointUrl.hostname === "shopify.com" || endpointUrl.hostname.endsWith(".shopify.com") || endpointUrl.hostname === shop)) {
    throw new CustomerAccountApiError(
      "Shopify returned an invalid Customer Account API endpoint.",
    );
  }

  endpointUrl.pathname = endpointUrl.pathname.replace(
    /\/customer\/api\/[^/]+\/graphql$/,
    `/customer/api/${CUSTOMER_API_VERSION}/graphql`,
  );
  const versionedEndpoint = endpointUrl.toString();
  endpointCache.set(shop, versionedEndpoint);
  return versionedEndpoint;
}

export async function customerAccountGraphql<T>(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
) {
  const endpoint = await discoverCustomerGraphqlEndpoint(shop);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/json",
      Authorization: accessToken.replace(/^Bearer\s+/i, ""),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 401 || response.status === 403) {
    throw new CustomerAccountApiError(
      "The customer session has expired. Sign in to the store again.",
      401,
      true,
    );
  }

  if (!response.ok) {
    throw new CustomerAccountApiError(
      `Shopify Customer Account API returned ${response.status}.`,
      response.status,
    );
  }

  const result = (await response.json()) as GraphqlEnvelope<T>;
  if (!result.data || result.errors?.length) {
    throw new CustomerAccountApiError(
      result.errors?.map((error) => error.message).join("; ") ||
        "Shopify did not return customer data.",
      502,
      // No result at all, and not an internal error that may have stopped part
      // way, means the operation didn't run (a refused permission, say).
      Object.values(result.data ?? {}).every((value) => value == null) &&
        !result.errors?.some(
          (error) => error.extensions?.code === "INTERNAL_SERVER_ERROR",
        ),
    );
  }

  return result.data;
}

export async function verifyCustomerAccess(shop: string, accessToken: string) {
  const result = await customerAccountGraphql<{
    customer: { id: string };
  }>(
    shop,
    accessToken,
    `#graphql
      query VerifyCustomerAccess {
        customer { id }
      }
    `,
  );

  return result.customer.id;
}
