import { adminData, adminFor, type AdminGraphql } from "./shopify-admin.server";

const REASONS_QUERY = `#graphql
  query ReturnReasonDefinitions($after: String) {
    returnReasonDefinitions(first: 250, after: $after) {
      nodes { id handle name deleted }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type Reason = { id: string; handle: string; name: string; deleted: boolean };
type ReasonPage = {
  returnReasonDefinitions: {
    nodes: Reason[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

const OTHER_HANDLE = "other-reason";
const reasonIds = new Map<string, string>();

// Shopify requires a return reason on every returned item. Customers aren't
// asked why they're returning something, so Gooper.io files returns under
// Shopify's own "Other" reason.
export async function otherReturnReasonId(shop: string, admin?: AdminGraphql) {
  const cached = reasonIds.get(shop);
  if (cached) return cached;
  const client = admin ?? (await adminFor(shop));
  const reasons: Reason[] = [];
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const { returnReasonDefinitions }: ReasonPage = await adminData<ReasonPage>(
      client,
      REASONS_QUERY,
      { after },
      "Shopify could not list return reasons.",
    );
    reasons.push(...returnReasonDefinitions.nodes.filter((reason) => !reason.deleted));
    if (reasons.some((reason) => reason.handle === OTHER_HANDLE)) break;
    if (!returnReasonDefinitions.pageInfo.hasNextPage) break;
    after = returnReasonDefinitions.pageInfo.endCursor;
  }
  const reason =
    reasons.find((entry) => entry.handle === OTHER_HANDLE) ??
    reasons.find((entry) => entry.name.trim().toLowerCase() === "other");
  if (!reason)
    throw new Error("Shopify has no \"Other\" return reason to file this return under.");
  reasonIds.set(shop, reason.id);
  return reason.id;
}
