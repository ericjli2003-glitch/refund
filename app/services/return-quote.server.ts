import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import prisma from "../db.server";
import {
  calculateReturn,
  executeAutomaticReturn,
  getReturnableOrders,
} from "./automatic-return.server";
import { hashCustomerId, moneyIsAbove } from "./return-guards.server";
import { signQuote, verifyQuoteSignature } from "./customer-security.server";

export const returnItemsSchema = z
  .array(
    z.object({
      lineItemId: z.string().regex(/^gid:\/\/shopify\/LineItem\/\d+$/),
      quantity: z.number().int().positive(),
    }),
  )
  .min(1)
  .max(50)
  .refine(
    (items) =>
      new Set(items.map((item) => item.lineItemId)).size === items.length,
    "Each item must appear only once.",
  );

export const quoteInputSchema = z.object({
  orderId: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/),
  items: returnItemsSchema,
});
export const confirmInputSchema = z.object({
  quoteToken: z.string().min(1).max(32_000),
  customerConfirmed: z.literal(true),
  customerNote: z.string().max(300).optional(),
});
const signedQuoteSchema = quoteInputSchema.extend({
  version: z.literal(1),
  id: z.string().uuid(),
  shop: z.string(),
  subject: z.string(),
  expiresAt: z.number(),
  expectedRefund: z.object({ amount: z.string(), currencyCode: z.string() }),
});

export function readBoundQuote(
  token: string,
  shop: string,
  subject: string,
  now = Date.now(),
) {
  const quote = signedQuoteSchema.parse(verifyQuoteSignature(token));
  if (quote.shop !== shop || quote.subject !== subject)
    throw new Error("This quote belongs to a different customer or store.");
  if (quote.expiresAt <= now)
    throw new Error(
      "This quote expired. Request a new quote before confirming.",
    );
  return quote;
}

export async function createReturnQuote(
  shop: string,
  customerToken: string,
  input: unknown,
) {
  const { orderId, items } = quoteInputSchema.parse(input);
  const { customerId, orders } = await getReturnableOrders(shop, customerToken);
  const order = orders.find((entry) => entry.id === orderId);
  if (!order)
    throw new Error(
      "That order is not available in your authenticated account.",
    );
  const policy = await prisma.storePolicy.findUnique({ where: { shop } });
  if (!policy?.automaticRefundsEnabled)
    throw new Error(
      "Automatic returns are not enabled for this store. Nothing was submitted.",
    );
  const age = (Date.now() - Date.parse(order.processedAt)) / 86_400_000;
  if (!Number.isFinite(age) || age > policy.returnWindowDays)
    throw new Error(
      `This order is outside the store's ${policy.returnWindowDays}-day automatic return window.`,
    );
  const available = order.returnInformation.returnableLineItems.nodes;
  for (const item of items) {
    if (
      item.quantity >
      (available.find((entry) => entry.lineItem.id === item.lineItemId)
        ?.quantity ?? 0)
    ) {
      throw new Error(
        "The selected item or quantity is not currently returnable.",
      );
    }
  }
  const calculation = await calculateReturn(
    shop,
    customerToken,
    orderId,
    items,
  );
  const expectedRefund =
    calculation.financialSummary.returnTotalSet.presentmentMoney;
  const policyAmount = calculation.financialSummary.returnTotalSet.shopMoney;
  if (policyAmount.currencyCode !== policy.currencyCode)
    throw new Error(
      `This store's automatic-refund policy is configured for ${policy.currencyCode}, but its Shopify currency is ${policyAmount.currencyCode}. Nothing was submitted.`,
    );
  if (
    moneyIsAbove(policyAmount.amount, policy.maxAutoRefundAmount) ||
    !Number.isFinite(Number(expectedRefund.amount)) ||
    Number(expectedRefund.amount) <= 0
  ) {
    throw new Error(
      "This amount is outside the store's automatic-refund limit. Nothing was submitted.",
    );
  }
  const quote = {
    version: 1 as const,
    id: randomUUID(),
    shop,
    orderId,
    items,
    expectedRefund,
    subject: hashCustomerId(customerId, process.env.SHOPIFY_API_SECRET!),
    expiresAt: Date.now() + 600_000,
  };
  return {
    orderId,
    orderName: order.name,
    expectedRefund,
    items: items.map((item) => ({
      ...item,
      title: available.find((entry) => entry.lineItem.id === item.lineItemId)!
        .lineItem.presentmentTitle,
    })),
    quoteToken: signQuote(quote),
    expiresAt: new Date(quote.expiresAt).toISOString(),
    nextStep:
      "Show the exact items, quantities, and refund amount to the customer. Submit only after their explicit confirmation.",
    paymentMethod:
      "Original payment method. Bank posting time is not guaranteed to be immediate.",
    returnShipping:
      "A return is opened after confirmation. This app does not yet generate a shipping label; follow the store's return-shipping instructions.",
  };
}

export async function submitReturnQuote(
  shop: string,
  customerToken: string,
  input: unknown,
) {
  const { quoteToken, customerNote } = confirmInputSchema.parse(input);
  const { customerId } = await getReturnableOrders(shop, customerToken);
  const quote = readBoundQuote(
    quoteToken,
    shop,
    hashCustomerId(customerId, process.env.SHOPIFY_API_SECRET!),
  );
  const result = await executeAutomaticReturn({
    shop,
    customerToken,
    orderId: quote.orderId,
    items: quote.items,
    expectedRefund: quote.expectedRefund,
    idempotencyKey: quote.id,
    customerNote,
  });
  return {
    status: result.status,
    orderId: result.orderId,
    returnId: result.returnId,
    refundId: result.refundId,
    amount: result.amount,
    currencyCode: result.currencyCode,
    message:
      result.status === "REFUND_SUBMITTED"
        ? "Shopify submitted the refund to the original payment method. Bank posting time may vary. Follow the store's instructions for sending the item back."
        : "This request already exists. Do not create another return; check its current status.",
  };
}
