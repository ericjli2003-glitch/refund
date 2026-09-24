import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../app/db.server";
import {
  createFundedSandbox,
  listFundedSandboxes,
  updateFundedSandbox,
} from "../app/services/funded-return-sandbox.server";
import { sandboxBalances } from "../app/funded-return-sandbox";
import {
  dispatchPaymentIntents,
  fundedPaymentProvider,
  ingestProviderEvent,
  requestSandboxPayment,
} from "../app/services/funded-payment-intents.server";
import { releaseSandboxEvents } from "../app/services/funded-sandbox-provider.server";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.pathname === "/refund_ci",
  "Requires isolated refund_ci PostgreSQL database",
);
process.env.NODE_ENV = "test";
process.env.GOOPER_FUNDED_RETURNS_SANDBOX = "1";
const shop = `sandbox-${randomUUID()}.myshopify.com`;
const otherShop = `sandbox-${randomUUID()}.myshopify.com`;
const id = randomUUID();

// Payments now go through the sandbox provider; outcomes cannot be asserted.
async function settleThroughProvider() {
  const provider = fundedPaymentProvider();
  await dispatchPaymentIntents(provider, { shop });
  for (const delivery of await releaseSandboxEvents(shop))
    assert.equal(
      await ingestProviderEvent(provider, delivery.rawBody, delivery.headers),
      "APPLIED",
    );
}

try {
  await createFundedSandbox(shop, id, "CAD");
  await createFundedSandbox(shop, id, "CAD");
  assert.equal((await listFundedSandboxes(shop)).length, 1);
  await assert.rejects(createFundedSandbox(shop, id, "USD"));
  assert.deepEqual(await listFundedSandboxes(otherShop), []);
  const approval = { id: randomUUID(), action: "APPROVE_RISK" as const };
  await assert.rejects(updateFundedSandbox(otherShop, id, 0, approval));
  await updateFundedSandbox(shop, id, 0, approval);
  await updateFundedSandbox(shop, id, 0, approval); // replay with stale version
  await assert.rejects(
    updateFundedSandbox(shop, id, 1, { ...approval, action: "RECEIVE_ITEM" }),
  );
  await assert.rejects(
    requestSandboxPayment({
      shop,
      caseId: id,
      version: 0,
      commandId: randomUUID(),
      operation: "payout",
    }),
    "A stale view cannot request a payout",
  );
  await assert.rejects(
    updateFundedSandbox(shop, id, 1, {
      id: randomUUID(),
      action: "REQUEST_PAYOUT",
      payment: {
        intentId: randomUUID(),
        attempt: 1,
        amountMinor: 5000,
        currency: "CAD",
      },
    }),
    "Payout requests must create a durable intent",
  );
  assert.equal((await listFundedSandboxes(shop))[0].version, 1);
  const races = await Promise.allSettled([
    requestSandboxPayment({
      shop,
      caseId: id,
      version: 1,
      commandId: randomUUID(),
      operation: "payout",
    }),
    requestSandboxPayment({
      shop,
      caseId: id,
      version: 1,
      commandId: randomUUID(),
      operation: "payout",
    }),
  ]);
  assert.equal(
    races.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    await prisma.fundedPaymentIntent.count({ where: { shop, caseId: id } }),
    1,
    "Concurrent requests create one payout intent",
  );
  await settleThroughProvider();
  let row = (await listFundedSandboxes(shop))[0];
  assert.equal(row.version, 3);
  assert.equal(row.state.events.length, 3);
  assert.equal(sandboxBalances(row.state).GOOPER_CASH, -5000);
  await updateFundedSandbox(shop, id, 3, {
    id: randomUUID(),
    action: "RECEIVE_ITEM",
  });
  await assert.rejects(
    updateFundedSandbox(shop, id, 4, {
      id: randomUUID(),
      action: "REQUEST_COLLECTION",
    }),
  );
  await updateFundedSandbox(shop, id, 4, {
    id: randomUUID(),
    action: "INSPECT_ITEM",
    acceptedMinor: 2500,
  });
  await requestSandboxPayment({
    shop,
    caseId: id,
    version: 5,
    commandId: randomUUID(),
    operation: "collection",
  });
  await settleThroughProvider();
  row = (await listFundedSandboxes(shop))[0];
  assert.deepEqual(sandboxBalances(row.state), {
    GOOPER_CASH: -2500,
    FUNDED_EXPOSURE: 2500,
    MERCHANT_RECEIVABLE: 0,
  });
  assert.equal(
    await prisma.agentReturn.count({ where: { shop } }),
    0,
    "Synthetic returns never enter the live refund engine",
  );
  process.env.NODE_ENV = "production";
  await assert.rejects(
    listFundedSandboxes(shop),
    (error: unknown) => error instanceof Response && error.status === 404,
  );
  await assert.rejects(createFundedSandbox(shop, randomUUID(), "CAD"));
  await assert.rejects(
    updateFundedSandbox(shop, id, 7, {
      id: randomUUID(),
      action: "RECEIVE_ITEM",
    }),
  );
  console.log(
    "Passed: durable sandbox lifecycle, store isolation, idempotency, concurrent payment protection and production lockout.",
  );
} finally {
  process.env.NODE_ENV = "test";
  await prisma.fundedPaymentEvent.deleteMany({ where: { shop } });
  await prisma.fundedPaymentIntent.deleteMany({ where: { shop } });
  await prisma.fundedSandboxProviderPayment.deleteMany({ where: { shop } });
  await prisma.fundedReturnSandbox.deleteMany({ where: { shop } });
  await prisma.$disconnect();
}
