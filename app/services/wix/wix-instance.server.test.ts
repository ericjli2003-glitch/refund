import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  WixInstanceRejected,
  verifyWixDashboardInstance,
  verifyWixDashboardToken,
} from "./wix-instance.server";

const secret = "app-secret";
const instanceId = "1b4f3c2a-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
const now = new Date("2026-09-28T12:00:00Z");

// Signs like Wix: HMAC-SHA256 over the base64url data part, both unpadded.
function sign(payload: unknown, key = secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key).update(data).digest("base64url");
  return `${signature}.${data}`;
}

const payload = (overrides: Record<string, unknown> = {}) => ({
  instanceId: instanceId.toUpperCase(),
  appDefId: "app-id",
  signDate: "2026-09-28T11:30:00.000Z",
  uid: "user-1",
  permissions: "OWNER",
  siteOwnerId: "owner-1",
  vendorProductId: "",
  ...overrides,
});

test("verifies a signed dashboard instance", () => {
  const result = verifyWixDashboardInstance(sign(payload()), { secret, now });
  assert.deepEqual(result, {
    instanceId,
    shop: `wix-${instanceId}`,
    userId: "user-1",
    permissions: "OWNER",
    siteOwnerId: "owner-1",
    vendorProductId: undefined,
    signDate: new Date("2026-09-28T11:30:00.000Z"),
  });
});

test("tolerates padding on the signature and a missing sign date", () => {
  const [signature, data] = sign(payload({ signDate: undefined })).split(".");
  const result = verifyWixDashboardInstance(`${signature}=.${data}`, { secret, now });
  assert.equal(result.shop, `wix-${instanceId}`);
  assert.equal(result.signDate, undefined);
});

test("rejects forged, altered and malformed instances", () => {
  const good = sign(payload());
  const [signature, data] = good.split(".");
  const altered = Buffer.from(
    JSON.stringify(payload({ instanceId: "2b4f3c2a-9d8e-4f7a-8b6c-5d4e3f2a1b0c" })),
  ).toString("base64url");
  for (const value of [
    sign(payload(), "other-secret"),
    `${signature}.${altered}`,
    `${signature.slice(0, -2)}.${data}`,
    `${data}.${signature}`,
    `${signature}.${data}.extra`,
    `${signature}`,
    "",
    null,
    undefined,
    `${signature}!.${data}`,
    "a".repeat(9000),
  ])
    assert.throws(() => verifyWixDashboardInstance(value, { secret, now }), WixInstanceRejected, String(value).slice(0, 40));
});

test("rejects payloads without a valid instance ID", () => {
  for (const bad of [payload({ instanceId: undefined }), payload({ instanceId: "../x" }), [1, 2]])
    assert.throws(() => verifyWixDashboardInstance(sign(bad), { secret, now }), WixInstanceRejected);
  const notJson = Buffer.from("not json").toString("base64url");
  const signature = createHmac("sha256", secret).update(notJson).digest("base64url");
  assert.throws(() => verifyWixDashboardInstance(`${signature}.${notJson}`, { secret, now }), WixInstanceRejected);
});

test("rejects stale, future-dated and unreadable sign dates", () => {
  for (const signDate of ["2026-09-27T11:00:00.000Z", "2026-09-28T12:10:00.000Z", "yesterday"])
    assert.throws(
      () => verifyWixDashboardInstance(sign(payload({ signDate })), { secret, now }),
      /Expired/,
      signDate,
    );
  // A shorter window is the caller's choice.
  assert.throws(
    () => verifyWixDashboardInstance(sign(payload()), { secret, now, maxAgeMs: 10 * 60_000 }),
    /Expired/,
  );
});

test("an unset secret is a configuration error", () => {
  assert.throws(
    () => verifyWixDashboardInstance(sign(payload()), { secret: "", now }),
    (error: Error) => !(error instanceof WixInstanceRejected),
  );
});

test("dashboard access tokens are checked with Wix and must belong to this app", async () => {
  const calls: RequestInit[] = [];
  const fetchWith = (status: number, body: unknown) =>
    (async (_url: string | URL | Request, init: RequestInit = {}) => {
      calls.push(init);
      return Response.json(body, { status });
    }) as typeof fetch;

  const result = await verifyWixDashboardToken("Bearer tok", {
    appId: "app-id",
    fetch: fetchWith(200, { clientId: "app-id", instanceId }),
  });
  assert.deepEqual(result, { instanceId, shop: `wix-${instanceId}` });
  assert.deepEqual(JSON.parse(String(calls[0].body)), { token: "tok" });

  await assert.rejects(
    verifyWixDashboardToken("tok", { appId: "app-id", fetch: fetchWith(200, { clientId: "other", instanceId }) }),
    WixInstanceRejected,
  );
  await assert.rejects(
    verifyWixDashboardToken("tok", { appId: "app-id", fetch: fetchWith(200, { clientId: "app-id" }) }),
    WixInstanceRejected,
  );
  await assert.rejects(
    verifyWixDashboardToken("tok", { appId: "app-id", fetch: fetchWith(401, {}) }),
    WixInstanceRejected,
  );
  await assert.rejects(
    verifyWixDashboardToken("", { appId: "app-id", fetch: fetchWith(200, {}) }),
    WixInstanceRejected,
  );
  const outage = await verifyWixDashboardToken("tok", {
    appId: "app-id",
    fetch: fetchWith(503, {}),
  }).catch((error) => error);
  assert.ok(!(outage instanceof WixInstanceRejected));
});
