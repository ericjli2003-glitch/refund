import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import prisma from "../db.server";
import { describeRefundProgress } from "../refund-status";
import {
  calculateReturn,
  executeAutomaticReturn,
  getReturnableOrders,
  refundTimingOf,
} from "./automatic-return.server";
import { moneyIsAbove, refundFromReturnTotal } from "./return-guards.server";
import {
  noteReturnRulesDrift,
  type CustomerAccess,
} from "./verified-customer-returns.server";
import {
  customerIdentityHash,
  signQuote,
  verifyQuoteSignature,
} from "./customer-security.server";

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
  // Fail closed: a quote missing this field (an older or malformed token)
  // must not parse as submittable.
  submissionAvailable: z.boolean().optional().default(false),
  // Quotes signed before refund timing existed were all immediate.
  refundTiming: z.enum(["IMMEDIATE", "ON_RECEIPT"]).optional().default("IMMEDIATE"),
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
  customerToken: CustomerAccess,
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
  // Installing Gooper.io enables estimates. Automatic payment authorization is
  // separate and is still rechecked by the submission service.
  const submissionAvailable = Boolean(policy?.automaticRefundsEnabled);
  const refundTiming = refundTimingOf(policy?.refundTiming);
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
    order,
    items,
  );
  // A signed-in quote shows the fees and final-sale rules Shopify itself
  // applies; pause verified links if Gooper.io's saved rules would miss them.
  if (typeof customerToken === "string" && policy)
    await noteReturnRulesDrift(shop, policy, order, calculation);
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
    refundTiming,
    subject: customerIdentityHash(customerId),
    expiresAt: Date.now() + 600_000,
  };
  // Fee subtotals are shown only; they are already deducted from
  // expectedRefund, so their sign never feeds an amount calculation.
  const displayedFee = (money?: { amount: string; currencyCode: string }) =>
    money && /^-?\d+(\.\d+)?$/.test(money.amount) && Number(money.amount) !== 0
      ? { amount: money.amount.replace(/^-/, ""), currencyCode: money.currencyCode }
      : null;
  const instructions = policy?.returnInstructions
    ? ` The store's instructions: ${policy.returnInstructions}`
    : " Follow the store's return-shipping instructions.";
  return {
    orderId,
    orderName: order.name,
    expectedRefund,
    submissionAvailable,
    refundTiming,
    items: items.map((item) => ({
      ...item,
      title: available.find((entry) => entry.lineItem.id === item.lineItemId)!
        .lineItem.presentmentTitle,
    })),
    quoteToken: signQuote(quote),
    expiresAt: new Date(quote.expiresAt).toISOString(),
    nextStep: submissionAvailable
      ? "Show the exact items, quantities, any return fees, refund amount and refund timing to the customer. Submit only after their explicit confirmation."
      : "This is a quote only. Contact the merchant to approve and complete the return. No return request has been sent and this estimate does not establish approval under the merchant's policy.",
    paymentMethod:
      refundTiming === "ON_RECEIPT"
        ? "Original payment method, refunded after the store receives the returned item. Bank posting time is not guaranteed to be immediate."
        : "Original payment method, refunded as soon as the return is confirmed, before the item is shipped back. Bank posting time is not guaranteed to be immediate.",
    returnFees: {
      restocking: displayedFee(
        calculation.financialSummary.restockingFeeSubtotalSet?.presentmentMoney,
      ),
      returnShipping: displayedFee(
        calculation.financialSummary.returnShippingFeeSubtotalSet
          ?.presentmentMoney,
      ),
    },
    returnShipping:
      (submissionAvailable
        ? "A return is opened after confirmation. The store may add a return shipping label in Shopify."
        : "Contact the merchant for return approval. No shipping label has been created.") +
      instructions,
  };
}

// In chat the customer has already asked for this return. When nothing is
// deducted, the refund is exactly what they asked for, so the assistant submits
// without another question; a fee is the one thing worth checking first.
export function chatQuoteNextStep(quote: {
  submissionAvailable: boolean;
  returnFees?: { restocking: unknown; returnShipping: unknown } | null;
}) {
  const goAheadWithoutAsking = Boolean(
    quote.submissionAvailable &&
      quote.returnFees &&
      !quote.returnFees.restocking &&
      !quote.returnFees.returnShipping,
  );
  return {
    goAheadWithoutAsking,
    nextStep: !quote.submissionAvailable
      ? "The store reviews these returns itself, so nothing can be submitted from chat. Let the customer know kindly and stop."
      : goAheadWithoutAsking
        ? "Nothing is deducted, so the customer's request is the go-ahead. Call confirm_return now without asking, then tell them it's done: the refund amount, when it arrives, and how to send the item back."
        : "A return fee comes out of this refund, so check once before submitting: in one sentence, say what's going back, the fee and the refund, and ask if they'd like to go ahead.",
  };
}

export async function submitReturnQuote(
  shop: string,
  customerToken: CustomerAccess,
  input: unknown,
) {
  const { quoteToken, customerNote } = confirmInputSchema.parse(input);
  const { customerId } = await getReturnableOrders(shop, customerToken);
  const quote = readBoundQuote(
    quoteToken,
    shop,
    customerIdentityHash(customerId),
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
    refundTiming: quote.refundTiming,
  });
  return {
    status: result.status,
    orderId: result.orderId,
    returnId: result.returnId,
    refundId: result.refundId,
    amount: result.amount,
    currencyCode: result.currencyCode,
    refundStatus: result.refundStatus,
    paymentMethod: "Original payment method",
    ...describeRefundProgress(result),
  };
}
