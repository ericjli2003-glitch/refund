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

// A basket holds items from a few of the customer's orders at one store.
// Shopify opens a return per order, so each order keeps its own quote, refund
// and record, and one order failing never hides another that succeeded.
const MAX_ORDERS = 5;
const MAX_BASKET_ITEMS = 50;
const QUOTE_LIFETIME_MS = 600_000;

export const returnItemsSchema = z
  .array(
    z.object({
      lineItemId: z.string().regex(/^gid:\/\/shopify\/LineItem\/\d+$/),
      quantity: z.number().int().positive(),
    }),
  )
  .min(1)
  .max(MAX_BASKET_ITEMS)
  .refine(
    (items) =>
      new Set(items.map((item) => item.lineItemId)).size === items.length,
    "Each item must appear only once.",
  );

const orderIdSchema = z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/);
const moneySchema = z.object({ amount: z.string(), currencyCode: z.string() });
const orderSelectionSchema = z.object({
  orderId: orderIdSchema,
  items: returnItemsSchema,
});
const signedOrderSchema = orderSelectionSchema.extend({
  expectedRefund: moneySchema,
});

export const quoteInputSchema = z.object({
  // One order, as callers sent before baskets existed.
  orderId: orderIdSchema.optional(),
  items: returnItemsSchema.optional(),
  // Or items from several of this store's orders.
  orders: z.array(orderSelectionSchema).min(1).max(MAX_ORDERS).optional(),
});

export const confirmInputSchema = z.object({
  quoteToken: z.string().min(1).max(32_000),
  customerConfirmed: z.literal(true),
  customerNote: z.string().max(300).optional(),
});

export type OrderSelection = z.infer<typeof orderSelectionSchema>;

export function basketFromInput(input: unknown): OrderSelection[] {
  const raw = quoteInputSchema.parse(input);
  const orders =
    raw.orders ??
    (raw.orderId && raw.items ? [{ orderId: raw.orderId, items: raw.items }] : null);
  if (!orders)
    throw new Error(
      "Choose what to return: pass orders, or a single orderId with items.",
    );
  if (new Set(orders.map((order) => order.orderId)).size !== orders.length)
    throw new Error("Each order can appear only once in a return.");
  if (orders.reduce((count, order) => count + order.items.length, 0) > MAX_BASKET_ITEMS)
    throw new Error(`A return can hold at most ${MAX_BASKET_ITEMS} items.`);
  return orders;
}

const MONEY = /^-?\d+(\.\d{1,6})?$/;
const micros = (amount: string) => {
  if (!MONEY.test(amount))
    throw new Error("Shopify returned an invalid amount. Nothing was submitted.");
  const negative = amount.startsWith("-");
  const [whole, fraction = ""] = amount.replace("-", "").split(".");
  const value = BigInt(whole + fraction.padEnd(6, "0"));
  return negative ? -value : value;
};
const decimalPlaces = (amount: string) => (amount.split(".")[1] ?? "").length;
const formatMicros = (value: bigint, places: number) => {
  const negative = value < 0n;
  const scaled = (negative ? -value : value) / 10n ** BigInt(6 - places);
  const digits = scaled.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = places ? `.${digits.slice(digits.length - places)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
};

// Totals only add up within one currency; orders paid in different currencies
// are returned separately rather than summed into a meaningless figure.
export function addMoney(values: Array<{ amount: string; currencyCode: string }>) {
  const [first] = values;
  if (!first) throw new Error("There is nothing to add up.");
  if (values.some((value) => value.currencyCode !== first.currencyCode))
    throw new Error(
      "Those orders were paid in different currencies, so they need separate returns.",
    );
  const places = Math.max(2, ...values.map((value) => decimalPlaces(value.amount)));
  return {
    amount: formatMicros(
      values.reduce((total, value) => total + micros(value.amount), 0n),
      places,
    ),
    currencyCode: first.currencyCode,
  };
}

const signedQuoteSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  shop: z.string(),
  subject: z.string(),
  expiresAt: z.number(),
  expectedRefund: moneySchema,
  // Fail closed: a quote missing this field (an older or malformed token)
  // must not parse as submittable.
  submissionAvailable: z.boolean().optional().default(false),
  // Quotes signed before refund timing existed were all immediate.
  refundTiming: z.enum(["IMMEDIATE", "ON_RECEIPT"]).optional().default("IMMEDIATE"),
  // Tokens signed before baskets existed carry one order at the top level.
  orderId: orderIdSchema.optional(),
  items: returnItemsSchema.optional(),
  orders: z.array(signedOrderSchema).min(1).max(MAX_ORDERS).optional(),
});

export function readBoundQuote(
  token: string,
  shop: string,
  subject: string,
  now = Date.now(),
) {
  const quote = signedQuoteSchema.parse(verifyQuoteSignature(token));
  const orders =
    quote.orders ??
    (quote.orderId && quote.items
      ? [
          {
            orderId: quote.orderId,
            items: quote.items,
            expectedRefund: quote.expectedRefund,
          },
        ]
      : []);
  if (!orders.length)
    throw new Error("This quote has no items. Request a new quote.");
  if (quote.shop !== shop || quote.subject !== subject)
    throw new Error("This quote belongs to a different customer or store.");
  if (quote.expiresAt <= now)
    throw new Error(
      "This quote expired. Request a new quote before confirming.",
    );
  return { ...quote, orders };
}

// Fee subtotals are shown only; they are already deducted from the refund, so
// their sign never feeds an amount calculation.
const displayedFee = (money?: { amount: string; currencyCode: string }) =>
  money && MONEY.test(money.amount) && Number(money.amount) !== 0
    ? { amount: money.amount.replace(/^-/, ""), currencyCode: money.currencyCode }
    : null;

const totalFee = (fees: Array<{ amount: string; currencyCode: string } | null>) => {
  const present = fees.filter(
    (fee): fee is { amount: string; currencyCode: string } => fee !== null,
  );
  return present.length ? addMoney(present) : null;
};

export async function createReturnQuote(
  shop: string,
  customerToken: CustomerAccess,
  input: unknown,
) {
  const selections = basketFromInput(input);
  const { customerId, orders } = await getReturnableOrders(shop, customerToken);
  const policy = await prisma.storePolicy.findUnique({ where: { shop } });
  // Installing Gooper.io enables estimates. Automatic payment authorization is
  // separate and is still rechecked by the submission service.
  const submissionAvailable = Boolean(policy?.automaticRefundsEnabled);
  const refundTiming = refundTimingOf(policy?.refundTiming);
  const priced = [];
  for (const selection of selections) {
    const order = orders.find((entry) => entry.id === selection.orderId);
    if (!order)
      throw new Error(
        "That order is not available in your authenticated account.",
      );
    const age = (Date.now() - Date.parse(order.processedAt)) / 86_400_000;
    if (!Number.isFinite(age))
      throw new Error("Shopify did not provide a valid purchase date.");
    if (submissionAvailable && policy && age > policy.returnWindowDays)
      throw new Error(
        `Order ${order.name} is outside the store's ${policy.returnWindowDays}-day automatic return window.`,
      );
    const available = order.returnInformation.returnableLineItems.nodes;
    for (const item of selection.items) {
      if (
        item.quantity >
        (available.find((entry) => entry.lineItem.id === item.lineItemId)
          ?.quantity ?? 0)
      )
        throw new Error(
          `An item or quantity chosen from order ${order.name} is not currently returnable.`,
        );
    }
    const calculation = await calculateReturn(
      shop,
      customerToken,
      order,
      selection.items,
    );
    // A signed-in quote shows the fees and final-sale rules Shopify itself
    // applies; pause verified links if Gooper.io's saved rules would miss them.
    if (typeof customerToken === "string" && policy)
      await noteReturnRulesDrift(shop, policy, order, calculation);
    priced.push({
      order,
      available,
      items: selection.items,
      expectedRefund: refundFromReturnTotal(
        calculation.financialSummary.returnTotalSet.presentmentMoney,
      ),
      policyAmount: refundFromReturnTotal(
        calculation.financialSummary.returnTotalSet.shopMoney,
      ),
      returnFees: {
        restocking: displayedFee(
          calculation.financialSummary.restockingFeeSubtotalSet?.presentmentMoney,
        ),
        returnShipping: displayedFee(
          calculation.financialSummary.returnShippingFeeSubtotalSet
            ?.presentmentMoney,
        ),
      },
    });
  }

  const expectedRefund = addMoney(priced.map((entry) => entry.expectedRefund));
  const policyAmount = addMoney(priced.map((entry) => entry.policyAmount));
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
    orders: priced.map((entry) => ({
      orderId: entry.order.id,
      items: entry.items,
      expectedRefund: entry.expectedRefund,
    })),
    expectedRefund,
    submissionAvailable,
    refundTiming,
    subject: customerIdentityHash(customerId),
    expiresAt: Date.now() + QUOTE_LIFETIME_MS,
  };
  const instructions = policy?.returnInstructions
    ? ` The store's instructions: ${policy.returnInstructions}`
    : " Follow the store's return-shipping instructions.";
  const orderViews = priced.map((entry) => ({
    orderId: entry.order.id,
    orderName: entry.order.name,
    items: entry.items.map((item) => ({
      ...item,
      title: entry.available.find(
        (candidate) => candidate.lineItem.id === item.lineItemId,
      )!.lineItem.presentmentTitle,
    })),
    expectedRefund: entry.expectedRefund,
    returnFees: entry.returnFees,
  }));

  return {
    orders: orderViews,
    // Single-order callers keep the fields they already read; a basket shows
    // every order's name and its items together.
    orderId: orderViews[0].orderId,
    orderName: orderViews.map((view) => view.orderName).join(", "),
    items: orderViews.flatMap((view) =>
      view.items.map((item) => ({ ...item, orderName: view.orderName })),
    ),
    expectedRefund,
    submissionAvailable,
    refundTiming,
    quoteToken: signQuote(quote),
    expiresAt: new Date(quote.expiresAt).toISOString(),
    nextStep: submissionAvailable
      ? "Show the exact items, quantities, any return fees, refund amount and refund timing to the customer. Submit only after their explicit confirmation."
      : "This is a quote only. Contact the merchant to approve and complete the return. No return request has been sent and this estimate does not establish approval under the merchant's policy.",
    paymentMethod:
      refundTiming === "ON_RECEIPT"
        ? "Original payment method, refunded after the store receives the returned items. Bank posting time is not guaranteed to be immediate."
        : "Original payment method, refunded as soon as the return is confirmed, before the items are shipped back. Bank posting time is not guaranteed to be immediate.",
    returnFees: {
      restocking: totalFee(orderViews.map((view) => view.returnFees.restocking)),
      returnShipping: totalFee(
        orderViews.map((view) => view.returnFees.returnShipping),
      ),
    },
    returnShipping:
      (submissionAvailable
        ? "A return is opened for each order after confirmation. The store may add return shipping labels in Shopify."
        : "Contact the merchant for return approval. No shipping label has been created.") +
      instructions,
  };
}

// Money moves here, so the customer confirms this exact basket once. Nothing
// else is worth a question: the assistant picks the store, orders and items
// itself whenever only one reading fits.
export function chatQuoteNextStep(quote: { submissionAvailable: boolean }) {
  return {
    needsConfirmation: quote.submissionAvailable,
    nextStep: quote.submissionAvailable
      ? "In one short message show what's going back (grouped by order when there's more than one), any fees, the refund total and when it arrives. Then ask once, like \"Want me to go ahead?\", and call confirm_return only after a clear yes. Ask nothing else."
      : "The store reviews these returns itself, so nothing can be submitted from chat. Let the customer know kindly and stop.",
  };
}

type SubmittedOrder = {
  orderId: string;
  orderName: string | null;
  status: string;
  returnId: string | null;
  refundId: string | null;
  amount: string | null;
  currencyCode: string | null;
  refundStatus: string | null;
  title: string;
  message: string;
};

export async function submitReturnQuote(
  shop: string,
  customerToken: CustomerAccess,
  input: unknown,
  execute = executeAutomaticReturn,
) {
  const { quoteToken, customerNote } = confirmInputSchema.parse(input);
  const { customerId, orders } = await getReturnableOrders(shop, customerToken);
  const quote = readBoundQuote(
    quoteToken,
    shop,
    customerIdentityHash(customerId),
  );
  if (!quote.submissionAvailable)
    throw new Error("This estimate cannot submit a return or refund. Contact the merchant for approval.");
  const basket = quote.orders.length > 1;
  const submitted: SubmittedOrder[] = [];
  const failures: unknown[] = [];
  for (const selection of quote.orders) {
    const orderName =
      orders.find((order) => order.id === selection.orderId)?.name ?? null;
    try {
      // Each order keeps its own idempotency key, so a retry after a partial
      // failure never refunds an order that already succeeded.
      const result = await execute({
        shop,
        customerToken,
        orderId: selection.orderId,
        items: selection.items,
        expectedRefund: selection.expectedRefund,
        idempotencyKey: basket
          ? `${quote.id}:${selection.orderId.split("/").pop()}`
          : quote.id,
        customerNote,
        refundTiming: quote.refundTiming,
      });
      submitted.push({
        orderId: result.orderId,
        orderName: result.orderName ?? orderName,
        status: result.status,
        returnId: result.returnId,
        refundId: result.refundId,
        amount: result.amount,
        currencyCode: result.currencyCode,
        refundStatus: result.refundStatus,
        ...describeRefundProgress(result),
      });
    } catch (error) {
      // A single order answers exactly as it always has: the caller sees the
      // failure itself, never a success-shaped reply with the problem buried
      // inside. Only a basket reports per-order outcomes.
      if (!basket) throw error;
      failures.push(error);
      submitted.push({
        orderId: selection.orderId,
        orderName,
        status: "NOT_SUBMITTED",
        returnId: null,
        refundId: null,
        amount: null,
        currencyCode: null,
        refundStatus: null,
        title: "Not submitted",
        message:
          error instanceof Error
            ? error.message
            : "This order's return could not be submitted.",
      });
    }
  }

  // A basket where nothing went through is a failure, not a partial success.
  if (failures.length === submitted.length) throw failures[0];
  const [first] = submitted;
  const statuses = new Set(submitted.map((order) => order.status));
  const status = statuses.size === 1 ? first.status : "PARTIAL";
  const refunded = submitted.filter(
    (order): order is SubmittedOrder & { amount: string; currencyCode: string } =>
      Boolean(order.amount && order.currencyCode),
  );
  const total = refunded.length ? addMoney(refunded) : null;
  const summary =
    status === "PARTIAL"
      ? {
          title: "Some orders still need attention",
          message: `${refunded.length} of ${submitted.length} orders went through. Check each order below; do not submit those again.`,
        }
      : { title: first.title, message: first.message };
  return {
    status,
    orders: submitted,
    // Single-order callers keep the fields they already read.
    orderId: first.orderId,
    orderName: submitted.map((order) => order.orderName).filter(Boolean).join(", ") || null,
    returnId: basket ? null : first.returnId,
    refundId: basket ? null : first.refundId,
    amount: total?.amount ?? null,
    currencyCode: total?.currencyCode ?? null,
    refundStatus: basket ? null : first.refundStatus,
    paymentMethod: "Original payment method",
    ...summary,
  };
}
