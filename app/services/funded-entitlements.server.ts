import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../db.server";
import { sandboxStateSchema } from "../funded-return-sandbox";
import { requireFundedSandbox } from "./funded-return-sandbox.server";

// Which order line-item units Gooper has funded, and the checks that stop the
// original-payment refund engine from paying the same customer twice.
//
// Units whose Shopify return Gooper created are already excluded from Shopify's
// returnable quantities, so they are only protected by return ID. Units without
// a Shopify return yet are subtracted from what Shopify says is returnable.

type Client = Prisma.TransactionClient | typeof prisma;

// ACTIVE and CONFLICT units stay reserved: a conflict means a refund already
// touched funded units, which never makes another refund of them safe.
const RESERVING = ["ACTIVE", "CONFLICT"];

export type FundedUnits = {
  lineItemId: string;
  quantity: number;
  shopifyReturnId: string | null;
};

export class FundedConflictError extends Error {}

const orderGid = z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/);
const lineItemGid = z.string().regex(/^gid:\/\/shopify\/LineItem\/\d+$/);

// Pure. Returns a reason when refunding `items` could pay out funded units.
// `returnable`, when known, is Shopify's current returnable quantity per line
// item. Without it, any unreserved funded units on a line item block it.
export function fundedConflict({
  items,
  funded,
  returnId,
  returnable,
}: {
  items: Array<{ lineItemId: string; quantity: number }>;
  funded: FundedUnits[];
  returnId?: string;
  returnable?: Map<string, number>;
}): string | null {
  if (!funded.length) return null;
  if (returnId && funded.some((units) => units.shopifyReturnId === returnId))
    return "Gooper funded this return, so it can't also be refunded to the original payment method.";
  const unreserved = new Map<string, number>();
  for (const units of funded)
    if (!units.shopifyReturnId)
      unreserved.set(
        units.lineItemId,
        (unreserved.get(units.lineItemId) ?? 0) + units.quantity,
      );
  for (const item of items) {
    const fundedUnits = unreserved.get(item.lineItemId) ?? 0;
    if (!fundedUnits) continue;
    const available = returnable?.get(item.lineItemId);
    if (available === undefined || item.quantity > available - fundedUnits)
      return "Gooper already funded some of these items, so they can't also be refunded to the original payment method.";
  }
  return null;
}

export async function reservedFundedUnits(
  shop: string,
  orderId: string,
  client: Client = prisma,
): Promise<FundedUnits[]> {
  return client.fundedEntitlement.findMany({
    where: { shop, orderId, status: { in: RESERVING } },
    select: { lineItemId: true, quantity: true, shopifyReturnId: true },
  });
}

// Called by the original-payment refund engine before a Shopify return is
// requested and again before any refund is issued. Fails closed: if the check
// itself can't run, no refund goes out.
export async function assertNotFunded({
  shop,
  orderId,
  items,
  returnId,
  returnable,
}: {
  shop: string;
  orderId: string;
  items: Array<{ lineItemId: string; quantity: number }>;
  returnId?: string;
  returnable?: Map<string, number>;
}) {
  const reason = fundedConflict({
    items,
    funded: await reservedFundedUnits(shop, orderId),
    returnId,
    returnable,
  });
  if (reason) throw new FundedConflictError(`${reason} No refund was issued.`);
}

// Serializes funding decisions for one order (or one case) across processes.
// The lock lasts until the surrounding transaction ends.
export async function lockFunding(
  transaction: Prisma.TransactionClient,
  shop: string,
  key: string,
) {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`funded:${shop}:${key}`}, 0))`;
}

// Reserves funded units for a sandbox case. Must happen before the payout is
// requested, so there is never a moment when the customer has been paid by
// Gooper and the units are still refundable the ordinary way.
export async function reserveFundedUnits(input: {
  shop: string;
  caseId: string;
  orderId: string;
  items: Array<{ lineItemId: string; quantity: number }>;
  // Reads Shopify's current returnable quantity per line item. Called while
  // holding the order lock, so two cases can never both fund the same units:
  // a stale read taken before the lock could miss the other case's return.
  readReturnable?: () => Promise<Map<string, number>>;
}) {
  requireFundedSandbox();
  const { shop, caseId, orderId, items } = z
    .object({
      shop: z.string().min(1),
      caseId: z.string().uuid(),
      orderId: orderGid,
      items: z
        .array(
          z.object({
            lineItemId: lineItemGid,
            quantity: z.number().int().positive().max(1000),
          }),
        )
        .min(1)
        .max(50),
    })
    .parse(input);
  if (new Set(items.map((item) => item.lineItemId)).size !== items.length)
    throw new FundedConflictError("Each line item can appear only once.");
  return prisma.$transaction(async (transaction) => {
    await lockFunding(transaction, shop, orderId);
    await lockFunding(transaction, shop, caseId);
    const returnable = input.readReturnable ? await input.readReturnable() : undefined;
    const existing = await transaction.fundedEntitlement.count({
      where: { shop, caseId, status: { in: RESERVING } },
    });
    if (existing)
      throw new FundedConflictError("This case already has funded items.");
    if (returnable) {
      // Explicit, unlike the refund guard: every requested unit must still be
      // returnable in Shopify after subtracting funded units that don't yet
      // have a Shopify return (units with one are already excluded by Shopify).
      const funded = await reservedFundedUnits(shop, orderId, transaction);
      for (const item of items) {
        const pending = funded
          .filter((units) => units.lineItemId === item.lineItemId && !units.shopifyReturnId)
          .reduce((sum, units) => sum + units.quantity, 0);
        if (item.quantity > (returnable.get(item.lineItemId) ?? 0) - pending)
          throw new FundedConflictError(
            "Those units aren't returnable in Shopify, or Gooper already funded them.",
          );
      }
    }
    await transaction.fundedEntitlement.createMany({
      data: items.map((item) => ({
        id: randomUUID(),
        shop,
        caseId,
        orderId,
        lineItemId: item.lineItemId,
        quantity: item.quantity,
      })),
    });
    return transaction.fundedEntitlement.findMany({
      where: { shop, caseId, status: "ACTIVE" },
    });
  }, { timeout: 30_000, maxWait: 30_000 });
}

// Releases reserved units only when no Gooper money went out: the case never
// requested a payout, or its payout is confirmed failed. Never after success.
export async function releaseFundedUnits(shop: string, caseId: string) {
  requireFundedSandbox();
  return prisma.$transaction(async (transaction) => {
    // Same lock as a payout request, so a payout can't start mid-release.
    await lockFunding(transaction, shop, caseId);
    const row = await transaction.fundedReturnSandbox.findUnique({
      where: { shop_id: { shop, id: caseId } },
    });
    if (!row) throw new FundedConflictError("Case not found for this store.");
    const { payout } = sandboxStateSchema.parse(row.snapshot);
    if (payout !== "NOT_STARTED" && payout !== "FAILED")
      throw new FundedConflictError(
        "Funded items can only be released when no payout succeeded or is still unresolved.",
      );
    const released = await transaction.fundedEntitlement.updateMany({
      where: { shop, caseId, status: "ACTIVE" },
      data: { status: "RELEASED", version: { increment: 1 } },
    });
    return released.count;
  });
}

const refundPayloadSchema = z.object({
  order_id: z.union([z.number(), z.string()]),
  refund_line_items: z
    .array(
      z.object({
        line_item_id: z.union([z.number(), z.string()]),
        quantity: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});

// refunds/create webhook: any Shopify refund touching a funded line item may be
// a second payment for the same units. It's recorded for review; nothing about
// money changes automatically. Deliberately conservative: without knowing which
// units a refund covered, another unit of the same line item is flagged too.
export async function flagFundedRefundConflicts(
  transaction: Prisma.TransactionClient,
  shop: string,
  payload: unknown,
  refundId: string | null,
) {
  const parsed = refundPayloadSchema.safeParse(payload);
  if (!parsed.success) return 0;
  const orderId = `gid://shopify/Order/${parsed.data.order_id}`;
  const refunded = new Map(
    parsed.data.refund_line_items
      .filter((line) => line.quantity > 0)
      .map((line) => [`gid://shopify/LineItem/${line.line_item_id}`, line.quantity]),
  );
  if (!refunded.size) return 0;
  const overlapping = await transaction.fundedEntitlement.findMany({
    where: {
      shop,
      orderId,
      status: "ACTIVE",
      lineItemId: { in: [...refunded.keys()] },
    },
  });
  for (const units of overlapping)
    await transaction.fundedEntitlement.updateMany({
      where: { id: units.id, version: units.version, status: "ACTIVE" },
      data: {
        status: "CONFLICT",
        version: { increment: 1 },
        conflictReason: `Shopify refund ${refundId ?? "(no ID)"} refunded ${refunded.get(units.lineItemId)} of this line item while ${units.quantity} were funded by Gooper. Possible double payment; review before any recovery.`,
      },
    });
  return overlapping.length;
}
