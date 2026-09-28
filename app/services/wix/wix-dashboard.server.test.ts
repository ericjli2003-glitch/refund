import assert from "node:assert/strict";
import test from "node:test";

import { RETURN_INSTRUCTIONS_MAX_LENGTH } from "../return-guidance.server";
import { FINAL_SALE_COLLECTION_LIMIT } from "../verified-customer-returns.server";
import {
  WIX_FRAME_ANCESTORS,
  isSameOriginPost,
  parseReturnPolicyForm,
  policyHostsFor,
  requireWixDashboardSession,
  safeTrackingUrl,
  signedInstanceFrom,
  wixDashboardHeaders,
  type WixDashboardIdentity,
} from "./wix-dashboard.server";

const INSTANCE_ID = "3f6c1a52-8b1e-4c5a-9d2f-0a1b2c3d4e5f";
const SHOP = `wix-${INSTANCE_ID}`;
const OTHER_ID = "9a9a9a9a-1111-4222-8333-444455556666";
const ORIGIN = "https://gooper.test";
const SECRET = "test-secret";
const COLLECTION = "1b0e7a5c-2d3f-4a6b-8c9d-0e1f2a3b4c5d";
const ALL_PRODUCTS = "00000000-000000-000000-000000000001";
const NOW = new Date("2026-09-28T12:00:00Z");

function form(fields: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields))
    for (const item of Array.isArray(value) ? value : [value])
      data.append(name, item);
  return data;
}

const validPolicy = (overrides: Record<string, string | string[]> = {}) =>
  form({
    automaticRefundsEnabled: "true",
    returnWindowDays: "30",
    maxAutoRefundAmount: "150",
    refundTiming: "ON_RECEIPT",
    verifiedStoreLinks: "true",
    restockingFeePercent: "10.555",
    returnShippingFee: "5",
    finalSaleCollectionIds: [COLLECTION, COLLECTION],
    returnInstructions: "  Pack it well.\r\n\r\n\r\nShip it back.  ",
    returnPolicyUrl: "https://shop.example.com/returns#top",
    ...overrides,
  });

const OPTIONS = {
  currencyCode: "CAD",
  knownCollectionIds: [COLLECTION, ALL_PRODUCTS],
  allowedPolicyHosts: ["shop.example.com"],
  now: NOW,
};

test("a valid Wix policy form becomes the same StorePolicy shape Shopify saves", () => {
  const result = parseReturnPolicyForm(validPolicy(), OPTIONS);
  assert.deepEqual(result, {
    ok: true,
    policy: {
      automaticRefundsEnabled: true,
      returnWindowDays: 30,
      maxAutoRefundAmount: "150.00",
      currencyCode: "CAD",
      returnLocationId: null,
      returnInstructions: "Pack it well.\n\nShip it back.",
      returnPolicyUrl: "https://shop.example.com/returns",
      refundTiming: "ON_RECEIPT",
      verifiedStoreLinks: true,
      restockingFeePercent: "10.56",
      returnShippingFee: "5.00",
      finalSaleCollectionIds: [COLLECTION],
      returnRulesConfirmedAt: NOW,
      returnRulesMismatch: null,
    },
  });
});

test("unchecked boxes and unknown timings fall back like the Shopify form", () => {
  const data = validPolicy({ refundTiming: "WHENEVER" });
  data.delete("automaticRefundsEnabled");
  data.delete("verifiedStoreLinks");
  data.delete("restockingFeePercent");
  data.delete("returnShippingFee");
  data.delete("finalSaleCollectionIds");
  data.delete("returnInstructions");
  data.delete("returnPolicyUrl");
  const result = parseReturnPolicyForm(data, OPTIONS);
  assert.ok(result.ok);
  assert.equal(result.policy.automaticRefundsEnabled, false);
  assert.equal(result.policy.verifiedStoreLinks, false);
  assert.equal(result.policy.refundTiming, "IMMEDIATE");
  assert.equal(result.policy.restockingFeePercent, "0");
  assert.equal(result.policy.returnShippingFee, "0.00");
  assert.deepEqual(result.policy.finalSaleCollectionIds, []);
  assert.equal(result.policy.returnInstructions, null);
  assert.equal(result.policy.returnPolicyUrl, null);
});

test("the Shopify bounds apply to every number", () => {
  for (const [field, value] of [
    ["returnWindowDays", "0"],
    ["returnWindowDays", "366"],
    ["returnWindowDays", "7.5"],
    ["returnWindowDays", "abc"],
    ["maxAutoRefundAmount", "0"],
    ["maxAutoRefundAmount", "-1"],
    ["maxAutoRefundAmount", "100000.01"],
    ["maxAutoRefundAmount", "Infinity"],
    ["restockingFeePercent", "-0.01"],
    ["restockingFeePercent", "100.01"],
    ["restockingFeePercent", "NaN"],
    ["returnShippingFee", "-1"],
    ["returnShippingFee", "1000.01"],
  ] as const) {
    const result = parseReturnPolicyForm(
      validPolicy({ [field]: value }),
      OPTIONS,
    );
    assert.equal(result.ok, false, `${field}=${value} should be refused`);
  }
  for (const [field, value] of [
    ["returnWindowDays", "1"],
    ["returnWindowDays", "365"],
    ["maxAutoRefundAmount", "100000"],
    ["restockingFeePercent", "100"],
    ["returnShippingFee", "1000"],
  ] as const)
    assert.equal(
      parseReturnPolicyForm(validPolicy({ [field]: value }), OPTIONS).ok,
      true,
      `${field}=${value} is within bounds`,
    );
});

test("final-sale choices must be IDs Wix just listed for this site", () => {
  const refused = (
    ids: string[],
    knownCollectionIds: string[] | null = OPTIONS.knownCollectionIds,
  ) =>
    parseReturnPolicyForm(validPolicy({ finalSaleCollectionIds: ids }), {
      ...OPTIONS,
      knownCollectionIds,
    }).ok === false;
  assert.ok(refused(["gid://shopify/Collection/123"]));
  assert.ok(refused(["<script>"]));
  assert.ok(refused(["x".repeat(65)]));
  // Well-formed, but not one of this site's collections.
  assert.ok(refused(["2b0e7a5c-2d3f-4a6b-8c9d-0e1f2a3b4c5d"]));
  // Wix couldn't be read: nothing can be confirmed.
  assert.ok(refused([COLLECTION], null));
  // Too many, even if every one exists.
  const many = Array.from(
    { length: FINAL_SALE_COLLECTION_LIMIT + 1 },
    (_, index) =>
      `0000000${index.toString(16).padStart(1, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  );
  assert.ok(refused(many, many));
  // Wix's own non-standard "All Products" ID is still accepted.
  assert.equal(refused([ALL_PRODUCTS]), false);
  // Choosing none never needs Wix.
  const none = validPolicy();
  none.delete("finalSaleCollectionIds");
  assert.equal(
    parseReturnPolicyForm(none, { ...OPTIONS, knownCollectionIds: null }).ok,
    true,
  );
});

test("the return policy link must stay on the site's own domain", () => {
  for (const url of [
    "http://shop.example.com/returns",
    "https://evil.test/returns",
    "https://shop.example.com.evil.test/returns",
    "https://user:pass@shop.example.com/returns",
    "javascript:alert(1)",
  ]) {
    const result = parseReturnPolicyForm(
      validPolicy({ returnPolicyUrl: url }),
      OPTIONS,
    );
    assert.equal(result.ok, false, url);
    if (!result.ok) assert.match(result.error, /own store domain|full https/);
  }
  assert.equal(
    parseReturnPolicyForm(validPolicy(), { ...OPTIONS, allowedPolicyHosts: [] })
      .ok,
    false,
  );
  assert.equal(
    parseReturnPolicyForm(
      validPolicy({
        returnInstructions: "x".repeat(RETURN_INSTRUCTIONS_MAX_LENGTH + 1),
      }),
      OPTIONS,
    ).ok,
    false,
  );
});

test("currency comes from the site, never the form", () => {
  const withCurrency = validPolicy({ currencyCode: "USD" });
  const result = parseReturnPolicyForm(withCurrency, OPTIONS);
  assert.ok(result.ok);
  assert.equal(result.policy.currencyCode, "CAD");
  assert.equal(
    parseReturnPolicyForm(validPolicy(), { ...OPTIONS, currencyCode: null }).ok,
    false,
  );
});

test("policy hosts are the directory domain and the site's own host", () => {
  assert.deepEqual(
    policyHostsFor("Shop.Example.com", "https://owner.wixsite.com/my-shop"),
    ["shop.example.com", "owner.wixsite.com"],
  );
  assert.deepEqual(policyHostsFor(null, "not a url"), []);
  // The store key stands in for sites without a custom domain; it is no host.
  assert.deepEqual(policyHostsFor(SHOP, "https://www.wix.com/site"), []);
  assert.deepEqual(policyHostsFor(null, "https://editorx.io/x"), []);
});

test("tracking links are shown only for https addresses", () => {
  assert.equal(
    safeTrackingUrl("https://track.example/abc"),
    "https://track.example/abc",
  );
  assert.equal(safeTrackingUrl("http://track.example/abc"), null);
  assert.equal(safeTrackingUrl("javascript:alert(1)"), null);
  assert.equal(safeTrackingUrl(null), null);
});

// --- Carrying the signed instance from the first load to every post ---------

const identity = (instanceId = INSTANCE_ID): WixDashboardIdentity => ({
  instanceId,
  shop: `wix-${instanceId}`,
  userId: "user-1",
  permissions: "OWNER",
});

// Stands in for Agent A's verifier: "signed:<id>" is valid, anything else is not.
const verify = (value: string, options: { secret: string; now: Date }) => {
  assert.equal(options.secret, SECRET);
  assert.equal(options.now, NOW);
  if (value === "stale") throw new Error("stale instance");
  const match = /^signed:(.+)$/.exec(value);
  return match ? identity(match[1]) : null;
};

const identityOptions = { verify, secret: SECRET, now: NOW, origin: ORIGIN };

const get = (instance?: string) =>
  new Request(
    `${ORIGIN}/wix/dashboard${instance ? `?instance=${encodeURIComponent(instance)}` : ""}`,
  );

const post = (
  urlInstance: string | null,
  headers: Record<string, string> = { Origin: ORIGIN },
) =>
  new Request(
    `${ORIGIN}/wix/dashboard${urlInstance ? `?instance=${encodeURIComponent(urlInstance)}` : ""}`,
    { method: "POST", headers },
  );

test("the page load is identified only by the instance Wix signed", async () => {
  const session = await requireWixDashboardSession(
    get(`signed:${INSTANCE_ID}`),
    undefined,
    identityOptions,
  );
  assert.equal(session.identity.shop, SHOP);
  assert.equal(session.signedInstance, `signed:${INSTANCE_ID}`);

  for (const request of [get(), get("forged"), get("stale")]) {
    await assert.rejects(
      requireWixDashboardSession(request, undefined, identityOptions),
      (error: unknown) => error instanceof Response && error.status === 401,
    );
  }
});

test("posts re-verify the instance carried in the form, not the address", async () => {
  const session = await requireWixDashboardSession(
    post(null),
    form({ instance: `signed:${INSTANCE_ID}` }),
    identityOptions,
  );
  assert.equal(session.identity.shop, SHOP);

  // An instance only in the URL isn't enough for a post.
  await assert.rejects(
    requireWixDashboardSession(
      post(`signed:${INSTANCE_ID}`),
      form({}),
      identityOptions,
    ),
    (error: unknown) => error instanceof Response && error.status === 401,
  );
  // The form's instance wins over a different one in the URL.
  const mixed = await requireWixDashboardSession(
    post(`signed:${OTHER_ID}`),
    form({ instance: `signed:${INSTANCE_ID}` }),
    identityOptions,
  );
  assert.equal(mixed.identity.shop, SHOP);
  // A stale or tampered form value is refused.
  for (const value of ["stale", `forged:${INSTANCE_ID}`, "x".repeat(5000)])
    await assert.rejects(
      requireWixDashboardSession(
        post(null),
        form({ instance: value }),
        identityOptions,
      ),
      (error: unknown) => error instanceof Response && error.status === 401,
    );
});

test("a post from another site is refused even with a valid instance", async () => {
  const hostile: Array<Record<string, string>> = [
    { Origin: "https://evil.test" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of hostile)
    await assert.rejects(
      requireWixDashboardSession(
        post(null, headers),
        form({ instance: `signed:${INSTANCE_ID}` }),
        identityOptions,
      ),
      (error: unknown) => error instanceof Response && error.status === 401,
    );
  assert.equal(
    isSameOriginPost(post(null, { "Sec-Fetch-Site": "same-origin" }), ORIGIN),
    true,
  );
  assert.equal(isSameOriginPost(get(), ORIGIN), true);
});

test("the verified shop must be the store key of the verified instance", async () => {
  const mismatched = () => ({ ...identity(), shop: `wix-${OTHER_ID}` });
  await assert.rejects(
    requireWixDashboardSession(get("anything"), undefined, {
      ...identityOptions,
      verify: mismatched,
    }),
    (error: unknown) => error instanceof Response && error.status === 401,
  );
  await assert.rejects(
    requireWixDashboardSession(get("anything"), undefined, {
      ...identityOptions,
      verify: () => ({ instanceId: "not-a-uuid", shop: "wix-not-a-uuid" }),
    }),
    (error: unknown) => error instanceof Response && error.status === 401,
  );
});

test("without the app secret the dashboard fails closed", async () => {
  await assert.rejects(
    requireWixDashboardSession(get(`signed:${INSTANCE_ID}`), undefined, {
      ...identityOptions,
      secret: "",
    }),
    (error: unknown) => error instanceof Response && error.status === 503,
  );
});

test("the instance is read from the right place for each method", () => {
  assert.equal(signedInstanceFrom(get("abc")), "abc");
  assert.equal(signedInstanceFrom(post("abc"), form({})), null);
  assert.equal(
    signedInstanceFrom(post(null), form({ instance: "def" })),
    "def",
  );
  assert.equal(signedInstanceFrom(get("")), null);
});

test("only Wix may frame the dashboard, and the instance never leaks by Referer", () => {
  const headers = wixDashboardHeaders();
  assert.match(
    headers["Content-Security-Policy"],
    /frame-ancestors https:\/\/manage\.wix\.com /,
  );
  assert.ok(!headers["Content-Security-Policy"].includes("*;"));
  for (const origin of WIX_FRAME_ANCESTORS) assert.match(origin, /^https:\/\//);
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.equal(headers["Cache-Control"], "no-store, private");
  assert.equal("X-Frame-Options" in headers, false);
});

test("a real Wix-signed instance survives the round trip from load to post", async () => {
  const { createHmac } = await import("node:crypto");
  const data = Buffer.from(
    JSON.stringify({
      instanceId: INSTANCE_ID,
      signDate: NOW.toISOString(),
      uid: "u1",
    }),
  ).toString("base64url");
  const signed = `${createHmac("sha256", SECRET).update(data).digest("base64url")}.${data}`;
  const options = { secret: SECRET, now: NOW, origin: ORIGIN };
  const loaded = await requireWixDashboardSession(
    get(signed),
    undefined,
    options,
  );
  assert.equal(loaded.identity.shop, SHOP);
  const posted = await requireWixDashboardSession(
    post(null),
    form({ instance: loaded.signedInstance }),
    options,
  );
  assert.equal(posted.identity.shop, SHOP);
  // Signed with another secret, or a day later, it no longer works.
  await assert.rejects(
    requireWixDashboardSession(get(signed), undefined, {
      ...options,
      secret: "other",
    }),
  );
  await assert.rejects(
    requireWixDashboardSession(get(signed), undefined, {
      ...options,
      now: new Date(NOW.getTime() + 25 * 3_600_000),
    }),
  );
});
