import prisma from "../db.server";
import { seal, unseal } from "./customer-security.server";
import { readBoundQuote } from "./return-quote.server";

type CustomerContext = {
  shop: string;
  customerSubjectHash: string;
};

const DRAFT_LIFETIME_MS = 14 * 24 * 60 * 60_000;

export async function notePurchaseLookup(context: CustomerContext) {
  const expiresAt = new Date(Date.now() + DRAFT_LIFETIME_MS);
  return prisma.returnDraft.upsert({
    where: {
      shop_customerSubjectHash: {
        shop: context.shop,
        customerSubjectHash: context.customerSubjectHash,
      },
    },
    create: { ...context, expiresAt },
    // A later read must not erase an already quoted or submitted stage.
    update: { expiresAt },
  });
}

export async function saveReturnQuote(
  context: CustomerContext,
  quote: {
    orderId: string;
    orderName: string;
    items: Array<{ lineItemId: string; quantity: number; title: string }>;
    expectedRefund: { amount: string; currencyCode: string };
    quoteToken: string;
    expiresAt: string;
    paymentMethod: string;
    returnShipping: string;
  },
) {
  const bound = readBoundQuote(
    quote.quoteToken,
    context.shop,
    context.customerSubjectHash,
  );
  const draft = await prisma.returnDraft.upsert({
    where: {
      shop_customerSubjectHash: {
        shop: context.shop,
        customerSubjectHash: context.customerSubjectHash,
      },
    },
    create: {
      ...context,
      stage: "QUOTED",
      orderId: quote.orderId,
      orderName: quote.orderName,
      selectedItems: quote.items,
      quoteSnapshot: {
        expectedRefund: quote.expectedRefund,
        paymentMethod: quote.paymentMethod,
        returnShipping: quote.returnShipping,
      },
      quoteId: bound.id,
      quoteExpiresAt: new Date(quote.expiresAt),
      expiresAt: new Date(Date.now() + DRAFT_LIFETIME_MS),
    },
    update: {
      stage: "QUOTED",
      orderId: quote.orderId,
      orderName: quote.orderName,
      selectedItems: quote.items,
      quoteSnapshot: {
        expectedRefund: quote.expectedRefund,
        paymentMethod: quote.paymentMethod,
        returnShipping: quote.returnShipping,
      },
      quoteId: bound.id,
      quoteExpiresAt: new Date(quote.expiresAt),
      expiresAt: new Date(Date.now() + DRAFT_LIFETIME_MS),
    },
  });
  return prisma.returnDraft.update({
    where: { id: draft.id },
    data: {
      sealedQuoteToken: seal(
        quote.quoteToken,
        `return-draft:${draft.id}:${context.shop}`,
      ),
    },
  });
}

export async function getReturnSession(context: CustomerContext) {
  const draft = await prisma.returnDraft.findUnique({
    where: {
      shop_customerSubjectHash: {
        shop: context.shop,
        customerSubjectHash: context.customerSubjectHash,
      },
    },
  });
  if (!draft || draft.expiresAt.getTime() <= Date.now()) {
    return {
      status: "no_active_draft",
      submitted: false,
      nextStep: "Use find_returnable_items, then quote_return to start again.",
    };
  }
  const submission = draft.quoteId
    ? await prisma.agentReturn.findUnique({
        where: {
          shop_idempotencyKey: { shop: context.shop, idempotencyKey: draft.quoteId },
        },
      })
    : null;
  const quoteValid = Boolean(
    draft.sealedQuoteToken &&
      draft.quoteExpiresAt &&
      draft.quoteExpiresAt.getTime() > Date.now() &&
      !submission,
  );
  let quoteToken: string | undefined;
  if (quoteValid) {
    try {
      quoteToken = unseal(
        draft.sealedQuoteToken!,
        `return-draft:${draft.id}:${context.shop}`,
      );
    } catch {
      quoteToken = undefined;
    }
  }
  return {
    status: submission?.status || draft.stage.toLowerCase(),
    correlationId: draft.id,
    orderId: draft.orderId,
    orderName: draft.orderName,
    items: draft.selectedItems,
    quote: draft.quoteSnapshot,
    quoteExpiresAt: draft.quoteExpiresAt?.toISOString() || null,
    quoteToken,
    quoteValid: Boolean(quoteToken),
    submitted: Boolean(submission),
    returnId: submission?.returnId || null,
    refundId: submission?.refundId || null,
    recovery: submission
      ? "Do not submit again. Use this status and contact the merchant with the correlationId if it needs attention."
      : quoteToken
        ? "The quote can be reviewed again. Do not submit unless the customer explicitly confirms the exact items and amount."
        : "The quote expired or could not be restored. Run quote_return again before asking for confirmation.",
  };
}

export async function markDraftSubmitted(
  context: CustomerContext,
  result: { status: string },
) {
  await prisma.returnDraft.updateMany({
    where: { ...context },
    data: { stage: result.status, sealedQuoteToken: null },
  });
}
