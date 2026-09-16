import type { Prisma, ReturnDraft } from "@prisma/client";
import prisma from "../db.server";
import { describeRefundProgress } from "../refund-status";
import { seal, unseal } from "./customer-security.server";
import { readBoundQuote, returnItemsSchema, type createReturnQuote } from "./return-quote.server";
import { moneyAmountsMatch } from "./return-guards.server";

export type CustomerContext = {
  shop: string;
  customerSubjectHash: string;
  draftId?: string | null;
};
type Quote = Awaited<ReturnType<typeof createReturnQuote>>;
const DRAFT_LIFETIME_MS = 14 * 24 * 60 * 60_000;
const owner = (context: CustomerContext) => ({
  shop: context.shop, customerSubjectHash: context.customerSubjectHash,
});
type Basket = Array<{
  orderId: string;
  items: Array<{ lineItemId: string; quantity: number }>;
}>;

// A basket is the same whatever order the assistant listed it in.
const sameBasket = (left: Basket, right: Basket) => {
  const normalize = (basket: Basket) =>
    JSON.stringify(
      [...basket]
        .map((order) => ({
          orderId: order.orderId,
          items: [...order.items]
            .map((item) => ({ lineItemId: item.lineItemId, quantity: item.quantity }))
            .sort((a, b) => a.lineItemId.localeCompare(b.lineItemId)),
        }))
        .sort((a, b) => a.orderId.localeCompare(b.orderId)),
    );
  return Boolean(left.length) && normalize(left) === normalize(right);
};

// Drafts saved before baskets existed hold one order beside its items.
const savedBasket = (draft: ReturnDraft, snapshot: Snapshot | null): Basket =>
  snapshot?.orders?.length
    ? snapshot.orders.map((order) => ({ orderId: order.orderId, items: order.items }))
    : draft.orderId
      ? [
          {
            orderId: draft.orderId,
            items: returnItemsSchema.safeParse(draft.selectedItems).data ?? [],
          },
        ]
      : [];

type Snapshot = {
  expectedRefund?: Quote["expectedRefund"];
  paymentMethod?: string;
  returnShipping?: string;
  returnFees?: Quote["returnFees"];
  orders?: Quote["orders"];
} | null;

// Only a validated continuation after Shopify verification may claim an intake.
// Knowing a correlation ID alone never authorizes this operation. Accepts a
// transaction client so a caller can commit the claim atomically with
// whatever else depends on it (e.g. the session that lets the customer use it).
export async function claimIntakeDraft(
  context: CustomerContext & { draftId: string },
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const claimed = await client.returnDraft.updateMany({
    where: {
      id: context.draftId, shop: context.shop,
      expiresAt: { gt: new Date() },
      OR: [{ customerSubjectHash: null }, { customerSubjectHash: context.customerSubjectHash }],
    },
    data: { customerSubjectHash: context.customerSubjectHash, expiresAt: new Date(Date.now() + DRAFT_LIFETIME_MS) },
  });
  if (claimed.count !== 1)
    throw new Error("This return link expired or belongs to another customer. Start again from the store.");
}

export async function findCustomerDraft(context: CustomerContext) {
  return prisma.returnDraft.findFirst({
    where: { ...owner(context), ...(context.draftId ? { id: context.draftId } : {}) },
    orderBy: { updatedAt: "desc" },
  });
}

async function ensureDraft(context: CustomerContext) {
  const existing = await findCustomerDraft(context);
  if (existing && existing.expiresAt.getTime() > Date.now()) return existing;
  if (context.draftId)
    throw new Error("This draft expired or is unavailable. Start again from the store; use check_return_status to inspect earlier submissions.");
  return prisma.returnDraft.create({ data: { ...owner(context), expiresAt: new Date(Date.now() + DRAFT_LIFETIME_MS) } });
}

export async function notePurchaseLookup(context: CustomerContext) {
  const draft = await ensureDraft(context);
  await prisma.returnDraft.updateMany({
    where: { id: draft.id, ...owner(context), stage: "VERIFICATION_REQUIRED" },
    data: { stage: "PURCHASES_FOUND" },
  });
  return draft;
}

// Validate the signature AND its equality to the saved display data. Legacy or
// corrupt mismatches fail closed even if decryption itself succeeds.
export function restoreDraftQuote(draft: ReturnDraft, context: CustomerContext): Quote | null {
  if (!draft.sealedQuoteToken || !draft.quoteExpiresAt ||
      draft.expiresAt.getTime() <= Date.now() || draft.quoteExpiresAt.getTime() <= Date.now()) return null;
  try {
    const quoteToken = unseal(draft.sealedQuoteToken, `return-draft:${draft.id}:${context.shop}`);
    const bound = readBoundQuote(quoteToken, context.shop, context.customerSubjectHash);
    const snapshot = draft.quoteSnapshot as Snapshot;
    const saved = savedBasket(draft, snapshot);
    if (bound.id !== draft.quoteId ||
        bound.expiresAt !== draft.quoteExpiresAt.getTime() ||
        !sameBasket(saved, bound.orders) ||
        !snapshot?.expectedRefund ||
        !moneyAmountsMatch(snapshot.expectedRefund.amount, bound.expectedRefund.amount) ||
        snapshot.expectedRefund.currencyCode !== bound.expectedRefund.currencyCode) return null;
    const orders: Quote["orders"] = snapshot.orders?.length
      ? snapshot.orders
      : [
          {
            orderId: bound.orders[0].orderId,
            orderName: draft.orderName || "",
            items: draft.selectedItems as Quote["orders"][number]["items"],
            expectedRefund: bound.orders[0].expectedRefund,
            returnFees: snapshot.returnFees || { restocking: null, returnShipping: null },
          },
        ];
    return {
      orders,
      orderId: orders[0].orderId, orderName: draft.orderName || "",
      items: orders.flatMap((order) =>
        order.items.map((item) => ({ ...item, orderName: order.orderName })),
      ) as Quote["items"], expectedRefund: bound.expectedRefund,
      submissionAvailable: bound.submissionAvailable,
      refundTiming: bound.refundTiming,
      quoteId: bound.id,
      quoteToken, expiresAt: draft.quoteExpiresAt.toISOString(),
      paymentMethod: snapshot.paymentMethod || "Original payment method.",
      returnFees: snapshot.returnFees || { restocking: null, returnShipping: null },
      returnShipping: snapshot.returnShipping || "Follow the store's instructions.",
      nextStep: bound.submissionAvailable
        ? "Review the exact quote. Stop before submission unless the customer explicitly confirms it."
        : "Quote only. Contact the merchant for approval. No return request has been sent.",
    };
  } catch { return null; }
}

function sameQuote(a: Quote, b: Quote) {
  return a.submissionAvailable === b.submissionAvailable && a.refundTiming === b.refundTiming && sameBasket(a.orders, b.orders) &&
    a.expectedRefund.currencyCode === b.expectedRefund.currencyCode &&
    moneyAmountsMatch(a.expectedRefund.amount, b.expectedRefund.amount);
}

export async function saveReturnQuote(context: CustomerContext, quote: Quote) {
  const bound = readBoundQuote(quote.quoteToken, context.shop, context.customerSubjectHash);
  if (bound.submissionAvailable !== quote.submissionAvailable || bound.refundTiming !== quote.refundTiming || !sameBasket(quote.orders, bound.orders) ||
      !moneyAmountsMatch(bound.expectedRefund.amount, quote.expectedRefund.amount) ||
      bound.expectedRefund.currencyCode !== quote.expectedRefund.currencyCode)
    throw new Error("Quote details do not match their signed authorization.");
  const draft = await ensureDraft(context);
  const prior = restoreDraftQuote(draft, context);
  if (prior && sameQuote(prior, quote)) return { ...draft, quote: prior };
  // Compare-and-swap prevents overlapping requests from overwriting each other.
  // All quote fields, including the encrypted token, commit in one statement.
  await prisma.returnDraft.updateMany({
    where: { id: draft.id, ...owner(context), quoteId: draft.quoteId, stage: draft.stage },
    data: {
      stage: "QUOTED", orderId: quote.orders[0].orderId, orderName: quote.orderName,
      selectedItems: quote.orders.flatMap((order) =>
        order.items.map((item) => ({ lineItemId: item.lineItemId, quantity: item.quantity })),
      ),
      quoteSnapshot: { expectedRefund: quote.expectedRefund, paymentMethod: quote.paymentMethod, returnShipping: quote.returnShipping, returnFees: quote.returnFees, orders: quote.orders },
      quoteId: bound.id, quoteExpiresAt: new Date(bound.expiresAt),
      sealedQuoteToken: seal(quote.quoteToken, `return-draft:${draft.id}:${context.shop}`),
      expiresAt: new Date(Date.now() + DRAFT_LIFETIME_MS),
    },
  });
  const current = await findCustomerDraft({ ...context, draftId: draft.id });
  const restored = current && restoreDraftQuote(current, context);
  if (!current || !restored || !sameQuote(restored, quote))
    throw new Error("The draft changed in another request. Use get_return_session before requesting another quote.");
  return { ...current, quote: restored };
}

export async function getReturnSession(context: CustomerContext) {
  const [draft, records] = await Promise.all([
    findCustomerDraft(context),
    // Submission history is independent of draft expiry and replacement.
    prisma.agentReturn.findMany({
      where: owner(context), orderBy: { createdAt: "desc" }, take: 20,
      select: { id: true, idempotencyKey: true, orderId: true, orderName: true, status: true, refundStatus: true, returnId: true, refundId: true, amount: true, currencyCode: true, createdAt: true },
    }),
  ]);
  const submissions = records.map(record => ({
    ...record, ...describeRefundProgress(record),
    paymentMethod: "Original payment method",
    createdAt: record.createdAt.toISOString(),
  }));
  const active = Boolean(draft && draft.expiresAt.getTime() > Date.now());
  // A request Shopify turned down submitted nothing, so it doesn't block trying again.
  const attempts = records.filter(record => record.status !== "NOT_SUBMITTED");
  const currentSubmission = attempts.find(record => record.idempotencyKey === draft?.quoteId)
    || (draft?.quoteId ? (await prisma.agentReturn.findMany({
      where: { ...owner(context), idempotencyKey: draft.quoteId, status: { not: "NOT_SUBMITTED" } }, take: 1,
    }))[0] : undefined);
  const quote = active && draft && !currentSubmission ? restoreDraftQuote(draft, context) : null;
  return {
    status: currentSubmission?.status || (active ? draft!.stage.toLowerCase() : records[0]?.status || "no_active_draft"),
    correlationId: draft?.id || null,
    draftActive: active,
    orderId: active ? draft!.orderId : null,
    orderName: active ? draft!.orderName : null,
    items: active ? draft!.selectedItems : null,
    quote: quote || null,
    quoteExpiresAt: active ? draft!.quoteExpiresAt?.toISOString() || null : null,
    quoteToken: quote?.quoteToken,
    quoteValid: Boolean(quote),
    // Means an attempt exists, not that Shopify completed a refund.
    submitted: attempts.length > 0 || Boolean(currentSubmission),
    currentDraftSubmitted: Boolean(currentSubmission),
    submissions,
    returnId: currentSubmission?.returnId || null,
    refundId: currentSubmission?.refundId || null,
    recovery: currentSubmission || (!active && attempts.length)
      ? "A prior submission attempt exists. Review submissions; do not repeat a return or refund. Contact the merchant if it needs attention."
      : quote
        ? "Review the restored quote and stop before submission. Earlier attempts, if any, are listed separately in submissions."
        : active
          ? "Use find_returnable_items and quote_return to prepare a fresh quote. Review any previous submission attempts first."
          : "No active draft. Review submissions before starting again from the store.",
  };
}

// confirm_return takes the short quote id, so the sealed token the customer's
// own draft holds is what authorizes the submission. Scoped to this customer
// and store: another customer's quote id simply isn't found here.
export async function sealedQuoteFor(context: CustomerContext, quoteId: string) {
  const draft = await prisma.returnDraft.findFirst({
    where: { ...owner(context), quoteId },
    orderBy: { updatedAt: "desc" },
  });
  if (!draft)
    throw new Error(
      "That quote isn't one of this customer's. Quote the return again, then confirm the quote it returns.",
    );
  if (!draft.sealedQuoteToken)
    throw new Error(
      "That quote was already submitted. Use check_return_status to see what went through; never submit the same return twice.",
    );
  return unseal(draft.sealedQuoteToken, `return-draft:${draft.id}:${context.shop}`);
}

export async function markDraftSubmitted(context: CustomerContext, result: { status: string }, quoteId: string) {
  await prisma.returnDraft.updateMany({
    where: { ...owner(context), quoteId },
    data: { stage: result.status, sealedQuoteToken: null },
  });
}
