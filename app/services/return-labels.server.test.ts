import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import { seal } from "./customer-security.server";
import {
  labelProvider,
  LabelProviderError,
  toInchesAndOunces,
  type LabelAddress,
  type Parcel,
} from "./return-label-providers.server";
import { buyReturnLabel, connectLabelAccount } from "./return-labels.server";
import { addReturnTracking, returnShippingFor } from "./return-shipping.server";
import type { AdminGraphql } from "./shopify-admin.server";

const SHOP = "labels.myshopify.com";
const RETURN = "gid://shopify/Return/2";
const REVERSE_ORDER = "gid://shopify/ReverseFulfillmentOrder/9";
const DELIVERY = "gid://shopify/ReverseDelivery/10";
const EASYPOST_KEY = "EZTKtestkey1234";

const CUSTOMER: LabelAddress = {
  name: "Ada Customer",
  street1: "1 Customer St",
  city: "Toronto",
  state: "ON",
  zip: "M5V 1A1",
  country: "CA",
};
const STORE: LabelAddress = {
  name: "Middle Out Merch",
  company: "Middle Out Merch",
  street1: "9 Store Rd",
  city: "Ottawa",
  state: "ON",
  zip: "K1A 0B1",
  country: "CA",
};
const PARCEL: Parcel = {
  length: 30,
  width: 20,
  height: 10,
  distanceUnit: "cm",
  weight: 1,
  massUnit: "kg",
};

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

function withSecret(t: TestContext) {
  const saved = process.env.REFUND_SECRET;
  process.env.REFUND_SECRET = "label-test-secret";
  t.after(() => {
    if (saved === undefined) delete process.env.REFUND_SECRET;
    else process.env.REFUND_SECRET = saved;
  });
}

type FetchCall = { url: string; init: RequestInit | undefined; body: unknown };

// Routes each request by URL; a handler returns a Response.
function fakeFetch(routes: Array<[RegExp, (call: FetchCall) => Response]>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null;
    const call = { url, init, body };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return route[1](call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const header = (call: FetchCall, name: string) =>
  new Headers(call.init?.headers).get(name);

const easyPostRoutes = (): Array<[RegExp, (call: FetchCall) => Response]> => [
  [
    /api\.easypost\.com\/v2\/shipments$/,
    () =>
      Response.json({
        id: "shp_1",
        rates: [
          { id: "rate_dear", carrier: "UPS", service: "Ground", rate: "18.40", currency: "CAD" },
          { id: "rate_cheap", carrier: "CanadaPost", service: "Regular", rate: "11.25", currency: "CAD" },
        ],
      }),
  ],
  [
    /api\.easypost\.com\/v2\/shipments\/shp_1\/buy$/,
    () =>
      Response.json({
        tracking_code: "CP123456789CA",
        postage_label: {
          label_url: "https://easypost-files.example/label.png",
          label_pdf_url: "https://easypost-files.example/label.pdf",
        },
        selected_rate: { carrier: "CanadaPost", service: "Regular", rate: "11.25", currency: "CAD" },
        tracker: { public_url: "https://track.easypost.example/CP123" },
      }),
  ],
];

test("EasyPost buys the cheapest rate from the customer to the store, in inches and ounces", async () => {
  const { fetchImpl, calls } = fakeFetch(easyPostRoutes());
  const label = await labelProvider("EASYPOST", EASYPOST_KEY, fetchImpl).buyLabel({
    from: CUSTOMER,
    to: STORE,
    parcel: PARCEL,
    reference: "agent-return-1",
  });
  const [create, buy] = calls;
  assert.equal(header(create, "authorization"), `Basic ${Buffer.from(`${EASYPOST_KEY}:`).toString("base64")}`);
  const shipment = (create.body as { shipment: Record<string, unknown> }).shipment;
  assert.equal((shipment.from_address as LabelAddress).street1, CUSTOMER.street1);
  assert.equal((shipment.to_address as LabelAddress).street1, STORE.street1);
  assert.equal(shipment.is_return, undefined);
  assert.deepEqual(shipment.parcel, { length: 11.8, width: 7.9, height: 3.9, weight: 35.3 });
  assert.deepEqual(shipment.options, { label_format: "PDF" });
  assert.deepEqual(buy.body, { rate: { id: "rate_cheap" } });
  assert.deepEqual(label, {
    shipmentId: "shp_1",
    labelUrl: "https://easypost-files.example/label.pdf",
    trackingNumber: "CP123456789CA",
    trackingUrl: "https://track.easypost.example/CP123",
    carrier: "CanadaPost Regular",
    cost: { amount: "11.25", currency: "CAD" },
  });
});

test("Shippo buys the cheapest rate as a PDF and reports a failed transaction plainly", async () => {
  const shipment = () =>
    Response.json({
      object_id: "shp_s",
      rates: [
        { object_id: "r_dear", provider: "UPS", servicelevel: { name: "Ground" }, amount: "20.00", currency: "USD" },
        { object_id: "r_cheap", provider: "USPS", servicelevel: { name: "Ground Advantage" }, amount: "6.10", currency: "USD" },
      ],
    });
  const ok = fakeFetch([
    [/goshippo\.com\/shipments\/$/, shipment],
    [
      /goshippo\.com\/transactions\/$/,
      () =>
        Response.json({
          status: "SUCCESS",
          label_url: "https://deliver.goshippo.example/label.pdf",
          tracking_number: "9400111",
          tracking_url_provider: "https://tools.usps.example/9400111",
        }),
    ],
  ]);
  const label = await labelProvider("SHIPPO", "shippo_live_abcdef", ok.fetchImpl).buyLabel({
    from: CUSTOMER,
    to: STORE,
    parcel: PARCEL,
    reference: "agent-return-1",
  });
  assert.equal(header(ok.calls[0], "authorization"), "ShippoToken shippo_live_abcdef");
  const body = ok.calls[0].body as Record<string, unknown>;
  assert.equal((body.address_from as LabelAddress).street1, CUSTOMER.street1);
  assert.equal((body.address_to as LabelAddress).street1, STORE.street1);
  assert.equal(body.extra, undefined);
  assert.deepEqual(body.parcels, [
    { length: "30", width: "20", height: "10", distance_unit: "cm", weight: "1", mass_unit: "kg" },
  ]);
  assert.equal((ok.calls[1].body as Record<string, unknown>).rate, "r_cheap");
  assert.equal((ok.calls[1].body as Record<string, unknown>).label_file_type, "PDF");
  assert.equal(label.carrier, "USPS Ground Advantage");
  assert.deepEqual(label.cost, { amount: "6.10", currency: "USD" });

  const failed = fakeFetch([
    [/goshippo\.com\/shipments\/$/, shipment],
    [
      /goshippo\.com\/transactions\/$/,
      () => Response.json({ status: "ERROR", messages: [{ text: "Address not deliverable" }] }),
    ],
  ]);
  await assert.rejects(
    labelProvider("SHIPPO", "shippo_live_abcdef", failed.fetchImpl).buyLabel({
      from: CUSTOMER,
      to: STORE,
      parcel: PARCEL,
      reference: "agent-return-1",
    }),
    (error: unknown) =>
      error instanceof LabelProviderError && /Address not deliverable/.test(error.message),
  );
});

test("a rejected key or no rates is a plain message that never repeats the key", async () => {
  const rejected = fakeFetch([[/easypost/, () => new Response("{}", { status: 401 })]]);
  await assert.rejects(labelProvider("EASYPOST", EASYPOST_KEY, rejected.fetchImpl).verifyKey(), (error: unknown) => {
    assert.ok(error instanceof LabelProviderError);
    assert.match(error.message, /did not accept the API key/);
    assert.ok(!error.message.includes(EASYPOST_KEY));
    return true;
  });
  const noRates = fakeFetch([
    [/goshippo\.com\/shipments\/$/, () => Response.json({ object_id: "shp", rates: [], messages: [{ text: "Invalid zip" }] })],
  ]);
  await assert.rejects(
    labelProvider("SHIPPO", "shippo_test_key123", noRates.fetchImpl).buyLabel({
      from: CUSTOMER,
      to: STORE,
      parcel: PARCEL,
      reference: "r",
    }),
    /no rates for this return: Invalid zip/,
  );
  assert.equal(noRates.calls.length, 1);
});

test("parcel units convert to EasyPost's inches and ounces", () => {
  assert.deepEqual(
    toInchesAndOunces({ length: 12, width: 9, height: 4, distanceUnit: "in", weight: 2, massUnit: "lb" }),
    { length: 12, width: 9, height: 4, weight: 32 },
  );
  assert.equal(toInchesAndOunces({ ...PARCEL, weight: 500, massUnit: "g" }).weight, 17.6);
});

test("a shipping account is saved only after the provider accepts the key, and the key is sealed", async (t) => {
  withSecret(t);
  const upsert = mockDelegate(t, prisma.returnLabelAccount, "upsert", async () => ({}));
  const accepted = fakeFetch([[/api\.easypost\.com\/v2\/shipments\?page_size=1$/, () => Response.json({ shipments: [] })]]);
  await connectLabelAccount(SHOP, { provider: "EASYPOST", apiKey: ` ${EASYPOST_KEY} ` }, accepted.fetchImpl);
  const saved = (upsert.mock.calls[0].arguments[0] as { create: Record<string, unknown> }).create;
  assert.equal(saved.shop, SHOP);
  assert.equal(saved.apiKeyHint, "1234");
  assert.equal(saved.testMode, true);
  assert.ok(typeof saved.apiKeySealed === "string" && !saved.apiKeySealed.includes(EASYPOST_KEY));

  const rejected = fakeFetch([[/easypost/, () => new Response("{}", { status: 401 })]]);
  await assert.rejects(
    connectLabelAccount(SHOP, { provider: "EASYPOST", apiKey: "EZAKwrongkey" }, rejected.fetchImpl),
    /did not accept/,
  );
  await assert.rejects(connectLabelAccount("wix-6f1c2d3e-0a4b-4c5d-8e9f-1a2b3c4d5e6f", { provider: "SHIPPO", apiKey: "shippo_test_123456" }), /Shopify stores only/);
  assert.equal(upsert.mock.callCount(), 1);
});

// ---------------------------------------------------------------------------
// Buying a label for an approved return

type Handler = (variables: Record<string, unknown>) => unknown;

function fakeShopify(handlers: Record<string, Handler>) {
  const calls: Array<{ name: string; query: string; variables: Record<string, unknown> }> = [];
  const admin: AdminGraphql = {
    async graphql(query, options) {
      const name = Object.keys(handlers).find((key) => query.includes(key));
      if (!name) throw new Error(`Unexpected Shopify operation: ${query}`);
      calls.push({ name, query, variables: options?.variables ?? {} });
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
          reverseDeliveries: { nodes: deliverable ? [{ id: DELIVERY, deliverable }] : [] },
        },
      ],
    },
  },
});

const addresses = () => ({
  return: {
    order: {
      shippingAddress: {
        name: "Ada Customer",
        address1: "1 Customer St",
        city: "Toronto",
        provinceCode: "ON",
        zip: "M5V 1A1",
        countryCodeV2: "CA",
      },
      fulfillments: [{ location: { id: "gid://shopify/Location/5" } }],
    },
  },
  shop: { name: "Middle Out Merch", shopAddress: null },
});

const location = () => ({
  location: {
    address: { address1: "9 Store Rd", city: "Ottawa", provinceCode: "ON", zip: "K1A 0B1", countryCode: "CA" },
  },
});

const staged = () => ({
  stagedUploadsCreate: {
    stagedTargets: [
      {
        url: "https://shopify-staged-uploads.example/bucket",
        resourceUrl: "https://shopify-staged-uploads.example/bucket/return-label.pdf",
        parameters: [{ name: "key", value: "tmp/return-label.pdf" }],
      },
    ],
    userErrors: [],
  },
});

const created = () => ({ reverseDeliveryCreateWithShipping: { reverseDelivery: { id: DELIVERY }, userErrors: [] } });

function connectedAccount(t: TestContext, overrides: Record<string, unknown> = {}) {
  withSecret(t);
  return mockDelegate(t, prisma.returnLabelAccount, "findUnique", async () => ({
    shop: SHOP,
    provider: "EASYPOST",
    apiKeySealed: seal(EASYPOST_KEY, `return-label-key:${SHOP}`, "return-label-account"),
    apiKeyHint: "1234",
    testMode: true,
    enabled: true,
    parcelLength: "12",
    parcelWidth: "9",
    parcelHeight: "4",
    distanceUnit: "in",
    parcelWeight: "2",
    massUnit: "lb",
    ...overrides,
  }));
}

function claimableReturn(t: TestContext, count = 1) {
  const claim = mockDelegate(t, prisma.agentReturn, "updateMany", async () => ({ count }));
  mockDelegate(t, prisma.agentReturn, "findUniqueOrThrow", async () => ({ id: "agent-return-1", returnId: RETURN }));
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => ({ returnLocationId: null }));
  const updates = mockDelegate(t, prisma.agentReturn, "update", async () => ({}));
  return {
    claim,
    data: () => updates.mock.calls.map((call) => (call.arguments[0] as { data: Record<string, unknown> }).data),
  };
}

const labelFile = (): [RegExp, (call: FetchCall) => Response] => [
  /easypost-files\.example\/label\.pdf$/,
  () => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }),
];
const upload = (status = 204): [RegExp, (call: FetchCall) => Response] => [
  /shopify-staged-uploads\.example\/bucket$/,
  () => new Response(null, { status }),
];

test("an approved return gets a label bought once, saved for the customer, and attached in Shopify without an email", async (t) => {
  connectedAccount(t);
  const record = claimableReturn(t);
  const shopify = fakeShopify({
    ReturnShipping: shipping(null),
    ReturnLabelAddresses: addresses,
    ReturnLabelLocation: location,
    StageReturnLabel: staged,
    CreateReturnLabelDelivery: created,
  });
  const network = fakeFetch([...easyPostRoutes(), labelFile(), upload()]);
  const outcome = await buyReturnLabel({ admin: shopify.admin, shop: SHOP, recordId: "agent-return-1", fetchImpl: network.fetchImpl });
  assert.deepEqual(outcome, { status: "PURCHASED", attached: true, error: null });

  const claimWhere = (record.claim.mock.calls[0].arguments[0] as { where: Record<string, unknown> }).where;
  assert.deepEqual(claimWhere.OR, [{ labelStatus: null }, { labelStatus: "FAILED" }]);
  assert.equal(claimWhere.shop, SHOP);

  const shipment = (network.calls[0].body as { shipment: Record<string, LabelAddress> }).shipment;
  assert.equal(shipment.from_address.street1, "1 Customer St");
  assert.equal(shipment.to_address.street1, "9 Store Rd");
  assert.equal(shipment.to_address.company, "Middle Out Merch");

  const [saved, attached] = record.data();
  assert.equal(saved.labelStatus, "PURCHASED");
  assert.equal(saved.labelUrl, "https://easypost-files.example/label.pdf");
  assert.equal(saved.trackingNumber, "CP123456789CA");
  assert.equal(saved.labelCost, "11.25");
  assert.ok(attached.labelAttachedAt instanceof Date);

  const stage = shopify.calls.find((call) => call.name === "StageReturnLabel")!;
  assert.deepEqual(stage.variables.input, [
    { resource: "RETURN_LABEL", filename: "return-label.pdf", mimeType: "application/pdf", httpMethod: "POST", fileSize: "4" },
  ]);
  const form = network.calls.find((call) => /staged-uploads/.test(call.url))!.body as FormData;
  assert.equal(form.get("key"), "tmp/return-label.pdf");
  assert.ok(form.get("file") instanceof Blob);
  const attach = shopify.calls.find((call) => call.name === "CreateReturnLabelDelivery")!;
  assert.match(attach.query, /notifyCustomer: false/);
  assert.deepEqual(attach.variables, {
    reverseFulfillmentOrderId: REVERSE_ORDER,
    trackingInput: { number: "CP123456789CA", url: "https://track.easypost.example/CP123" },
    labelInput: { fileUrl: "https://shopify-staged-uploads.example/bucket/return-label.pdf" },
  });
});

test("no account, a turned-off account, or a return already claimed buys nothing", async (t) => {
  const network = fakeFetch([]);
  const shopify = fakeShopify({});
  const lookup = mockDelegate(t, prisma.returnLabelAccount, "findUnique", async () => null);
  const claim = mockDelegate(t, prisma.agentReturn, "updateMany", async () => ({ count: 0 }));
  const run = () => buyReturnLabel({ admin: shopify.admin, shop: SHOP, recordId: "agent-return-1", fetchImpl: network.fetchImpl });
  assert.equal((await run()).status, "SKIPPED");
  assert.equal(claim.mock.callCount(), 0);
  lookup.mock.mockImplementation(async () => ({ enabled: false }));
  assert.equal((await run()).status, "SKIPPED");
  assert.equal(claim.mock.callCount(), 0);
  lookup.mock.mockImplementation(async () => ({ enabled: true }));
  assert.equal((await run()).status, "SKIPPED");
  assert.equal(claim.mock.callCount(), 1);
  assert.equal(
    (await buyReturnLabel({ admin: shopify.admin, shop: "wix-6f1c2d3e-0a4b-4c5d-8e9f-1a2b3c4d5e6f", recordId: "r", fetchImpl: network.fetchImpl })).status,
    "SKIPPED",
  );
  assert.deepEqual(network.calls, []);
  assert.deepEqual(shopify.names(), []);
});

test("a return the store already labelled, or the customer is tracking, is released without buying", async (t) => {
  connectedAccount(t);
  const record = claimableReturn(t);
  const shopify = fakeShopify({
    ReturnShipping: shipping({ label: { publicFileUrl: "https://cdn.shopify.com/label.pdf" }, tracking: null }),
  });
  const network = fakeFetch([]);
  const outcome = await buyReturnLabel({ admin: shopify.admin, shop: SHOP, recordId: "agent-return-1", fetchImpl: network.fetchImpl });
  assert.equal(outcome.status, "SKIPPED");
  assert.deepEqual(record.data(), [{ labelStatus: null }]);
  assert.deepEqual(network.calls, []);
});

test("a failed purchase is recorded for the merchant and never throws", async (t) => {
  connectedAccount(t);
  const record = claimableReturn(t);
  const shopify = fakeShopify({
    ReturnShipping: shipping(null),
    ReturnLabelAddresses: addresses,
    ReturnLabelLocation: location,
  });
  const network = fakeFetch([[/easypost/, () => new Response("{}", { status: 401 })]]);
  const outcome = await buyReturnLabel({ admin: shopify.admin, shop: SHOP, recordId: "agent-return-1", fetchImpl: network.fetchImpl });
  assert.equal(outcome.status, "FAILED");
  const [failed] = record.data();
  assert.equal(failed.labelStatus, "FAILED");
  assert.match(String(failed.labelError), /did not accept the API key/);

  const noAddress = fakeShopify({
    ReturnShipping: shipping(null),
    ReturnLabelAddresses: () => ({ ...addresses(), return: { order: { shippingAddress: null, fulfillments: [] } } }),
  });
  const second = await buyReturnLabel({ admin: noAddress.admin, shop: SHOP, recordId: "agent-return-1", fetchImpl: network.fetchImpl });
  assert.equal(second.status, "FAILED");
  assert.match(second.status === "FAILED" ? second.error : "", /didn't share the customer's shipping address/);
});

test("a label bought but not attached in Shopify stays with the customer and tells the merchant", async (t) => {
  connectedAccount(t);
  const record = claimableReturn(t);
  const shopify = fakeShopify({
    ReturnShipping: shipping(null),
    ReturnLabelAddresses: addresses,
    ReturnLabelLocation: location,
    StageReturnLabel: staged,
  });
  const network = fakeFetch([...easyPostRoutes(), labelFile(), upload(403)]);
  const outcome = await buyReturnLabel({ admin: shopify.admin, shop: SHOP, recordId: "agent-return-1", fetchImpl: network.fetchImpl });
  assert.equal(outcome.status, "PURCHASED");
  assert.equal(outcome.status === "PURCHASED" && outcome.attached, false);
  const [saved, noted] = record.data();
  assert.equal(saved.labelStatus, "PURCHASED");
  assert.match(String(noted.labelError), /bought but not attached in Shopify/);
});

// ---------------------------------------------------------------------------
// What the customer sees

const BOUGHT = {
  id: "agent-return-1",
  returnId: RETURN,
  status: "REFUND_SUBMITTED",
  itemReceivedAt: null,
  labelStatus: "PURCHASED",
  labelUrl: "https://easypost-files.example/label.pdf",
  labelCarrier: "CanadaPost Regular",
  trackingNumber: "CP123456789CA",
  trackingUrl: "https://track.easypost.example/CP123",
};

test("the customer gets a bought label even before it reaches the Shopify return", async (t) => {
  mockDelegate(t, prisma.agentReturn, "findMany", async () => [BOUGHT]);
  const shopify = fakeShopify({ ReturnShipping: shipping(null) });
  const [entry] = await returnShippingFor({ shop: SHOP, customerSubjectHash: "customer-a" }, shopify.admin);
  assert.deepEqual(entry, {
    agentReturnId: "agent-return-1",
    labelUrl: BOUGHT.labelUrl,
    trackingNumber: BOUGHT.trackingNumber,
    trackingUrl: BOUGHT.trackingUrl,
    carrierName: BOUGHT.labelCarrier,
    canAddTracking: false,
  });
  const unreadable: AdminGraphql = { graphql: async () => { throw new Error("Shopify is down"); } };
  const [fallback] = await returnShippingFor({ shop: SHOP, customerSubjectHash: "customer-a" }, unreadable);
  assert.equal(fallback.labelUrl, BOUGHT.labelUrl);
});

test("a customer can't add tracking over a label the store's account bought", async (t) => {
  mockDelegate(t, prisma.agentReturn, "findFirst", async () => BOUGHT);
  const shopify = fakeShopify({});
  await assert.rejects(
    addReturnTracking(
      { shop: SHOP, customerSubjectHash: "customer-a" },
      { agentReturnId: "agent-return-1", trackingNumber: "1Z999AA10123456784" },
      shopify.admin,
    ),
    /already has tracking from the store's label/,
  );
  assert.deepEqual(shopify.names(), []);
});
