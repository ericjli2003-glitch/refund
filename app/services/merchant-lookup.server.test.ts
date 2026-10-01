import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import {
  compactMerchantName,
  findStore,
  similarMerchantName,
} from "./merchant-lookup.server";

process.env.SHOPIFY_APP_URL = "https://refund.test";

function mockDelegate(
  t: TestContext,
  target: object,
  name: string,
  implementation: (...args: never[]) => unknown,
) {
  const original = Reflect.get(target, name);
  Reflect.set(target, name, t.mock.fn(implementation));
  t.after(() => Reflect.set(target, name, original));
}

type Profile = { shop: string; name: string; primaryDomain: string };

// Each search gets the next list of profiles; the last list repeats.
function directory(
  t: TestContext,
  profiles: Profile[] | Profile[][],
  installed: string[],
) {
  const searches: unknown[] = [];
  const opportunities: unknown[] = [];
  const pages = Array.isArray(profiles[0]) ? (profiles as Profile[][]) : [profiles as Profile[]];
  mockDelegate(t, prisma.merchantDirectory, "findMany", async (args: never) => {
    searches.push(args);
    return pages[Math.min(searches.length - 1, pages.length - 1)];
  });
  mockDelegate(t, prisma.session, "findMany", async () =>
    installed.map((shop) => ({ shop })),
  );
  mockDelegate(t, prisma.merchantOpportunity, "deleteMany", async () => ({
    count: 0,
  }));
  mockDelegate(t, prisma.merchantOpportunity, "upsert", async (args: never) => {
    opportunities.push(args);
    return {};
  });
  return { searches, opportunities };
}

const SNOW = { shop: "snow.myshopify.com", name: "Snow Supply", primaryDomain: "snowsupply.com" };
const SNOWBOARD = { shop: "board.myshopify.com", name: "Snowboard Hut", primaryDomain: "snowboardhut.com" };

test("a single listed, installed store matches by partial name and is used without asking", async (t) => {
  const { searches, opportunities } = directory(t, [SNOW], [SNOW.shop]);
  const result = await findStore("snow supply");
  assert.equal(result.status, "matched");
  assert.deepEqual(result.merchants, [
    {
      name: "Snow Supply",
      shop: SNOW.shop,
      domain: "snowsupply.com",
      returnPage: "https://refund.test/stores/snow.myshopify.com",
      matchedBy: "name",
    },
  ]);
  assert.equal(result.selectionRequired, false);
  assert.match(result.nextStep, /go ahead with it without asking/);
  const where = (searches[0] as { where: Record<string, unknown> }).where;
  assert.equal(where.discoveryPublished, true);
  assert.equal(opportunities.length, 0);
});

test("several matches are all returned for the customer to choose, never picked", async (t) => {
  const { opportunities } = directory(t, [SNOW, SNOWBOARD], [SNOW.shop, SNOWBOARD.shop]);
  const result = await findStore("snow");
  assert.equal(result.status, "multiple_matches");
  assert.equal(result.selectionRequired, true);
  assert.deepEqual(
    result.merchants.map((merchant) => merchant.shop),
    [SNOW.shop, SNOWBOARD.shop],
  );
  assert.equal(result.returnSubmitted, false);
  assert.equal(opportunities.length, 0);
});

test("a listed store that is no longer installed is not found, and the request stops", async (t) => {
  const { opportunities } = directory(t, [SNOW], []);
  const result = await findStore("Snow Supply");
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.merchants, []);
  assert.match(result.nextStep, /Stop here/);
  assert.equal(opportunities.length, 1);
});

test("searches carrying anything but a business name or website are refused before any lookup", async (t) => {
  const { searches } = directory(t, [SNOW], [SNOW.shop]);
  const result = await findStore("buyer@example.com order 1001");
  assert.equal(result.status, "invalid_query");
  assert.equal(searches.length, 0);
});

const BLUE_SKY = { shop: "bluesky.myshopify.com", name: "Blue Sky Co.", primaryDomain: "blueskyco.com" };
const BLUE_SKIES = { shop: "blueskies.myshopify.com", name: "Blue Skies", primaryDomain: "blueskies.com" };

test("store names compare without spacing, punctuation or filler words", () => {
  assert.equal(compactMerchantName("Blue Sky Co."), "bluesky");
  assert.equal(compactMerchantName("The BlueSky Shop"), "bluesky");
  assert.equal(compactMerchantName("Café & Co"), "cafeand");
  assert.ok(similarMerchantName("bluesky", "Blue Sky Co."));
  assert.ok(similarMerchantName("Blue Skye", "Blue Sky Co."));
  assert.ok(similarMerchantName("Snow Suply", "Snow Supply"));
  // Short names must match exactly; one letter makes a different store.
  assert.ok(!similarMerchantName("Lux", "Lix"));
  assert.ok(!similarMerchantName("Snow Supply", "Snowboard Hut"));
});

test("a misspelled name falls back to similar names, and the customer is asked to confirm", async (t) => {
  const { searches } = directory(t, [[], [BLUE_SKY, SNOW]], [BLUE_SKY.shop, SNOW.shop]);
  const result = await findStore("Blu Sky");
  assert.equal(searches.length, 2);
  assert.equal(result.status, "matched");
  assert.deepEqual(result.merchants.map((merchant) => merchant.shop), [BLUE_SKY.shop]);
  assert.equal(result.merchants[0].matchedBy, "similar_name");
  assert.match(result.nextStep, /Did you mean Blue Sky Co\. \(blueskyco\.com\)\?/);
});

test("a website picks its store even when other names contain the same words", async (t) => {
  directory(t, [BLUE_SKY, BLUE_SKIES], [BLUE_SKY.shop, BLUE_SKIES.shop]);
  const result = await findStore("blueskies.com");
  assert.equal(result.status, "matched");
  assert.deepEqual(result.merchants.map((merchant) => merchant.shop), [BLUE_SKIES.shop]);
  assert.equal(result.merchants[0].matchedBy, "website");
});

test("several similar stores narrow to the one with the customer's orders", async (t) => {
  directory(t, [BLUE_SKY, BLUE_SKIES], [BLUE_SKY.shop, BLUE_SKIES.shop]);
  const checked: string[][] = [];
  const result = await findStore("blue sk", {
    customerOrdersAt: async (shops) => {
      checked.push(shops);
      return new Map([
        [BLUE_SKY.shop, false],
        [BLUE_SKIES.shop, true],
      ]);
    },
  });
  assert.deepEqual(checked, [[BLUE_SKY.shop, BLUE_SKIES.shop]]);
  assert.equal(result.status, "matched");
  assert.equal(result.selectionRequired, false);
  assert.deepEqual(result.merchants.map((merchant) => merchant.shop), [BLUE_SKIES.shop]);
  assert.equal(result.merchants[0].customerHasOrders, true);
});

test("orders at more than one candidate, or an order check that fails, leave the choice to the customer", async (t) => {
  directory(t, [BLUE_SKY, BLUE_SKIES], [BLUE_SKY.shop, BLUE_SKIES.shop]);
  const both = await findStore("blue sk", {
    customerOrdersAt: async (shops) => new Map(shops.map((shop) => [shop, true])),
  });
  assert.equal(both.status, "multiple_matches");
  assert.match(both.nextStep, /orders at more than one/);
  const failed = await findStore("blue sk", {
    customerOrdersAt: async () => {
      throw new Error("Shopify unavailable");
    },
  });
  assert.equal(failed.status, "multiple_matches");
  assert.equal(failed.merchants.length, 2);
});
