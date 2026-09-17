import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../app/db.server";
import {
  fundedPaymentProvider,
  ingestProviderEvent,
  requestSandboxPayment,
} from "../app/services/funded-payment-intents.server";
import {
  createFundedSandbox,
  listFundedSandboxes,
  updateFundedSandbox,
} from "../app/services/funded-return-sandbox.server";
import {
  planSandboxScenario,
  releaseSandboxEvents,
  type SandboxScenario,
} from "../app/services/funded-sandbox-provider.server";
import {
  describeFundedPaymentsCycle,
  fundedPaymentsHealth,
  runFundedPaymentsCycle,
  STUCK_AFTER_MS,
  UNDISPATCHED_AFTER_MS,
} from "../app/services/funded-payments-worker.server";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.pathname === "/refund_ci",
  "Requires isolated refund_ci PostgreSQL database",
);
process.env.NODE_ENV = "test";
process.env.GOOPER_FUNDED_RETURNS_SANDBOX = "1";

const shops: string[] = [];
const provider = fundedPaymentProvider();
const scope = { shop: { in: shops } };

async function payoutRequested(scenario: SandboxScenario) {
  const shop = `worker-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  const id = randomUUID();
  await createFundedSandbox(shop, id, "CAD");
  await updateFundedSandbox(shop, id, 0, {
    id: randomUUID(),
    action: "APPROVE_RISK",
  });
  const intent = await requestSandboxPayment({
    shop,
    caseId: id,
    version: 1,
    commandId: randomUUID(),
    operation: "payout",
  });
  await planSandboxScenario(
    shop,
    {
      idempotencyKey: intent.id,
      operation: "PAYOUT",
      amountMinor: intent.amountMinor,
      currency: "CAD",
    },
    scenario,
  );
  return { shop, id, intent };
}
const statusOf = async (id: string) =>
  (await prisma.fundedPaymentIntent.findUniqueOrThrow({ where: { id } })).status;
const caseOf = async (shop: string, id: string) =>
  (await listFundedSandboxes(shop)).find((row) => row.id === id)!.state;

try {
  // One cycle submits every shop's queued payments, then reconciles.
  const good = await payoutRequested("SUCCEED");
  const timedOut = await payoutRequested("TIMEOUT_AFTER_ACCEPT");
  const lost = await payoutRequested("LOST_BEFORE_ACCEPT");
  const first = await runFundedPaymentsCycle(provider);
  assert.equal(first.submitted, 3, "Every shop's queued intent was submitted");
  assert.equal(await statusOf(good.intent.id), "PENDING");
  assert.equal(await statusOf(timedOut.intent.id), "UNKNOWN");
  assert.equal(await statusOf(lost.intent.id), "UNKNOWN");
  assert.equal(first.health.review, 0);

  // A later cycle looks up unresolved payments. The lost request is
  // resubmitted with the same key; the accepted one is never sent twice.
  const later = new Date(Date.now() + 10 * 60_000);
  for (const shop of [good.shop, timedOut.shop]) await releaseSandboxEvents(shop);
  const second = await runFundedPaymentsCycle(provider, { now: later });
  assert.equal(second.submitted, 0, "Nothing new was queued");
  assert.equal(second.resubmitted, 1, "Only the never-accepted request");
  assert.equal(await statusOf(timedOut.intent.id), "SUCCEEDED");
  assert.equal((await caseOf(timedOut.shop, timedOut.id)).payout, "SUCCEEDED");
  for (const shop of shops)
    assert.ok(
      (await prisma.fundedSandboxProviderPayment.count({
        where: { shop, reference: { not: null } },
      })) <= 1,
      "At most one provider payment per intent",
    );

  // A webhook the provider never sent for a confirmed failure is a
  // contradiction: held for review, and the worker reports it.
  const failing = await payoutRequested("FAIL_THEN_LATE_SUCCESS");
  await runFundedPaymentsCycle(provider);
  for (const delivery of await releaseSandboxEvents(failing.shop))
    await ingestProviderEvent(provider, delivery.rawBody, delivery.headers);
  assert.equal(await statusOf(failing.intent.id), "FAILED");
  for (const delivery of await releaseSandboxEvents(failing.shop))
    await ingestProviderEvent(provider, delivery.rawBody, delivery.headers);
  assert.equal(await statusOf(failing.intent.id), "REVIEW");
  const health = await fundedPaymentsHealth(provider);
  assert.ok(health.review >= 1);
  assert.match(
    describeFundedPaymentsCycle({ ...first, health }),
    /NEEDS ATTENTION: \d+ held for review/,
  );

  // Ageing thresholds: an old unresolved intent and an old queued one show up.
  const aged = await payoutRequested("SUCCEED");
  const aging = new Date(Date.now() + STUCK_AFTER_MS + UNDISPATCHED_AFTER_MS);
  const agedHealth = await fundedPaymentsHealth(provider, aging);
  assert.ok(agedHealth.undispatched >= 1, "Queued too long is reported");
  assert.ok(agedHealth.stuck >= 1, "Unresolved too long is reported");
  assert.ok((agedHealth.oldestUnresolvedMinutes ?? 0) >= 15);
  assert.equal(await statusOf(aged.intent.id), "QUEUED");
  assert.match(
    describeFundedPaymentsCycle({ ...first, health: agedHealth }),
    /never submitted over 5m/,
  );

  // Production refuses to run a cycle at all.
  process.env.NODE_ENV = "production";
  await assert.rejects(
    runFundedPaymentsCycle(provider),
    (error: unknown) => error instanceof Response && error.status === 404,
  );
  process.env.NODE_ENV = "test";
  console.log(
    "Passed: worker cycle across shops, lookup-only recovery, no duplicate provider payments, review and ageing alerts, production lockout.",
  );
} finally {
  process.env.NODE_ENV = "test";
  await prisma.fundedPaymentEvent.deleteMany({ where: scope });
  await prisma.fundedPaymentIntent.deleteMany({ where: scope });
  await prisma.fundedSandboxProviderPayment.deleteMany({ where: scope });
  await prisma.fundedReturnSandbox.deleteMany({ where: scope });
  await prisma.$disconnect();
}
