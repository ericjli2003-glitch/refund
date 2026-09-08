import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import prisma from "../db.server";
import {
  calculateReturn,
  executeAutomaticReturn,
  getReturnableOrders,
} from "./automatic-return.server";
import {
  hashCustomerId,
  moneyIsAbove,
  refundFromReturnTotal,
} from "./return-guards.server";
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
  submissionAvailable: z.boolean().optional().default(true),
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
  // Installing Refund enables estimates. Automatic payment authorization is
  // separate and is still rechecked by the submission service.
  const submissionAvailable = Boolean(policy?.automaticRefundsEnabled);
  const age = (Date.now() - Date.parse(order.processedAt)) / 86_400_000;
  if (!Number.isFinite(age)) throw new Error("Shopify did not provide a valid purchase date.");
  if (submissionAvailable && policy && age > policy.returnWindowDays)
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
  const expectedRefund = refundFromReturnTotal(
    calculation.financialSummary.returnTotalSet.presentmentMoney,
  );
  const policyAmount = refundFromReturnTotal(
    calculation.financialSummary.returnTotalSet.shopMoney,
  );
  if (submissionAvailable && policy && policyAmount.currencyCode !== policy.currencyCode)
    throw new Error(
      `This store's automatic-refund policy is configured for ${policy.currencyCode}, but its Shopify currency is ${policyAmount.currencyCode}. Nothing was submitted.`,
    );
  if (submissionAvailable && policy && moneyIsAbove(policyAmount.amount, policy.maxAutoRefundAmount)) {
    throw new Error(
      `This amount is outside the store's automatic-refund limit: ${policyAmount.amount} ${policyAmount.currencyCode}, compared with the ${policy.maxAutoRefundAmount} ${policy.currencyCode} maximum. Nothing was submitted.`,
    );
  }
  const quote = {
    version: 1 as const,
    id: randomUUID(),
    shop,
    orderId,
    items,
    expectedRefund,
    submissionAvailable,
    subject: hashCustomerId(customerId, process.env.SHOPIFY_API_SECRET!),
    expiresAt: Date.now() + 600_000,
  };
  return {
    orderId,
    orderName: order.name,
    expectedRefund,
    submissionAvailable,
    items: items.map((item) => ({
      ...item,
      title: available.find((entry) => entry.lineItem.id === item.lineItemId)!
        .lineItem.presentmentTitle,
    })),
    quoteToken: signQuote(quote),
    expiresAt: new Date(quote.expiresAt).toISOString(),
    nextStep: submissionAvailable
      ? "Show the exact items, quantities, and refund amount to the customer. Submit only after their explicit confirmation."
      : "This is a quote only. Contact the merchant to approve and complete the return. No return request has been sent and this estimate does not establish approval under the merchant's policy.",
    paymentMethod:
      "Original payment method. Bank posting time is not guaranteed to be immediate.",
    returnShipping: submissionAvailable
      ? "A return is opened after confirmation. This app does not yet generate a shipping label; follow the store's return-shipping instructions."
      : "Contact the merchant for return approval and shipping instructions. No shipping label has been created.",
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
  if (!quote.submissionAvailable)
    throw new Error("This estimate cannot submit a return or refund. Contact the merchant for approval.");
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
