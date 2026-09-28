import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test, { type TestContext } from "node:test";
import { SignJWT, importPKCS8 } from "jose";
import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { resetWixTokenCache } from "../services/wix/wix-client.server";
import { action, loader } from "./webhooks.wix";

const appId = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const instanceId = "1b4f3c2a-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
const shop = `wix-${instanceId}`;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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

function configure(t: TestContext) {
  const saved = { ...process.env };
  process.env.WIX_APP_ID = appId;
  process.env.WIX_APP_SECRET = "app-secret";
  process.env.WIX_WEBHOOK_PUBLIC_KEY = publicPem;
  resetWixTokenCache();
  t.after(() => {
    process.env = saved;
    resetWixTokenCache();
  });
}

async function signed(eventType: string, data: Record<string, unknown>) {
  const key = await importPKCS8(privatePem, "RS256");
  return new SignJWT({
    data: JSON.stringify({ eventType, instanceId, data: JSON.stringify(data) }),
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .sign(key);
}

const post = (body: string, headers: Record<string, string> = {}) =>
  action({
    request: new Request("https://gooper.test/webhooks/wix", { method: "POST", body, headers }),
  } as ActionFunctionArgs);

function noReceipt(t: TestContext, seen = false) {
  mockDelegate(t, prisma.webhookReceipt, "findUnique", async () => (seen ? { id: "x" } : null));
  return mockDelegate(t, prisma.webhookReceipt, "create", async () => ({}));
}

test("only POST, within the size limit, when configured", async (t) => {
  configure(t);
  assert.equal(loader().status, 405);
  const get = await action({
    request: new Request("https://gooper.test/webhooks/wix"),
  } as ActionFunctionArgs);
  assert.equal(get.status, 405);
  assert.equal((await post("x", { "content-length": "600000" })).status, 413);
  assert.equal((await post("x".repeat(500_001))).status, 413);
  delete process.env.WIX_WEBHOOK_PUBLIC_KEY;
  assert.equal((await post("x")).status, 503);
});

test("unsigned or forged deliveries are rejected", async (t) => {
  configure(t);
  const create = noReceipt(t);
  assert.equal((await post("not-a-jwt")).status, 400);
  const token = await signed("AppRemoved", { appId });
  assert.equal((await post(`${token.slice(0, -4)}AAAA`)).status, 400);
  assert.equal(create.mock.callCount(), 0);
});

test("AppRemoved deletes the site's data", async (t) => {
  configure(t);
  noReceipt(t);
  const transaction = mockDelegate(t, prisma, "$transaction", async (ops: unknown[]) => ops);
  const deleteInstall = mockDelegate(t, prisma.wixInstallation, "deleteMany", async () => ({ count: 1 }));
  const response = await post(await signed("AppRemoved", { appId }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: true });
  assert.equal(transaction.mock.callCount(), 1);
  assert.deepEqual(deleteInstall.mock.calls[0].arguments[0], { where: { shop } });
});

test("AppInstalled provisions the site through Wix and records the delivery", async (t) => {
  configure(t);
  const create = noReceipt(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    urls.push(String(input));
    return String(input).endsWith("/oauth2/token")
      ? Response.json({ access_token: "tok", expires_in: 14_400 })
      : Response.json({
          instance: { instanceId, permissions: [] },
          site: { siteDisplayName: "Plant Shop", url: "https://jane.wixsite.com/plants", paymentCurrency: "EUR" },
        });
  });
  mockDelegate(t, prisma, "$transaction", async (ops: unknown[]) => ops);
  mockDelegate(t, prisma.merchantDirectory, "findUnique", async () => null);
  mockDelegate(t, prisma.merchantDirectory, "upsert", async () => ({}));
  const install = mockDelegate(t, prisma.wixInstallation, "upsert", async () => ({}));
  const policy = mockDelegate(t, prisma.storePolicy, "upsert", async () => ({}));

  const response = await post(await signed("AppInstalled", { appId }));
  assert.equal(response.status, 200);
  assert.deepEqual(urls, ["https://www.wixapis.com/oauth2/token", "https://www.wixapis.com/apps/v1/instance"]);
  assert.equal(install.mock.callCount(), 1);
  assert.equal(
    (policy.mock.calls[0].arguments[0] as unknown as { create: { currencyCode: string } }).create.currencyCode,
    "EUR",
  );
  const receipt = create.mock.calls[0].arguments[0] as unknown as { data: { shop: string; topic: string } };
  assert.equal(receipt.data.shop, shop);
  assert.equal(receipt.data.topic, "AppInstalled");
});

test("duplicate deliveries are acknowledged without work", async (t) => {
  configure(t);
  noReceipt(t, true);
  assert.deepEqual(await (await post(await signed("AppInstalled", { appId }))).json(), { duplicate: true });
});

test("paid plan and other events are ignored", async (t) => {
  configure(t);
  const create = noReceipt(t);
  const response = await post(await signed("PaidPlanPurchased", { vendorProductId: "pro" }));
  assert.deepEqual(await response.json(), { ignored: true });
  assert.equal(create.mock.callCount(), 0);
});

test("refund completed updates the matching return once", async (t) => {
  configure(t);
  const update = t.mock.fn(async () => ({ count: 1 }));
  const receipts: unknown[] = [];
  mockDelegate(t, prisma.webhookReceipt, "findUnique", async () => null);
  mockDelegate(t, prisma, "$transaction", async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      webhookReceipt: {
        findUnique: async () => null,
        create: async (args: unknown) => receipts.push(args),
      },
      agentReturn: { updateMany: update },
    }),
  );
  const response = await post(
    await signed("wix.ecom.v1.order_transactions_refund_completed", {
      id: "event-1",
      entityId: "order-1",
      actionEvent: {
        body: { orderId: "order-1", refund: { id: "refund-1", transactions: [{ refundStatus: "SUCCEEDED" }] } },
      },
    }),
  );
  assert.deepEqual(await response.json(), { recorded: true });
  assert.equal(update.mock.callCount(), 1);
  assert.deepEqual(receipts, [
    { data: { id: "wix:event-1", shop, topic: "wix.ecom.v1.order_transactions_refund_completed" } },
  ]);
});
