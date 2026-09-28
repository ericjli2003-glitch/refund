import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { SignJWT, importPKCS8 } from "jose";

import {
  WIX_WEBHOOK_MAX_AGE_MS,
  WixWebhookRejected,
  parseWixPublicKey,
  verifyWixWebhook,
  wixActionBody,
} from "./wix-webhooks.server";

const appId = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const instanceId = "1b4f3c2a-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
const now = new Date("2026-09-28T12:00:00Z");

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
const wix = keyPair();
const other = keyPair();

// Builds a delivery the way Wix does: the JWT's `data` claim is a JSON string
// whose `data` and `identity` are JSON strings again.
async function delivery(
  envelope: Record<string, unknown>,
  { privatePem = wix.privatePem, iat = now, alg = "RS256" } = {},
) {
  const key = await importPKCS8(privatePem, alg);
  return new SignJWT({ data: JSON.stringify(envelope) })
    .setProtectedHeader({ alg })
    .setIssuedAt(Math.floor(iat.getTime() / 1000))
    .sign(key);
}

const installed = (overrides: Record<string, unknown> = {}) => ({
  eventType: "AppInstalled",
  instanceId,
  data: JSON.stringify({ appId, originInstanceId: "" }),
  identity: JSON.stringify({ identityType: "WIX_USER", wixUserId: "user-1" }),
  accountInfo: { accountId: "acc-1", siteId: "site-1" },
  ...overrides,
});

const options = { publicKey: wix.publicPem, appId, now };

test("verifies a signed Wix delivery and unwraps the nested JSON", async () => {
  const event = await verifyWixWebhook(await delivery(installed()), options);
  assert.equal(event.eventType, "AppInstalled");
  assert.equal(event.instanceId, instanceId);
  assert.equal(event.shop, `wix-${instanceId}`);
  assert.deepEqual(event.data, { appId, originInstanceId: "" });
  assert.equal(event.identity?.identityType, "WIX_USER");
  assert.equal(event.identity?.wixUserId, "user-1");
  assert.equal(event.accountInfo?.siteId, "site-1");
  assert.match(event.id, /^wix-jwt:[0-9a-f]{64}$/);
});

test("app events are identified per delivery; domain events by their event ID", async () => {
  const first = await verifyWixWebhook(await delivery(installed()), options);
  const reinstall = await verifyWixWebhook(
    await delivery(installed(), { iat: new Date(now.getTime() - 60_000) }),
    options,
  );
  assert.notEqual(first.id, reinstall.id);

  const body = { orderId: "order-1", refund: { id: "refund-1", transactions: [] } };
  const token = await delivery({
    eventType: "wix.ecom.v1.order_transactions_refund_completed",
    instanceId,
    data: JSON.stringify({ id: "event-7", entityId: "order-1", actionEvent: { body } }),
  });
  const refund = await verifyWixWebhook(token, options);
  assert.equal(refund.id, "wix:event-7");
  assert.deepEqual(wixActionBody(refund), body);
  assert.equal(wixActionBody(first), null);
});

test("accepts the public key base64-encoded or with escaped newlines", async () => {
  const token = await delivery(installed());
  const encoded = Buffer.from(wix.publicPem).toString("base64");
  assert.equal(parseWixPublicKey(encoded), wix.publicPem.trim());
  await verifyWixWebhook(token, { ...options, publicKey: encoded });
  await verifyWixWebhook(token, { ...options, publicKey: wix.publicPem.replace(/\n/g, "\\n") });
});

test("rejects bad signatures, other keys and tampered tokens", async () => {
  const token = await delivery(installed());
  const [header, payload, signature] = token.split(".");
  const tampered = `${header}.${Buffer.from(
    JSON.stringify({ data: JSON.stringify(installed({ instanceId: "2b4f3c2a-9d8e-4f7a-8b6c-5d4e3f2a1b0c" })), iat: 1 }),
  ).toString("base64url")}.${signature}`;
  for (const body of [
    await delivery(installed(), { privatePem: other.privatePem }),
    tampered,
    `${header}.${payload}.`,
    "",
    "not a token",
    JSON.stringify(installed()),
  ])
    await assert.rejects(verifyWixWebhook(body, options), WixWebhookRejected);
});

test("refuses tokens signed with another algorithm", async () => {
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ data: JSON.stringify(installed()) }),
  ).toString("base64url")}.`;
  await assert.rejects(verifyWixWebhook(unsigned, options), WixWebhookRejected);
});

test("rejects missing or malformed envelope fields", async () => {
  for (const envelope of [
    installed({ eventType: undefined }),
    installed({ eventType: "" }),
    installed({ instanceId: undefined }),
    installed({ instanceId: "not-a-uuid" }),
    installed({ data: undefined }),
    installed({ data: "{broken" }),
    installed({ data: JSON.stringify([1]) }),
    installed({ identity: "{broken" }),
  ])
    await assert.rejects(verifyWixWebhook(await delivery(envelope), options), WixWebhookRejected);

  const key = await importPKCS8(wix.privatePem, "RS256");
  const noData = await new SignJWT({ other: 1 }).setProtectedHeader({ alg: "RS256" }).sign(key);
  await assert.rejects(verifyWixWebhook(noData, options), WixWebhookRejected);
});

test("rejects events for another app", async () => {
  const otherApp = installed({ data: JSON.stringify({ appId: "ffffffff-4f50-4a6b-8c7d-9e0f1a2b3c4d" }) });
  await assert.rejects(verifyWixWebhook(await delivery(otherApp), options), /different app/);
  const noApp = installed({ eventType: "AppRemoved", data: JSON.stringify({}) });
  await assert.rejects(verifyWixWebhook(await delivery(noApp), options), /different app/);
});

test("rejects replays outside the delivery window and tokens from the future", async () => {
  const old = new Date(now.getTime() - WIX_WEBHOOK_MAX_AGE_MS - 1000);
  await assert.rejects(verifyWixWebhook(await delivery(installed(), { iat: old }), options), /Stale/);
  const future = new Date(now.getTime() + 10 * 60_000);
  await assert.rejects(verifyWixWebhook(await delivery(installed(), { iat: future }), options), /Stale/);
});

test("a misconfigured key is a server error, not a rejected delivery", async () => {
  const error = await verifyWixWebhook(await delivery(installed()), {
    ...options,
    publicKey: "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----",
  }).catch((caught) => caught);
  assert.ok(error instanceof Error);
  assert.ok(!(error instanceof WixWebhookRejected));
});
