import prisma from "../db.server";
import type { RequestedItem } from "./return-guards.server";

// Shapes of the fields this module reads from the Shopify return query.
export type ReturnLineItemNode = {
  id: string;
  quantity: number;
  fulfillmentLineItem: { lineItem: { id: string } } | null;
};

export type ReverseFulfillmentLineItemNode = {
  id: string;
  totalQuantity: number;
  fulfillmentLineItem: { lineItem: { id: string } } | null;
};

export type ReturnDisposition = {
  reverseFulfillmentOrderLineItemId: string;
  quantity: number;
  // Shopify requires a location only for RESTOCKED.
  locationId?: string;
  dispositionType: "RESTOCKED" | "NOT_RESTOCKED";
};

export type ReturnProcessLineItem = {
  id: string;
  quantity: number;
  dispositions: ReturnDisposition[];
};

/**
 * Resolve where returned inventory is restocked.
 *
 * Order of resolution, as decided in docs/PROJECT_STATE.md:
 *   1. The merchant's configured override, when set.
 *   2. The location that fulfilled the order.
 *
 * Returns null when neither resolves. The caller then processes the return
 * without a restock rather than failing it, so a missing location never
 * strands a customer mid-refund.
 */
export async function resolveRestockLocation(
  shop: string,
  fulfillmentLocationIds: Array<string | null | undefined>,
): Promise<string | null> {
  const policy = await prisma.storePolicy.findUnique({ where: { shop } });
  if (policy?.returnLocationId) return policy.returnLocationId;
  const fulfilled = fulfillmentLocationIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  // Multiple fulfillment locations have no single correct answer; the merchant
  // must set the override for that store rather than have one picked for them.
  const unique = new Set(fulfilled);
  return unique.size === 1 ? fulfilled[0] : null;
}

/**
 * Map the customer's requested items onto returnProcess line items.
 *
 * Requested items are keyed by order line item id. The return and its reverse
 * fulfillment orders key off the same fulfillment line item, which is what
 * makes the two sides joinable.
 *
 * With no location, line items get no disposition unless `unlocatedDisposition`
 * asks for one: a refund before receipt leaves the items undisposed, while
 * receiving them without a restock location records them as not restocked.
 */
export function buildReturnProcessLineItems({
  items,
  returnLineItems,
  reverseFulfillmentLineItems,
  locationId,
  unlocatedDisposition,
}: {
  items: RequestedItem[];
  returnLineItems: ReturnLineItemNode[];
  reverseFulfillmentLineItems: ReverseFulfillmentLineItemNode[];
  locationId: string | null;
  unlocatedDisposition?: "NOT_RESTOCKED";
}): ReturnProcessLineItem[] {
  const byOrderLineItem = (lineItemId: string) =>
    returnLineItems.find(
      (node) => node.fulfillmentLineItem?.lineItem.id === lineItemId,
    );

  // Reverse fulfillment quantities are consumed as they are allocated, so a
  // line item split across several reverse fulfillment orders is covered once
  // and only once.
  const remaining = new Map(
    reverseFulfillmentLineItems.map((node) => [node.id, node.totalQuantity]),
  );
  const dispositionType = locationId ? "RESTOCKED" : unlocatedDisposition;

  return items.map((item) => {
    const returnLineItem = byOrderLineItem(item.lineItemId);
    if (!returnLineItem) {
      throw new Error(
        "Shopify's approved return does not cover every confirmed item. No refund was issued.",
      );
    }
    if (returnLineItem.quantity < item.quantity) {
      throw new Error(
        "Shopify approved a smaller quantity than the customer confirmed. No refund was issued.",
      );
    }

    const dispositions: ReturnDisposition[] = [];
    if (dispositionType) {
      let outstanding = item.quantity;
      for (const candidate of reverseFulfillmentLineItems) {
        if (outstanding <= 0) break;
        if (candidate.fulfillmentLineItem?.lineItem.id !== item.lineItemId) {
          continue;
        }
        const available = remaining.get(candidate.id) ?? 0;
        if (available <= 0) continue;
        const quantity = Math.min(available, outstanding);
        remaining.set(candidate.id, available - quantity);
        outstanding -= quantity;
        dispositions.push({
          reverseFulfillmentOrderLineItemId: candidate.id,
          quantity,
          ...(locationId ? { locationId } : {}),
          dispositionType,
        });
      }
      // A partial allocation would dispose less than was returned. Dispose
      // nothing for this line rather than a misleading fraction; the refund
      // still proceeds and the merchant reconciles inventory manually.
      if (outstanding > 0) dispositions.length = 0;
    }

    return {
      id: returnLineItem.id,
      quantity: item.quantity,
      dispositions,
    };
  });
}
