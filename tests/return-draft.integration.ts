import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../app/db.server";
import { claimIntakeDraft, getReturnSession, saveReturnQuote, markDraftSubmitted, restoreDraftQuote } from "../app/services/return-draft.server";
import { startReturnIntake, readContinuation } from "../app/services/return-intake.server";
import { signQuote, seal } from "../app/services/customer-security.server";
import { readBoundQuote } from "../app/services/return-quote.server";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(["localhost", "127.0.0.1"].includes(database.hostname) && database.pathname === "/refund_ci", "Requires isolated refund_ci PostgreSQL database");
process.env.SHOPIFY_APP_URL = "https://refund.test";
const shop = `draft-${randomUUID()}.myshopify.com`;
const context = { shop, customerSubjectHash: "verified-a" };
function quote(number: string) {
  const expiresAt = Date.now() + 600_000;
  const items = [{ lineItemId: `gid://shopify/LineItem/${number}`, quantity: 1 }];
  const expectedRefund = { amount: number, currencyCode: "CAD" };
  const value = {
    version: 1, id: randomUUID(), shop, subject: context.customerSubjectHash, submissionAvailable: true,
    orderId: `gid://shopify/Order/${number}`, items,
    orders: [{ orderId: `gid://shopify/Order/${number}`, items, expectedRefund }],
    expectedRefund, expiresAt,
  };
  const shown = items.map(item => ({ ...item, title: `Item ${number}`, orderName: `#${number}` }));
  return { ...value, items: shown, orderName: `#${number}`,
    orders: [{ orderId: `gid://shopify/Order/${number}`, orderName: `#${number}`, items: shown, expectedRefund, returnFees: { restocking: null, returnShipping: null } }],
    quoteToken: signQuote(value), expiresAt: new Date(expiresAt).toISOString(), paymentMethod: "Original", refundTiming: "IMMEDIATE" as const, returnFees: { restocking: null, returnShipping: null }, returnShipping: "Store instructions", nextStep: "Stop at quote" };
}
try {
  await prisma.session.create({ data: { id: `offline_${shop}`, shop, isOnline: false, state: "test", accessToken: "test-only-never-sent" } });
  const input = { merchant: shop, itemName: "Snowboard", idempotencyKey: randomUUID() };
  const intake = await startReturnIntake(input);
  assert.equal(intake.status, "verification_required");
  if (intake.status !== "verification_required") throw new Error("Expected intake");
  const repeated = await startReturnIntake(input);
  assert.equal(repeated.correlationId, intake.correlationId);
  await assert.rejects(startReturnIntake({ ...input, itemName: "Changed" }), error => error instanceof Response && error.status === 409);
  const continuation = readContinuation(new URL(intake.continueUrl).searchParams.get("continuation")!, shop);
  assert.equal(continuation.draftId, intake.correlationId);
  const draftId = intake.correlationId;
  const customer = { ...context, draftId };
  assert.equal((await getReturnSession(customer)).draftActive, false, "Anonymous intake is not readable as customer data");
  await claimIntakeDraft(customer);
  await assert.rejects(claimIntakeDraft({ ...customer, customerSubjectHash: "verified-b" }));
  assert.equal((await getReturnSession(customer)).correlationId, draftId);
  assert.equal((await getReturnSession({ ...customer, customerSubjectHash: "verified-b" })).correlationId, null);
  assert.equal((await getReturnSession({ ...customer, shop: "other.myshopify.com" })).correlationId, null);

  const a = quote("10"), b = quote("20");
  const results = await Promise.allSettled([saveReturnQuote(customer, a), saveReturnQuote(customer, b)]);
  assert.ok(results.some(value => value.status === "fulfilled"));
  const resumed = await getReturnSession(customer);
  const bound = readBoundQuote(resumed.quoteToken!, shop, context.customerSubjectHash);
  assert.equal(bound.orderId, resumed.orderId);
  assert.equal(bound.expectedRefund.amount, resumed.quote?.expectedRefund.amount);
  const chosen = bound.orderId === a.orderId ? a : b;
  const retry = await saveReturnQuote(customer, quote(bound.orderId === a.orderId ? "10" : "20"));
  assert.equal(retry.quote.quoteToken, resumed.quoteToken, "Same selection and amount reuse the current quote key");
  const stored = await prisma.returnDraft.findUniqueOrThrow({ where: { id: draftId } });
  assert.notEqual(stored.sealedQuoteToken, resumed.quoteToken);
  const wrong = bound.orderId === a.orderId ? b : a;
  assert.equal(restoreDraftQuote({ ...stored, sealedQuoteToken: seal(wrong.quoteToken, `return-draft:${draftId}:${shop}`) }, customer), null);

  await prisma.agentReturn.create({ data: { shop, customerSubjectHash: context.customerSubjectHash, orderId: chosen.orderId, requestedLineItems: chosen.items, idempotencyKey: bound.id, status: "NEEDS_ATTENTION" } });
  const newer = await saveReturnQuote(customer, wrong);
  await markDraftSubmitted(customer, { status: "REFUND_SUBMITTED" }, bound.id);
  assert.equal((await prisma.returnDraft.findUniqueOrThrow({ where: { id: draftId } })).quoteId, newer.quoteId);
  assert.equal((await getReturnSession(customer)).submissions[0].status, "NEEDS_ATTENTION");
  await prisma.returnDraft.update({ where: { id: draftId }, data: { expiresAt: new Date(Date.now() - 1) } });
  const expired = await getReturnSession(customer);
  assert.equal(expired.submitted, true);
  assert.equal(expired.status, "NEEDS_ATTENTION");
  assert.equal(expired.quoteValid, false);
  assert.match(expired.recovery, /do not repeat/);
  await prisma.returnDraft.delete({ where: { id: draftId } });
  assert.equal((await getReturnSession(context)).submitted, true, "Removing the draft must not remove submission status");
  console.log("Passed: persistent intake/retry, claim ownership, concurrent quote integrity, stable retry tokens, corrupt token rejection, expiry/replacement/deletion status, quote-scoped completion.");
} finally {
  await prisma.returnDraft.deleteMany({ where: { shop } });
  await prisma.agentReturn.deleteMany({ where: { shop } });
  await prisma.session.deleteMany({ where: { shop } });
  await prisma.$disconnect();
}
