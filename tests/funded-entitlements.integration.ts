import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../app/db.server";
import {
  assertNotFunded,
  flagFundedRefundConflicts,
  releaseFundedUnits,
  reserveFundedUnits,
  reservedFundedUnits,
} from "../app/services/funded-entitlements.server";
import {
  createFundedSandbox,
  updateFundedSandbox,
} from "../app/services/funded-return-sandbox.server";
import {
  fundedPaymentProvider,
  dispatchPaymentIntents,
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

const shop = `funded-${randomUUID()}.myshopify.com`;
const otherShop = `funded-${randomUUID()}.myshopify.com`;
const ORDER = "gid://shopify/Order/5001";
const SHIRT = "gid://shopify/LineItem/7001";
const HAT = "gid://shopify/LineItem/7002";

async function newCase() {
  const id = randomUUID();
  await createFundedSandbox(shop, id, "CAD");
  await updateFundedSandbox(shop, id, 0, { id: randomUUID(), action: "APPROVE_RISK" });
  return id;
}

try {
  const caseId = await newCase();
  await reserveFundedUnits({ shop, caseId, orderId: ORDER, items: [{ lineItemId: SHIRT, quantity: 1 }] });
  await assert.rejects(
    reserveFundedUnits({ shop, caseId, orderId: ORDER, items: [{ lineItemId: HAT, quantity: 1 }] }),
    /already has funded items/,
  );
  await assert.rejects(
    reserveFundedUnits({ shop, caseId: randomUUID(), orderId: "gid://shopify/Order/x", items: [{ lineItemId: SHIRT, quantity: 1 }] }),
  );
  await assert.rejects(
    reserveFundedUnits({
      shop,
      caseId: randomUUID(),
      orderId: ORDER,
      items: [{ lineItemId: SHIRT, quantity: 1 }, { lineItemId: SHIRT, quantity: 1 }],
    }),
    /only once/,
  );

  // The live refund engine's check, per store.
  await assert.rejects(
    assertNotFunded({ shop, orderId: ORDER, items: [{ lineItemId: SHIRT, quantity: 1 }] }),
    /already funded/,
  );
  await assertNotFunded({ shop, orderId: ORDER, items: [{ lineItemId: HAT, quantity: 1 }] });
  await assertNotFunded({ shop: otherShop, orderId: ORDER, items: [{ lineItemId: SHIRT, quantity: 1 }] });
  await assertNotFunded({
    shop,
    orderId: ORDER,
    items: [{ lineItemId: SHIRT, quantity: 1 }],
    returnable: new Map([[SHIRT, 2]]),
  });

  // Released only while no payout went out; never after one succeeded.
  assert.equal(await releaseFundedUnits(shop, caseId), 1);
  assert.equal((await reservedFundedUnits(shop, ORDER)).length, 0);
  await assertNotFunded({ shop, orderId: ORDER, items: [{ lineItemId: SHIRT, quantity: 1 }] });

  const paidCase = await newCase();
  await reserveFundedUnits({ shop, caseId: paidCase, orderId: ORDER, items: [{ lineItemId: SHIRT, quantity: 2 }] });
  const provider = fundedPaymentProvider();
  await requestSandboxPayment({ shop, caseId: paidCase, version: 1, commandId: randomUUID(), operation: "payout" });
  await assert.rejects(releaseFundedUnits(shop, paidCase), /no payout succeeded or is still unresolved/);
  await dispatchPaymentIntents(provider, { shop });
  for (const delivery of await releaseSandboxEvents(shop))
    await ingestProviderEvent(provider, delivery.rawBody, delivery.headers);
  await assert.rejects(releaseFundedUnits(shop, paidCase), /no payout succeeded/);

  // A Shopify refund touching funded units is flagged, not acted on.
  const refundPayload = (lineItem: number, quantity: number) => ({
    order_id: 5001,
    refund_line_items: [{ line_item_id: lineItem, quantity }],
  });
  assert.equal(
    await prisma.$transaction((tx) =>
      flagFundedRefundConflicts(tx, shop, refundPayload(7002, 1), "gid://shopify/Refund/1"),
    ),
    0,
    "A refund of an unfunded line item is ignored",
  );
  assert.equal(
    await prisma.$transaction((tx) =>
      flagFundedRefundConflicts(tx, shop, refundPayload(7001, 1), "gid://shopify/Refund/2"),
    ),
    1,
  );
  const [conflict] = await prisma.fundedEntitlement.findMany({ where: { shop, caseId: paidCase } });
  assert.equal(conflict.status, "CONFLICT");
  assert.match(conflict.conflictReason ?? "", /Refund\/2.*Possible double payment/);
  await assert.rejects(
    assertNotFunded({ shop, orderId: ORDER, items: [{ lineItemId: SHIRT, quantity: 1 }] }),
    /already funded/,
    "Conflicted units stay reserved",
  );
  assert.equal(
    await prisma.$transaction((tx) => flagFundedRefundConflicts(tx, shop, { nonsense: true }, null)),
    0,
    "Malformed payloads are ignored",
  );

  // The database refuses live rows and malformed identifiers.
  await assert.rejects(
    prisma.$executeRaw`UPDATE "FundedEntitlement" SET "environment" = 'LIVE' WHERE "shop" = ${shop}`,
  );
  await assert.rejects(
    prisma.fundedEntitlement.create({
      data: { id: randomUUID(), shop, caseId: paidCase, orderId: ORDER, lineItemId: "7001", quantity: 1 },
    }),
  );

  process.env.NODE_ENV = "production";
  await assert.rejects(
    reserveFundedUnits({ shop, caseId: randomUUID(), orderId: ORDER, items: [{ lineItemId: HAT, quantity: 1 }] }),
    (error: unknown) => error instanceof Response && error.status === 404,
  );
  // The refund engine's check still runs in production; it just finds nothing.
  await assertNotFunded({ shop: `prod-${randomUUID()}.myshopify.com`, orderId: ORDER, items: [{ lineItemId: SHIRT, quantity: 1 }] });
  process.env.NODE_ENV = "test";
  console.log(
    "Passed: funded units reserve, block the refund engine per store, release only without a payout, flag outside refunds, and refuse live rows.",
  );
} finally {
  process.env.NODE_ENV = "test";
  for (const name of [shop, otherShop]) {
    await prisma.fundedEntitlement.deleteMany({ where: { shop: name } });
    await prisma.fundedPaymentEvent.deleteMany({ where: { shop: name } });
    await prisma.fundedPaymentIntent.deleteMany({ where: { shop: name } });
    await prisma.fundedSandboxProviderPayment.deleteMany({ where: { shop: name } });
    await prisma.fundedReturnSandbox.deleteMany({ where: { shop: name } });
  }
  await prisma.$disconnect();
}
