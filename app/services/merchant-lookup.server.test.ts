import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import { findStore } from "./merchant-lookup.server";

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

function directory(t: TestContext, profiles: Profile[], installed: string[]) {
  const searches: unknown[] = [];
  const opportunities: unknown[] = [];
  mockDelegate(t, prisma.merchantDirectory, "findMany", async (args: never) => {
    searches.push(args);
    return profiles;
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
