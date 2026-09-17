import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../app/db.server";
import {
  fundedReturnsAction,
  fundedReturnsLoader,
  type AuthenticateAdmin,
} from "../app/services/funded-returns-admin.server";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.pathname === "/refund_ci",
  "Requires isolated refund_ci PostgreSQL database",
);
process.env.NODE_ENV = "test";
process.env.GOOPER_FUNDED_RETURNS_SANDBOX = "1";
process.env.SHOPIFY_APP_URL = "https://app.example.test";

const shop = `admin-${randomUUID()}.myshopify.com`;
const otherShop = `admin-${randomUUID()}.myshopify.com`;
const as =
  (name: string): AuthenticateAdmin =>
  async () => ({ session: { shop: name } });

type Result = { data: { error: string | null; notice: string | null }; init: ResponseInit | null };
async function submit(name: string, fields: Record<string, string>) {
  const request = new Request("https://app.example.test/app/funded-returns", {
    method: "POST",
    headers: {
      Origin: "https://app.example.test",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
  return (await fundedReturnsAction(request, as(name))) as unknown as Result;
}
type View = {
  cases: Array<{
    id: string;
    version: number;
    state: { payout: string; collection: string; returnStatus: string };
  }>;
  payments: Array<{
    caseId: string;
    status: string;
    operation: string;
    amountMinor: number;
  }>;
  actionId: string;
};
async function load(name: string) {
  const result = await fundedReturnsLoader(
    new Request("https://app.example.test/app/funded-returns"),
    as(name),
  );
  return (result as unknown as { data: View }).data;
}
const ok = (result: Result) => {
  assert.equal(result.data.error, null, result.data.error ?? "");
  assert.equal(result.init?.status ?? 200, 200);
  return result;
};
const rejected = (result: Result, pattern: RegExp) => {
  assert.equal(result.init?.status, 400);
  assert.match(result.data.error ?? "", pattern);
};

try {
  // Create a sample through the form, then drive it only through form actions.
  const caseId = randomUUID();
  ok(await submit(shop, { intent: "create", id: caseId, currency: "CAD" }));
  let view = await load(shop);
  assert.equal(view.cases.length, 1);
  assert.equal((await load(otherShop)).cases.length, 0, "Another store sees nothing");
  assert.notEqual((await load(shop)).actionId, view.actionId, "Each view gets a fresh action ID");

  // Another store can neither advance nor pay out this sample.
  rejected(
    await submit(otherShop, { intent: "APPROVE_RISK", id: caseId, version: "0", actionId: randomUUID() }),
    /not found/,
  );
  rejected(
    await submit(otherShop, {
      intent: "REQUEST_PAYOUT", id: caseId, version: "0", actionId: randomUUID(), scenario: "SUCCEED",
    }),
    /not found/,
  );

  // Outcome actions can't be posted from the screen, even with a valid shape.
  rejected(
    await submit(shop, { intent: "PAYOUT_SUCCEEDED", id: caseId, version: "0", actionId: randomUUID() }),
    /Check the sample action/,
  );
  // Invalid input is a 400 with a readable message, not a crash.
  rejected(await submit(shop, { intent: "create", id: "not-a-uuid", currency: "CAD" }), /Check/);
  rejected(
    await submit(shop, {
      intent: "REQUEST_PAYOUT", id: caseId, version: "0", actionId: randomUUID(), scenario: "LIVE",
    }),
    /Check/,
  );

  ok(await submit(shop, { intent: "APPROVE_RISK", id: caseId, version: "0", actionId: randomUUID() }));
  const payoutAction = randomUUID();
  const payout = { intent: "REQUEST_PAYOUT", id: caseId, version: "1", actionId: payoutAction, scenario: "SUCCEED" };
  ok(await submit(shop, payout));
  ok(await submit(shop, payout)); // retried POST: no second intent or submission
  view = await load(shop);
  assert.equal(view.payments.length, 1);
  assert.equal(view.payments[0].status, "PENDING", "Dispatched inline after the intent committed");

  // A stale view can't act on the changed sample.
  rejected(
    await submit(shop, { intent: "RECEIVE_ITEM", id: caseId, version: "1", actionId: randomUUID() }),
    /changed|Confirm/,
  );

  // Another store's webhook delivery and reconciliation don't touch this store.
  ok(await submit(otherShop, { intent: "deliver" }));
  ok(await submit(otherShop, { intent: "reconcile" }));
  assert.equal((await load(shop)).payments[0].status, "PENDING");

  const delivered = ok(await submit(shop, { intent: "deliver" }));
  assert.match(delivered.data.notice ?? "", /APPLIED/);
  const replayed = ok(await submit(shop, { intent: "replay" }));
  assert.match(replayed.data.notice ?? "", /DUPLICATE/);
  view = await load(shop);
  assert.equal(view.cases[0].state.payout, "SUCCEEDED");

  // Receipt, explicit partial approval, then repayment for approved principal.
  let version = view.cases[0].version;
  ok(await submit(shop, { intent: "RECEIVE_ITEM", id: caseId, version: String(version), actionId: randomUUID() }));
  rejected(
    await submit(shop, {
      intent: "INSPECT_ITEM", id: caseId, version: String(version + 1), actionId: randomUUID(), acceptedAmount: "50.001",
    }),
    /two decimal places/,
  );
  ok(
    await submit(shop, {
      intent: "INSPECT_ITEM", id: caseId, version: String(version + 1), actionId: randomUUID(), acceptedAmount: "12.50",
    }),
  );
  version += 2;
  ok(
    await submit(shop, {
      intent: "REQUEST_COLLECTION", id: caseId, version: String(version), actionId: randomUUID(), scenario: "TIMEOUT_AFTER_ACCEPT",
    }),
  );
  view = await load(shop);
  const collection = view.payments.find((payment) => payment.operation === "COLLECTION")!;
  assert.equal(collection.amountMinor, 1250);
  assert.equal(collection.status, "UNKNOWN");
  assert.equal(view.cases[0].state.collection, "UNKNOWN");
  ok(await submit(shop, { intent: "deliver" })); // provider settles
  view = await load(shop);
  assert.equal(view.cases[0].state.collection, "SETTLED");
  const reconciled = ok(await submit(shop, { intent: "reconcile" }));
  assert.match(reconciled.data.notice ?? "", /Resubmitted with the same key: 0/);

  assert.equal(await prisma.agentReturn.count({ where: { shop } }), 0);
  assert.equal(
    await prisma.fundedSandboxProviderPayment.count({ where: { shop, reference: { not: null } } }),
    2,
    "Exactly one provider payment per intent",
  );
  console.log(
    "Passed: merchant form actions — store isolation, retried POSTs, stale views, rejected outcome posts, input validation, webhooks, replay and reconciliation.",
  );
} finally {
  for (const name of [shop, otherShop]) {
    await prisma.fundedPaymentEvent.deleteMany({ where: { shop: name } });
    await prisma.fundedPaymentIntent.deleteMany({ where: { shop: name } });
    await prisma.fundedSandboxProviderPayment.deleteMany({ where: { shop: name } });
    await prisma.fundedReturnSandbox.deleteMany({ where: { shop: name } });
  }
  await prisma.$disconnect();
}
