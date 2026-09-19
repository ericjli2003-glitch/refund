import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../app/db.server";
import type { AdminGraphql } from "../app/services/shopify-admin.server";
import {
  attachShopifyReturn,
  flagFundedReturnChanges,
  FUNDED_OPEN_TAG,
  FUNDED_TAG,
  startFundedCaseFromOrder,
} from "../app/services/funded-shopify-return.server";
import { assertNotFunded } from "../app/services/funded-entitlements.server";
import { listFundedSandboxes } from "../app/services/funded-return-sandbox.server";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.pathname === "/refund_ci",
  "Requires isolated refund_ci PostgreSQL database",
);
process.env.NODE_ENV = "test";
process.env.GOOPER_FUNDED_RETURNS_SANDBOX = "1";

const ORDER = "gid://shopify/Order/9001";
const SHIRT = "gid://shopify/LineItem/9101";
const FULFILLED_A = "gid://shopify/FulfillmentLineItem/9201";
const FULFILLED_B = "gid://shopify/FulfillmentLineItem/9202";
const shops: string[] = [];

// A fake Shopify store: one order, a 2-unit shirt at 24.50 CAD fulfilled in two
// shipments, and whatever returns this test has created on it.
function fakeStore() {
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = [];
  const returns: Array<{ id: string; status: string; note: string }> = [];
  let returnable = [
    { id: FULFILLED_A, quantity: 1 },
    { id: FULFILLED_B, quantity: 1 },
  ];
  let failCreate: "userError" | "throw" | null = null;
  const admin: AdminGraphql = {
    async graphql(query, options) {
      const variables = options?.variables ?? {};
      const name = /(query|mutation)\s+(\w+)/.exec(query)?.[2] ?? "unknown";
      calls.push({ name, variables });
      const json = (data: unknown) => Response.json({ data });
      if (name === "ReturnReasonDefinitions")
        return json({
          returnReasonDefinitions: {
            nodes: [{ id: "gid://shopify/ReturnReasonDefinition/1", handle: "other-reason", name: "Other", deleted: false }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      if (name === "FundedOrder")
        return json({
          order: {
            id: ORDER,
            name: "#1009",
            presentmentCurrencyCode: "CAD",
            tags: [],
            lineItems: {
              nodes: [
                {
                  id: SHIRT,
                  title: "Linen shirt",
                  quantity: 2,
                  discountedUnitPriceAfterAllDiscountsSet: {
                    presentmentMoney: { amount: "24.5", currencyCode: "CAD" },
                  },
                },
              ],
            },
            returns: {
              nodes: returns.map((entry) => ({
                id: entry.id,
                status: entry.status,
                returnLineItems: { nodes: [{ returnReasonNote: entry.note }] },
              })),
            },
          },
          returnableFulfillments: {
            nodes: [
              {
                returnableFulfillmentLineItems: {
                  nodes: returnable.map((line) => ({
                    quantity: line.quantity,
                    fulfillmentLineItem: { id: line.id, lineItem: { id: SHIRT } },
                  })),
                },
              },
            ],
          },
        });
      if (name === "CreateFundedReturn") {
        const input = variables.returnInput as {
          returnLineItems: Array<{ fulfillmentLineItemId: string; quantity: number; returnReasonNote: string }>;
        };
        if (failCreate === "userError")
          return json({ returnCreate: { return: null, userErrors: [{ field: null, message: "Nope" }] } });
        const id = `gid://shopify/Return/${9300 + returns.length}`;
        returns.push({ id, status: "OPEN", note: input.returnLineItems[0].returnReasonNote });
        // Shopify stops treating returned units as returnable.
        for (const line of input.returnLineItems)
          returnable = returnable.map((entry) =>
            entry.id === line.fulfillmentLineItemId
              ? { ...entry, quantity: entry.quantity - line.quantity }
              : entry,
          );
        if (failCreate === "throw") throw new TypeError("fetch failed");
        return json({ returnCreate: { return: { id, status: "OPEN" }, userErrors: [] } });
      }
      if (name === "TagFundedOrder") return json({ tagsAdd: { userErrors: [] } });
      throw new Error(`Unexpected Shopify operation ${name}`);
    },
  };
  return {
    admin,
    calls,
    returns,
    count: (name: string) => calls.filter((call) => call.name === name).length,
    failNextCreate: (mode: "userError" | "throw" | null) => {
      failCreate = mode;
    },
  };
}
const newShop = () => {
  const shop = `stage2-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  return shop;
};

try {
  // 1. Start from a real order line: priced from Shopify, reserved, returned, tagged.
  {
    const shop = newShop();
    const store = fakeStore();
    const { caseId, returnId } = await startFundedCaseFromOrder({
      admin: store.admin, shop, orderId: ORDER, lineItemId: SHIRT, quantity: 2,
    });
    const [row] = await listFundedSandboxes(shop);
    assert.equal(row.id, caseId);
    assert.equal(row.state.amountMinor, 4900, "2 × 24.50 CAD, in cents");
    assert.equal(row.state.currency, "CAD");
    assert.deepEqual(row.state.order, {
      orderId: ORDER, orderName: "#1009", lineItemId: SHIRT, title: "Linen shirt", quantity: 2,
    });
    const create = store.calls.find((call) => call.name === "CreateFundedReturn")!.variables
      .returnInput as Record<string, unknown>;
    assert.equal(create.orderId, ORDER);
    assert.equal(create.notifyCustomer, false, "The customer isn't emailed about Gooper's return");
    assert.deepEqual(
      (create.returnLineItems as Array<Record<string, unknown>>).map((line) => [line.fulfillmentLineItemId, line.quantity]),
      [[FULFILLED_A, 1], [FULFILLED_B, 1]],
      "Split across both shipments",
    );
    assert.match(String((create.returnLineItems as Array<Record<string, unknown>>)[0].returnReasonNote), new RegExp(caseId));
    assert.deepEqual(
      store.calls.find((call) => call.name === "TagFundedOrder")!.variables,
      { id: ORDER, tags: [FUNDED_TAG, FUNDED_OPEN_TAG] },
    );
    const units = await prisma.fundedEntitlement.findMany({ where: { shop, caseId } });
    assert.equal(units.length, 1);
    assert.equal(units[0].shopifyReturnId, returnId);

    // The original-payment engine can't refund the funded return.
    await assert.rejects(
      assertNotFunded({ shop, orderId: ORDER, items: [{ lineItemId: SHIRT, quantity: 1 }], returnId }),
      /Gooper funded this return/,
    );
    // Attaching again is a no-op: no second Shopify return.
    assert.equal(await attachShopifyReturn({ admin: store.admin, shop, caseId }), returnId);
    assert.equal(store.count("CreateFundedReturn"), 1);
    // Nothing is left to fund on that line.
    await assert.rejects(
      startFundedCaseFromOrder({ admin: store.admin, shop, orderId: ORDER, lineItemId: SHIRT, quantity: 1 }),
      /aren't returnable/,
    );
    assert.equal((await listFundedSandboxes(shop)).length, 1, "No case was created for the refusal");
  }

  // 2. Shopify refuses the return: units stay reserved, the guard still holds,
  //    and a later retry attaches a return once Shopify accepts.
  {
    const shop = newShop();
    const store = fakeStore();
    store.failNextCreate("userError");
    await assert.rejects(
      startFundedCaseFromOrder({ admin: store.admin, shop, orderId: ORDER, lineItemId: SHIRT, quantity: 1 }),
      /didn't create the return: Nope/,
    );
    const [row] = await listFundedSandboxes(shop);
    const [units] = await prisma.fundedEntitlement.findMany({ where: { shop, caseId: row.id } });
    assert.equal(units.status, "ACTIVE");
    assert.equal(units.shopifyReturnId, null);
    await assert.rejects(
      assertNotFunded({ shop, orderId: ORDER, items: [{ lineItemId: SHIRT, quantity: 2 }], returnable: new Map([[SHIRT, 2]]) }),
      /already funded/,
      "Without a Shopify return, funded units are subtracted from what's returnable",
    );
    store.failNextCreate(null);
    const returnId = await attachShopifyReturn({ admin: store.admin, shop, caseId: row.id });
    assert.match(returnId, /^gid:\/\/shopify\/Return\//);
  }

  // 3. An ambiguous failure after Shopify created the return: the retry finds
  //    it by the case marker instead of creating a second one.
  {
    const shop = newShop();
    const store = fakeStore();
    store.failNextCreate("throw");
    await assert.rejects(
      startFundedCaseFromOrder({ admin: store.admin, shop, orderId: ORDER, lineItemId: SHIRT, quantity: 1 }),
      /fetch failed/,
    );
    store.failNextCreate(null);
    const [row] = await listFundedSandboxes(shop);
    const returnId = await attachShopifyReturn({ admin: store.admin, shop, caseId: row.id });
    assert.equal(returnId, store.returns[0].id);
    assert.equal(store.count("CreateFundedReturn"), 1, "No duplicate Shopify return");
  }

  // 4. returns/* webhook: a funded return cancelled outside Gooper makes its
  //    units subtractable again and is flagged; unrelated returns are ignored.
  {
    const shop = newShop();
    const store = fakeStore();
    const { caseId, returnId } = await startFundedCaseFromOrder({
      admin: store.admin, shop, orderId: ORDER, lineItemId: SHIRT, quantity: 1,
    });
    assert.equal(
      await prisma.$transaction((tx) => flagFundedReturnChanges(tx, shop, "gid://shopify/Return/1", "CANCELLED")),
      0,
    );
    assert.equal(
      await prisma.$transaction((tx) => flagFundedReturnChanges(tx, shop, returnId, "OPEN")),
      0,
      "Non-terminal changes are ignored",
    );
    assert.equal(
      await prisma.$transaction((tx) => flagFundedReturnChanges(tx, shop, returnId, "CANCELLED")),
      1,
    );
    const [units] = await prisma.fundedEntitlement.findMany({ where: { shop, caseId } });
    assert.equal(units.status, "CONFLICT");
    assert.equal(units.shopifyReturnId, null);
    assert.match(units.conflictReason ?? "", /cancelled outside Gooper.*returnable in Shopify again/);
    // Shopify would show both units returnable again; one is still Gooper's.
    await assert.rejects(
      assertNotFunded({ shop, orderId: ORDER, items: [{ lineItemId: SHIRT, quantity: 2 }], returnable: new Map([[SHIRT, 2]]) }),
      /already funded/,
    );
    await assertNotFunded({ shop, orderId: ORDER, items: [{ lineItemId: SHIRT, quantity: 1 }], returnable: new Map([[SHIRT, 2]]) });
  }

  // 5. Production refuses before touching Shopify.
  {
    const store = fakeStore();
    process.env.NODE_ENV = "production";
    await assert.rejects(
      startFundedCaseFromOrder({ admin: store.admin, shop: newShop(), orderId: ORDER, lineItemId: SHIRT, quantity: 1 }),
      (error: unknown) => error instanceof Response && error.status === 404,
    );
    process.env.NODE_ENV = "test";
    assert.equal(store.calls.length, 0);
  }

  console.log(
    "Passed: funded case from a real order line, Shopify return and tags, no duplicate returns on retry, refusals keep units reserved, outside cancellations flagged, production lockout.",
  );
} finally {
  process.env.NODE_ENV = "test";
  for (const shop of shops) {
    await prisma.fundedEntitlement.deleteMany({ where: { shop } });
    await prisma.fundedReturnSandbox.deleteMany({ where: { shop } });
  }
  await prisma.$disconnect();
}
