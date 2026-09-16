import * as z from "zod/v4";

import type { ReturnableOrder } from "./automatic-return.server";
import { normalizeShopDomain } from "./customer-account.server";
import { resolveMerchant } from "./merchant-directory.server";
import { searchPublishedMerchants } from "./merchant-lookup.server";
import type { OrderSelection } from "./return-quote.server";

// Assistants show the customer the arguments of any tool they approve, so the
// tools take the words the customer already used — a store's name, an order
// number, a product title — and this turns them into the Shopify IDs a return
// needs. Every reading that isn't the only one refuses instead of guessing: a
// wrong guess here refunds the wrong thing.

export const returningSchema = z
  .array(
    z.object({
      order: z
        .string()
        .max(60)
        .optional()
        .describe(
          'The order number the customer named, like "#1001". Leave it out when they only named the product.',
        ),
      product: z
        .string()
        .min(1)
        .max(255)
        .describe('The product name, like "Refund Test Product"'),
      quantity: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("How many to send back. One by default."),
    }),
  )
  .min(1)
  .max(50);

export type ReturningItem = z.infer<typeof returningSchema>[number];

const plain = (value: string) =>
  value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
// Customers write an order number with or without its "#".
const orderKey = (value: string) => plain(value).replace(/^#/, "");

type Candidate = {
  orderId: string;
  orderName: string;
  lineItemId: string;
  title: string;
};

function candidates(orders: ReturnableOrder[], product: string): Candidate[] {
  const wanted = plain(product);
  const all = orders.flatMap((order) =>
    order.returnInformation.returnableLineItems.nodes.map((entry) => ({
      orderId: order.id,
      orderName: order.name,
      lineItemId: entry.lineItem.id,
      title: entry.lineItem.presentmentTitle,
    })),
  );
  const exact = all.filter((entry) => plain(entry.title) === wanted);
  return exact.length
    ? exact
    : all.filter((entry) => plain(entry.title).includes(wanted));
}

// Two line items can carry the same title on the same order, so say how many
// rather than printing one label twice.
const describe = (entries: Candidate[]) => {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const label = `${entry.title} on order ${entry.orderName}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts]
    .map(([label, count]) => (count > 1 ? `${label} (${count} items)` : label))
    .join(", ");
};

// The store's name, website or myshopify.com domain, as one store's domain.
// A name that matches no store, or more than one, stops the request rather
// than picking a store the customer never named.
export async function resolveStore(value: string) {
  const named = value.trim();
  try {
    // Already a store domain: use it unchanged, as callers always could.
    return normalizeShopDomain(named);
  } catch {
    /* A store's name or website, not its myshopify.com domain. */
  }
  const store = await resolveMerchant(named);
  if (store) return store.shop;
  const similar = await searchPublishedMerchants(named, 5);
  if (similar.length > 1)
    throw new Error(
      `More than one store matches "${named}": ${similar
        .map((entry) => `${entry.name} (${entry.primaryDomain})`)
        .join(", ")}. Ask the customer which one they bought from, then use that store's website.`,
    );
  throw new Error(
    `No store called "${named}" uses Gooper.io. Use find_store to search for the store the customer bought from.`,
  );
}

// The customer's own returnable orders decide what each product name means, so
// a title they never bought, a title on two items, or a product from an order
// they didn't name all stop here.
export function resolveReturning(
  returning: ReturningItem[],
  orders: ReturnableOrder[],
): OrderSelection[] {
  const chosen = new Map<string, Map<string, number>>();
  for (const entry of returning) {
    const product = entry.product.trim();
    if (!product) throw new Error("Name the product the customer is sending back.");
    const named = entry.order?.trim();
    let searched = orders;
    if (named) {
      const wanted = orderKey(named);
      searched = orders.filter((order) => orderKey(order.name) === wanted);
      if (!searched.length)
        throw new Error(
          `This customer has no returnable order ${named} at this store. Use find_returnable_items to see their orders; never guess an order number.`,
        );
    }
    const matches = candidates(searched, product);
    if (!matches.length) {
      const elsewhere = named ? candidates(orders, product) : [];
      throw new Error(
        elsewhere.length
          ? `"${product}" isn't on order ${named}. It's on ${describe(elsewhere)}. Name that order instead, or leave the order out.`
          : `Nothing called "${product}" is returnable for this customer at this store. Use find_returnable_items to see what is.`,
      );
    }
    if (matches.length > 1)
      throw new Error(
        `More than one returnable item matches "${product}": ${describe(matches)}. Ask the customer which one they mean; if their words can't tell the items apart, take the one they pick from find_returnable_items and pass it as orders with items.`,
      );
    const [match] = matches;
    const items = chosen.get(match.orderId) ?? new Map<string, number>();
    if (items.has(match.lineItemId))
      throw new Error(
        `"${match.title}" on order ${match.orderName} is listed twice. List it once, with the total quantity.`,
      );
    items.set(match.lineItemId, entry.quantity ?? 1);
    chosen.set(match.orderId, items);
  }
  return [...chosen].map(([orderId, items]) => ({
    orderId,
    items: [...items].map(([lineItemId, quantity]) => ({ lineItemId, quantity })),
  }));
}
