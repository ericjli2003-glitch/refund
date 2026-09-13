import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import type { AdminGraphql } from "./automatic-return.server";
import { addReturnTracking, returnShippingFor } from "./return-shipping.server";

const CUSTOMER = { shop: "ship.myshopify.com", customerSubjectHash: "customer-a" };
const RETURN = "gid://shopify/Return/2";
const REVERSE_ORDER = "gid://shopify/ReverseFulfillmentOrder/9";
const DELIVERY = "gid://shopify/ReverseDelivery/10";

function mockDelegate(
  t: TestContext,
  target: object,
  name: string,
  implementation: (...args: never[]) => unknown,
) {
  const original = Reflect.get(target, name);
  const mock = t.mock.fn(implementation);
  Reflect.set(target, name, mock);
  t.after(() => Reflect.set(target, name, original));
  return mock;
}

type Handler = (variables: Record<string, unknown>) => unknown;

function fakeShopify(handlers: Record<string, Handler>) {
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = [];
  const admin: AdminGraphql = {
    async graphql(query, options) {
      const name = Object.keys(handlers).find((key) => query.includes(key));
      if (!name) throw new Error(`Unexpected Shopify operation: ${query}`);
      calls.push({ name, variables: options?.variables ?? {} });
      return Response.json({ data: handlers[name](options?.variables ?? {}) });
    },
  };
  return { admin, calls, names: () => calls.map((call) => call.name) };
}

const shipping = (deliverable: Record<string, unknown> | null) => () => ({
  return: {
    reverseFulfillmentOrders: {
      nodes: [
        {
          id: REVERSE_ORDER,
          reverseDeliveries: {
            nodes: deliverable ? [{ id: DELIVERY, deliverable }] : [],
          },
        },
      ],
    },
  },
});

const noErrors = (field: string) => () => ({ [field]: { reverseDelivery: { id: DELIVERY }, userErrors: [] } });

function ownReturn(t: TestContext, record: Record<string, unknown> | null = {}) {
  return mockDelegate(t, prisma.agentReturn, "findFirst", async () =>
    record && {
      id: "agent-return-1",
      returnId: RETURN,
      status: "REFUND_SUBMITTED",
      itemReceivedAt: null,
      ...record,
    },
  );
}

const TRACKING = {
  agentReturnId: "agent-return-1",
  trackingNumber: "1Z999AA10123456784",
  trackingUrl: "https://carrier.example/track/1Z999AA10123456784",
};

test("a customer shipping the item themselves adds tracking to a new reverse delivery without an email", async (t) => {
  ownReturn(t);
  const shopify = fakeShopify({
    ReturnShipping: shipping(null),
    CreateReturnTracking: noErrors("reverseDeliveryCreateWithShipping"),
  });
  await addReturnTracking(CUSTOMER, TRACKING, shopify.admin);
  const create = shopify.calls.find((call) => call.name === "CreateReturnTracking")!;
  assert.deepEqual(create.variables, {
    reverseFulfillmentOrderId: REVERSE_ORDER,
    trackingInput: { number: TRACKING.trackingNumber, url: TRACKING.trackingUrl },
  });
  assert.ok(!shopify.names().includes("UpdateReturnTracking"));
});

test("tracking is added to a store label that has none, and never overwrites label tracking", async (t) => {
  ownReturn(t);
  const withLabel = fakeShopify({
    ReturnShipping: shipping({ label: { publicFileUrl: "https://cdn.shopify.com/label.pdf" }, tracking: null }),
    UpdateReturnTracking: noErrors("reverseDeliveryShippingUpdate"),
  });
  await addReturnTracking(CUSTOMER, TRACKING, withLabel.admin);
  assert.equal(
    withLabel.calls.find((call) => call.name === "UpdateReturnTracking")!.variables.reverseDeliveryId,
    DELIVERY,
  );
  const tracked = fakeShopify({
    ReturnShipping: shipping({ tracking: { number: "LABEL123", url: null, carrierName: "UPS" } }),
  });
  await assert.rejects(addReturnTracking(CUSTOMER, TRACKING, tracked.admin), /already has tracking/);
  assert.deepEqual(tracked.names(), ["ReturnShipping"]);
});

test("tracking only goes on the customer's own approved return that hasn't been received", async (t) => {
  const shopify = fakeShopify({});
  for (const record of [null, { itemReceivedAt: new Date() }, { status: "NEEDS_ATTENTION" }, { returnId: null }]) {
    const lookup = ownReturn(t, record);
    await assert.rejects(addReturnTracking(CUSTOMER, TRACKING, shopify.admin), /your own approved return/);
    const where = (lookup.mock.calls[0].arguments[0] as { where: Record<string, unknown> }).where;
    assert.equal(where.customerSubjectHash, CUSTOMER.customerSubjectHash);
  }
  assert.deepEqual(shopify.names(), []);
});

test("malformed tracking numbers and non-https links are refused before any lookup", async (t) => {
  const lookup = ownReturn(t);
  const shopify = fakeShopify({});
  for (const input of [
    { ...TRACKING, trackingNumber: "<script>" },
    { ...TRACKING, trackingNumber: "12" },
    { ...TRACKING, trackingUrl: "http://carrier.example/track" },
    { ...TRACKING, trackingUrl: "javascript:alert(1)" },
  ]) {
    await assert.rejects(addReturnTracking(CUSTOMER, input, shopify.admin));
  }
  assert.equal(lookup.mock.callCount(), 0);
});

test("shipping status shows Shopify labels and tracking, and skips returns it can't read", async (t) => {
  mockDelegate(t, prisma.agentReturn, "findMany", async () => [
    { id: "agent-return-1", returnId: RETURN },
    { id: "agent-return-2", returnId: "gid://shopify/Return/unreadable" },
  ]);
  const shopify = fakeShopify({
    ReturnShipping: (variables) => {
      if (variables.returnId !== RETURN) throw new Error("unreadable");
      return shipping({
        label: { publicFileUrl: "https://cdn.shopify.com/label.pdf" },
        tracking: { number: "LABEL123", url: "javascript:alert(1)", carrierName: "UPS" },
      })();
    },
  });
  assert.deepEqual(await returnShippingFor(CUSTOMER, shopify.admin), [
    {
      agentReturnId: "agent-return-1",
      labelUrl: "https://cdn.shopify.com/label.pdf",
      trackingNumber: "LABEL123",
      trackingUrl: null,
      carrierName: "UPS",
      canAddTracking: false,
    },
  ]);
});
