import * as z from "zod/v4";
import prisma from "../db.server";
import {
  adminData,
  adminFor,
  type AdminGraphql,
} from "./shopify-admin.server";
import type { CustomerContext } from "./return-draft.server";
import { isWixStore } from "./store-platform.server";

type UserError = { field?: string[]; message: string };

type Delivery = {
  id: string;
  deliverable: {
    label?: { publicFileUrl: string | null } | null;
    tracking?: {
      number: string | null;
      url: string | null;
      carrierName: string | null;
    } | null;
  } | null;
};

export type ReturnShipping = {
  agentReturnId: string;
  labelUrl: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrierName: string | null;
  canAddTracking: boolean;
};

// Returns the customer can still ship: approved, and not yet received.
export const SHIPPABLE = ["RETURN_OPEN", "AWAITING_ITEM", "REFUND_SUBMITTED", "REFUND_RECORDED"];

// Labels and tracking live on the return's reverse deliveries in Shopify,
// whether the merchant created a label there or the customer added tracking.
const SHIPPING_QUERY = `#graphql
  query ReturnShipping($returnId: ID!) {
    return(id: $returnId) {
      reverseFulfillmentOrders(first: 10) {
        nodes {
          id
          reverseDeliveries(first: 10) {
            nodes {
              id
              deliverable {
                ... on ReverseDeliveryShippingDeliverable {
                  label { publicFileUrl }
                  tracking { number url carrierName }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Shopify emails delivery instructions by default. The customer is entering
// their own tracking here, so no email is sent.
const CREATE_TRACKING_MUTATION = `#graphql
  mutation CreateReturnTracking(
    $reverseFulfillmentOrderId: ID!
    $trackingInput: ReverseDeliveryTrackingInput!
  ) {
    reverseDeliveryCreateWithShipping(
      reverseFulfillmentOrderId: $reverseFulfillmentOrderId
      reverseDeliveryLineItems: []
      trackingInput: $trackingInput
      notifyCustomer: false
    ) {
      reverseDelivery { id }
      userErrors { field message }
    }
  }
`;

const UPDATE_TRACKING_MUTATION = `#graphql
  mutation UpdateReturnTracking(
    $reverseDeliveryId: ID!
    $trackingInput: ReverseDeliveryTrackingInput!
  ) {
    reverseDeliveryShippingUpdate(
      reverseDeliveryId: $reverseDeliveryId
      trackingInput: $trackingInput
      notifyCustomer: false
    ) {
      reverseDelivery { id }
      userErrors { field message }
    }
  }
`;

export async function readShipping(admin: AdminGraphql, returnId: string) {
  const { return: found } = await adminData<{
    return: {
      reverseFulfillmentOrders: {
        nodes: Array<{ id: string; reverseDeliveries: { nodes: Delivery[] } }>;
      };
    } | null;
  }>(admin, SHIPPING_QUERY, { returnId }, "Shopify could not read this return's shipping.");
  if (!found) throw new Error("Shopify could not find this return.");
  const orders = found.reverseFulfillmentOrders.nodes;
  return {
    reverseFulfillmentOrderId: orders[0]?.id ?? null,
    delivery: orders.flatMap((order) => order.reverseDeliveries.nodes)[0] ?? null,
  };
}

// A return label Gooper.io bought on the merchant's shipping account
// (return-labels.server.ts). Null when none was.
export function boughtLabel(record: {
  labelStatus?: string | null;
  labelUrl?: string | null;
  labelCarrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
}) {
  if (record.labelStatus !== "PURCHASED" || !record.labelUrl) return null;
  return {
    labelUrl: record.labelUrl,
    carrierName: record.labelCarrier ?? null,
    trackingNumber: record.trackingNumber ?? null,
    trackingUrl: record.trackingUrl ?? null,
  };
}

// Only Shopify-hosted https links are shown to the customer.
const httpsOrNull = (value?: string | null) =>
  value && /^https:\/\//i.test(value) ? value : null;

function describeShipping(
  agentReturnId: string,
  shipping: Awaited<ReturnType<typeof readShipping>>,
): ReturnShipping {
  const deliverable = shipping.delivery?.deliverable;
  const trackingNumber = deliverable?.tracking?.number || null;
  return {
    agentReturnId,
    labelUrl: httpsOrNull(deliverable?.label?.publicFileUrl),
    trackingNumber,
    trackingUrl: httpsOrNull(deliverable?.tracking?.url),
    carrierName: deliverable?.tracking?.carrierName || null,
    canAddTracking: !trackingNumber && Boolean(shipping.reverseFulfillmentOrderId),
  };
}

// A return whose shipping can't be read is simply omitted; shipping details
// never block the rest of the customer's return status.
export async function returnShippingFor(
  context: CustomerContext,
  admin?: AdminGraphql,
) {
  const records = await prisma.agentReturn.findMany({
    where: {
      shop: context.shop,
      customerSubjectHash: context.customerSubjectHash,
      returnId: { not: null },
      itemReceivedAt: null,
      status: { in: SHIPPABLE },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      returnId: true,
      trackingNumber: true,
      trackingUrl: true,
      labelStatus: true,
      labelUrl: true,
      labelCarrier: true,
    },
  });
  if (!records.length) return [];
  // Wix sends no return labels; the customer's own tracking is on the record.
  if (isWixStore(context.shop))
    return records.map((record) => ({
      agentReturnId: record.id,
      labelUrl: null,
      trackingNumber: record.trackingNumber,
      trackingUrl: httpsOrNull(record.trackingUrl),
      carrierName: null,
      canAddTracking: !record.trackingNumber,
    }));
  const client = admin ?? (await adminFor(context.shop));
  const shipping = await Promise.all(
    records.map(async (record) => {
      // A label bought on the merchant's shipping account is on the record
      // too, so the customer has it even if Shopify can't be read or the
      // label never reached the Shopify return.
      const bought = boughtLabel(record);
      try {
        const described = describeShipping(record.id, await readShipping(client, record.returnId!));
        if (!bought || described.labelUrl) return described;
        return {
          ...described,
          labelUrl: httpsOrNull(bought.labelUrl),
          trackingNumber: described.trackingNumber ?? bought.trackingNumber,
          trackingUrl: described.trackingUrl ?? httpsOrNull(bought.trackingUrl),
          carrierName: described.carrierName ?? bought.carrierName,
          canAddTracking: false,
        };
      } catch {
        return bought
          ? {
              agentReturnId: record.id,
              labelUrl: httpsOrNull(bought.labelUrl),
              trackingNumber: bought.trackingNumber,
              trackingUrl: httpsOrNull(bought.trackingUrl),
              carrierName: bought.carrierName,
              canAddTracking: false,
            }
          : null;
      }
    }),
  );
  return shipping.filter((entry): entry is ReturnShipping => entry !== null);
}

export const trackingInputSchema = z.object({
  agentReturnId: z.string().min(1).max(64),
  trackingNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 -]{3,39}$/, "Enter the carrier's tracking number."),
  trackingUrl: z
    .string()
    .trim()
    .max(500)
    .url()
    .refine((value) => value.startsWith("https://"), "Use an https:// tracking link.")
    .optional(),
});

// Customers who ship the item themselves record its tracking on their own
// return. Tracking from a store-provided label is never overwritten.
export async function addReturnTracking(
  context: CustomerContext,
  input: unknown,
  admin?: AdminGraphql,
) {
  const { agentReturnId, trackingNumber, trackingUrl } =
    trackingInputSchema.parse(input);
  const record = await prisma.agentReturn.findFirst({
    where: {
      id: agentReturnId,
      shop: context.shop,
      customerSubjectHash: context.customerSubjectHash,
    },
  });
  if (!record?.returnId || record.itemReceivedAt || !SHIPPABLE.includes(record.status))
    throw new Error(
      "Tracking can only be added to your own approved return before the store receives it.",
    );
  if (boughtLabel(record)?.trackingNumber)
    throw new Error("This return already has tracking from the store's label.");
  if (isWixStore(context.shop)) {
    if (record.trackingNumber)
      throw new Error("This return already has a tracking number.");
    const saved = await prisma.agentReturn.update({
      where: { id: record.id },
      data: { trackingNumber, trackingUrl: trackingUrl ?? null },
    });
    return {
      agentReturnId: saved.id,
      labelUrl: null,
      trackingNumber: saved.trackingNumber,
      trackingUrl: httpsOrNull(saved.trackingUrl),
      carrierName: null,
      canAddTracking: false,
    };
  }
  const client = admin ?? (await adminFor(context.shop));
  const shipping = await readShipping(client, record.returnId);
  if (shipping.delivery?.deliverable?.tracking?.number)
    throw new Error("This return already has tracking from the store's label.");
  const trackingInput = {
    number: trackingNumber,
    ...(trackingUrl ? { url: trackingUrl } : {}),
  };
  let errors: UserError[];
  if (shipping.delivery) {
    ({
      reverseDeliveryShippingUpdate: { userErrors: errors },
    } = await adminData<{ reverseDeliveryShippingUpdate: { userErrors: UserError[] } }>(
      client,
      UPDATE_TRACKING_MUTATION,
      { reverseDeliveryId: shipping.delivery.id, trackingInput },
      "Shopify could not save the tracking number.",
    ));
  } else if (shipping.reverseFulfillmentOrderId) {
    ({
      reverseDeliveryCreateWithShipping: { userErrors: errors },
    } = await adminData<{ reverseDeliveryCreateWithShipping: { userErrors: UserError[] } }>(
      client,
      CREATE_TRACKING_MUTATION,
      { reverseFulfillmentOrderId: shipping.reverseFulfillmentOrderId, trackingInput },
      "Shopify could not save the tracking number.",
    ));
  } else {
    throw new Error(
      "The store hasn't prepared this return for shipping yet. Try again later or contact the store.",
    );
  }
  if (errors.length)
    throw new Error(
      `Shopify could not save the tracking number: ${errors.map((error) => error.message).join("; ")}`,
    );
  return describeShipping(record.id, await readShipping(client, record.returnId));
}
