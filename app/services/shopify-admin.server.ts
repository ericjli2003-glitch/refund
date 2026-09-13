export type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export async function adminData<T>(
  admin: AdminGraphql,
  query: string,
  variables: Record<string, unknown>,
  failure: string,
) {
  const response = await admin.graphql(query, { variables });
  const result = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (!result.data || result.errors?.length)
    throw new Error(
      result.errors?.map((error) => error.message).join("; ") || failure,
    );
  return result.data;
}

export async function adminFor(shop: string): Promise<AdminGraphql> {
  const { unauthenticated } = await import("../shopify.server");
  return (await unauthenticated.admin(shop)).admin;
}

export const hasScope = (granted: string | null | undefined, scope: string) =>
  Boolean(granted?.split(",").map((value) => value.trim()).includes(scope));
