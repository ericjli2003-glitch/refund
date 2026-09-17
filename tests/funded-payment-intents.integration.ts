import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../app/db.server";
import { sandboxBalances } from "../app/funded-return-sandbox";
import {
  createFundedSandbox,
  listFundedSandboxes,
  updateFundedSandbox,
} from "../app/services/funded-return-sandbox.server";
import {
  dispatchPaymentIntents,
  fundedPaymentProvider,
  ingestProviderEvent,
  reconcilePaymentIntents,
  requestSandboxPayment,
  SUBMISSION_LEASE_MS,
} from "../app/services/funded-payment-intents.server";
import {
  planSandboxScenario,
  releaseSandboxEvents,
  replaySandboxEvents,
  SANDBOX_SIGNATURE_HEADER,
  type SandboxScenario,
} from "../app/services/funded-sandbox-provider.server";
import { signEventBody } from "../app/services/funded-payment-provider.server";

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

async function newCase() {
  const shop = `payments-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  const id = randomUUID();
  await createFundedSandbox(shop, id, "CAD");
  await updateFundedSandbox(shop, id, 0, {
    id: randomUUID(),
    action: "APPROVE_RISK",
  });
  return { shop, id };
}
async function current(shop: string, id: string) {
  return (await listFundedSandboxes(shop)).find((row) => row.id === id)!;
}
async function request(
  shop: string,
  id: string,
  operation: "payout" | "collection",
  scenario: SandboxScenario,
) {
  const row = await current(shop, id);
  const intent = await requestSandboxPayment({
    shop,
    caseId: id,
    version: row.version,
    commandId: randomUUID(),
    operation,
  });
  await planSandboxScenario(
    shop,
    {
      idempotencyKey: intent.id,
      operation: intent.operation as "PAYOUT" | "COLLECTION",
      amountMinor: intent.amountMinor,
      currency: intent.currency as "CAD",
    },
    scenario,
  );
  return intent;
}
async function deliverAll(shop: string) {
  const results = [];
  for (const delivery of await releaseSandboxEvents(shop))
    results.push(
      await ingestProviderEvent(provider, delivery.rawBody, delivery.headers),
    );
  return results;
}
const intent = (id: string) =>
  prisma.fundedPaymentIntent.findUniqueOrThrow({ where: { id } });
const providerPayments = (shop: string) =>
  prisma.fundedSandboxProviderPayment.count({
    where: { shop, reference: { not: null } },
  });

try {
  // 1. Happy path: webhook settles payout, then explicit receipt + approval,
  //    then collection; replayed webhooks change nothing.
  {
    const { shop, id } = await newCase();
    const payout = await request(shop, id, "payout", "SUCCEED");
    assert.equal(payout.status, "QUEUED");
    assert.equal((await current(shop, id)).state.payout, "PENDING");
    assert.equal(await providerPayments(shop), 0, "Nothing sent before dispatch");
    assert.deepEqual(await dispatchPaymentIntents(provider, { shop }), {
      submitted: 1,
    });
    assert.deepEqual(await dispatchPaymentIntents(provider, { shop }), {
      submitted: 0,
    });
    assert.equal((await intent(payout.id)).status, "PENDING");
    assert.equal(sandboxBalances((await current(shop, id)).state).GOOPER_CASH, 0);
    assert.deepEqual(await deliverAll(shop), ["APPLIED"]);
    let row = await current(shop, id);
    assert.equal(row.state.payout, "SUCCEEDED");
    assert.equal(sandboxBalances(row.state).GOOPER_CASH, -5000);
    for (const delivery of await replaySandboxEvents(shop))
      assert.equal(
        await ingestProviderEvent(provider, delivery.rawBody, delivery.headers),
        "DUPLICATE",
      );
    assert.equal((await current(shop, id)).version, row.version);

    await assert.rejects(
      request(shop, id, "collection", "SUCCEED"),
      "No collection before receipt and approval",
    );
    await updateFundedSandbox(shop, id, row.version, {
      id: randomUUID(),
      action: "RECEIVE_ITEM",
    });
    await assert.rejects(
      request(shop, id, "collection", "SUCCEED"),
      "Receipt alone never creates a collection",
    );
    row = await current(shop, id);
    await updateFundedSandbox(shop, id, row.version, {
      id: randomUUID(),
      action: "INSPECT_ITEM",
      acceptedMinor: 3000,
    });
    const collection = await request(shop, id, "collection", "SUCCEED");
    assert.equal(collection.amountMinor, 3000);
    await dispatchPaymentIntents(provider, { shop });
    assert.deepEqual(await deliverAll(shop), ["APPLIED"]);
    row = await current(shop, id);
    assert.equal(row.state.collection, "SETTLED");
    assert.deepEqual(sandboxBalances(row.state), {
      GOOPER_CASH: -2000,
      FUNDED_EXPOSURE: 2000,
      MERCHANT_RECEIVABLE: 0,
    });
    // The workflow cannot be driven with asserted outcomes.
    await assert.rejects(
      updateFundedSandbox(shop, id, row.version, {
        id: randomUUID(),
        action: "COLLECTION_SUCCEEDED",
        payment: {
          intentId: collection.id,
          attempt: 1,
          amountMinor: 3000,
          currency: "CAD",
        },
      }),
    );
  }

  // 2. Signatures: tampered, unsigned and stale deliveries are rejected.
  {
    const { shop, id } = await newCase();
    await request(shop, id, "payout", "SUCCEED");
    await dispatchPaymentIntents(provider, { shop });
    const [delivery] = await releaseSandboxEvents(shop);
    const tampered = delivery.rawBody.replace('"amountMinor":5000', '"amountMinor":1');
    await assert.rejects(
      ingestProviderEvent(provider, tampered, delivery.headers),
    );
    await assert.rejects(
      ingestProviderEvent(provider, delivery.rawBody, new Headers()),
    );
    const stale = new Headers({
      [SANDBOX_SIGNATURE_HEADER]: signEventBody(
        "not-the-secret",
        delivery.rawBody,
        new Date(),
      ),
    });
    await assert.rejects(ingestProviderEvent(provider, delivery.rawBody, stale));
    await assert.rejects(
      ingestProviderEvent(
        provider,
        delivery.rawBody,
        delivery.headers,
        new Date(Date.now() + 10 * 60_000),
      ),
    );
    assert.equal((await current(shop, id)).state.payout, "PENDING");
    assert.equal(
      await ingestProviderEvent(provider, delivery.rawBody, delivery.headers),
      "APPLIED",
    );
  }

  // 3. Accepted, but the response timed out: unknown, then reconciled by
  //    lookup without a second provider payment.
  {
    const { shop, id } = await newCase();
    const payout = await request(shop, id, "payout", "TIMEOUT_AFTER_ACCEPT");
    await dispatchPaymentIntents(provider, { shop });
    assert.equal((await intent(payout.id)).status, "UNKNOWN");
    assert.equal((await current(shop, id)).state.payout, "UNKNOWN");
    const now = new Date(Date.now() + 5 * 60_000);
    await releaseSandboxEvents(shop); // provider settles; webhook is lost
    const summary = await reconcilePaymentIntents(provider, { shop, now });
    assert.equal(summary.resubmitted, 0);
    assert.equal((await intent(payout.id)).status, "SUCCEEDED");
    assert.equal((await current(shop, id)).state.payout, "SUCCEEDED");
    assert.equal(await providerPayments(shop), 1);
    assert.equal((await intent(payout.id)).submissions, 1);
  }

  // 4. Request lost before the provider saw it: lookup finds nothing, so it is
  //    resubmitted with the SAME idempotency key. Still exactly one payment.
  {
    const { shop, id } = await newCase();
    const payout = await request(shop, id, "payout", "LOST_BEFORE_ACCEPT");
    await dispatchPaymentIntents(provider, { shop });
    assert.equal((await intent(payout.id)).status, "UNKNOWN");
    assert.equal(await providerPayments(shop), 0);
    const summary = await reconcilePaymentIntents(provider, {
      shop,
      now: new Date(Date.now() + 5 * 60_000),
    });
    assert.equal(summary.resubmitted, 1);
    assert.equal((await intent(payout.id)).submissions, 2);
    assert.equal(await providerPayments(shop), 1);
    assert.deepEqual(await deliverAll(shop), ["APPLIED"]);
    assert.equal((await current(shop, id)).state.payoutAttempt, 1);
  }

  // 5. Crash mid-submit: an expired lease becomes unknown and is looked up.
  {
    const { shop, id } = await newCase();
    const payout = await request(shop, id, "payout", "SUCCEED");
    await prisma.fundedPaymentIntent.update({
      where: { id: payout.id },
      data: {
        status: "SUBMITTING",
        submissions: 1,
        leaseUntil: new Date(),
        version: { increment: 1 },
      },
    });
    await provider.submit({
      idempotencyKey: payout.id,
      shop,
      caseId: id,
      operation: "PAYOUT",
      attempt: 1,
      amountMinor: 5000,
      currency: "CAD",
    }); // reached the provider before the process died
    const summary = await reconcilePaymentIntents(provider, {
      shop,
      now: new Date(Date.now() + SUBMISSION_LEASE_MS + 1000),
    });
    assert.equal(summary.recovered, 1);
    assert.equal(summary.resubmitted, 0);
    assert.equal((await intent(payout.id)).status, "PENDING");
    assert.equal((await current(shop, id)).state.payout, "UNKNOWN");
    assert.deepEqual(await deliverAll(shop), ["APPLIED"]);
    assert.equal((await current(shop, id)).state.payout, "SUCCEEDED");
    assert.equal(await providerPayments(shop), 1);
  }

  // 6. Confirmed failure permits attempt two; a late success for attempt one
  //    is a contradiction held for review and never pays attempt two.
  {
    const { shop, id } = await newCase();
    const first = await request(shop, id, "payout", "FAIL_THEN_LATE_SUCCESS");
    await dispatchPaymentIntents(provider, { shop });
    assert.deepEqual(await deliverAll(shop), ["APPLIED"]);
    assert.equal((await current(shop, id)).state.payout, "FAILED");
    const second = await request(shop, id, "payout", "SUCCEED");
    assert.equal(second.attempt, 2);
    await dispatchPaymentIntents(provider, { shop });
    const late = await releaseSandboxEvents(shop);
    const dispositions = [];
    for (const delivery of late)
      dispositions.push(
        await ingestProviderEvent(provider, delivery.rawBody, delivery.headers),
      );
    assert.deepEqual(dispositions.sort(), ["APPLIED", "CONTRADICTION"]);
    const firstIntent = await intent(first.id);
    assert.equal(firstIntent.status, "REVIEW");
    assert.match(firstIntent.reviewReason ?? "", /SUCCEEDED after FAILED/);
    const row = await current(shop, id);
    assert.equal(row.state.payout, "SUCCEEDED");
    assert.equal(row.state.payoutIntentId, second.id);
    assert.equal(
      sandboxBalances(row.state).GOOPER_CASH,
      -5000,
      "Only the matched attempt moved the ledger",
    );
    // The payout hold does not block repayment of explicitly approved principal.
    await updateFundedSandbox(shop, id, row.version, {
      id: randomUUID(),
      action: "RECEIVE_ITEM",
    });
    await updateFundedSandbox(shop, id, row.version + 1, {
      id: randomUUID(),
      action: "INSPECT_ITEM",
      acceptedMinor: 5000,
    });
    const collection = await request(shop, id, "collection", "SUCCEED");
    assert.equal(collection.status, "QUEUED");
  }

  // 7. A correctly signed event with the wrong amount is held for review.
  {
    const { shop, id } = await newCase();
    const payout = await request(shop, id, "payout", "WRONG_AMOUNT_EVENT");
    await dispatchPaymentIntents(provider, { shop });
    assert.deepEqual(await deliverAll(shop), ["MISMATCH"]);
    assert.equal((await intent(payout.id)).status, "REVIEW");
    assert.equal((await current(shop, id)).state.payout, "PENDING");
    // Reconciliation leaves review items alone and no new request is allowed.
    await reconcilePaymentIntents(provider, {
      shop,
      now: new Date(Date.now() + 60 * 60_000),
    });
    assert.equal((await intent(payout.id)).status, "REVIEW");
    await assert.rejects(request(shop, id, "payout", "SUCCEED"));
  }

  // 8. Reversal after success is recorded for review; balances stay put.
  {
    const { shop, id } = await newCase();
    const payout = await request(shop, id, "payout", "SUCCEED_THEN_REVERSE");
    await dispatchPaymentIntents(provider, { shop });
    assert.deepEqual(await deliverAll(shop), ["APPLIED"]);
    assert.deepEqual(await deliverAll(shop), ["REVERSAL"]);
    assert.equal((await intent(payout.id)).status, "REVIEW");
    assert.equal(sandboxBalances((await current(shop, id)).state).GOOPER_CASH, -5000);
  }

  // 9. Concurrency: parallel dispatchers submit once; parallel identical
  //    webhooks apply once; an unknown intent ID is recorded as unmatched.
  {
    const { shop, id } = await newCase();
    const payout = await request(shop, id, "payout", "SUCCEED");
    const dispatches = await Promise.all([
      dispatchPaymentIntents(provider, { shop }),
      dispatchPaymentIntents(provider, { shop }),
      dispatchPaymentIntents(provider, { shop }),
    ]);
    assert.equal(
      dispatches.reduce((sum, result) => sum + result.submitted, 0),
      1,
    );
    assert.equal((await intent(payout.id)).submissions, 1);
    const [delivery] = await releaseSandboxEvents(shop);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        ingestProviderEvent(provider, delivery.rawBody, delivery.headers),
      ),
    );
    assert.equal(results.filter((result) => result === "APPLIED").length, 1);
    assert.ok(results.every((r) => r === "APPLIED" || r === "DUPLICATE"));
    const row = await current(shop, id);
    assert.equal(sandboxBalances(row.state).GOOPER_CASH, -5000);
    assert.equal(
      row.state.events.filter((e) => e.command.action === "PAYOUT_SUCCEEDED")
        .length,
      1,
    );
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      data: {
        ...JSON.parse(delivery.rawBody).data,
        intentId: randomUUID(),
      },
    });
    const forged = await ingestProviderEvent(
      provider,
      body,
      new Headers({
        [SANDBOX_SIGNATURE_HEADER]: signEventBody(
          process.env.GOOPER_FUNDED_SANDBOX_PROVIDER_SECRET ??
            global.fundedSandboxProviderSecret!,
          body,
          new Date(),
        ),
      }),
    );
    assert.equal(forged, "UNMATCHED");
  }

  // 10. Store isolation and production lockout.
  {
    const { shop, id } = await newCase();
    const other = `payments-${randomUUID()}.myshopify.com`;
    shops.push(other);
    await assert.rejects(
      requestSandboxPayment({
        shop: other,
        caseId: id,
        version: 1,
        commandId: randomUUID(),
        operation: "payout",
      }),
    );
    const payout = await request(shop, id, "payout", "SUCCEED");
    assert.deepEqual(await dispatchPaymentIntents(provider, { shop: other }), {
      submitted: 0,
    });
    assert.equal((await intent(payout.id)).status, "QUEUED");
    process.env.NODE_ENV = "production";
    assert.throws(() => fundedPaymentProvider());
    await assert.rejects(dispatchPaymentIntents(provider, { shop }));
    await assert.rejects(reconcilePaymentIntents(provider, { shop }));
    process.env.NODE_ENV = "test";
    assert.equal(
      await prisma.agentReturn.count({ where: { shop } }),
      0,
      "Synthetic payments never enter the live refund engine",
    );
    await assert.rejects(
      prisma.$executeRaw`UPDATE "FundedPaymentIntent" SET "environment" = 'LIVE' WHERE "id" = ${payout.id}`,
      "Database refuses non-sandbox intents",
    );
  }

  console.log(
    "Passed: payment intents outbox, signed webhooks, replay, timeout and lost-request reconciliation, crash recovery, contradictions, mismatches, reversals, concurrency, isolation and production lockout.",
  );
} finally {
  process.env.NODE_ENV = "test";
  await prisma.fundedPaymentEvent.deleteMany({ where: { shop: { in: shops } } });
  await prisma.fundedPaymentEvent.deleteMany({
    where: { shop: null, provider: "gooper-sandbox" },
  });
  await prisma.fundedPaymentIntent.deleteMany({ where: { shop: { in: shops } } });
  await prisma.fundedSandboxProviderPayment.deleteMany({
    where: { shop: { in: shops } },
  });
  await prisma.fundedReturnSandbox.deleteMany({ where: { shop: { in: shops } } });
  await prisma.$disconnect();
}
