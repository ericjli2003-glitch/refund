import assert from "node:assert/strict";
import test from "node:test";
import {
  discoveryFailureSchema,
  opportunityLabel,
  recordMerchantOpportunity,
} from "./merchant-opportunity.server";
import prisma from "../db.server";

test("opportunity ingestion stores only bounded business labels or URL hosts", () => {
  assert.equal(
    opportunityLabel("  Testing   Storefront  "),
    "Testing Storefront",
  );
  assert.equal(
    opportunityLabel("https://EXAMPLE.com/orders/secret?email=private#token"),
    "example.com",
  );
  assert.equal(opportunityLabel("Café & Co"), "Café & Co");
  for (const input of [
    "person@example.com",
    "https://user:password@example.com",
    "Testing\nsecret",
    "Store\u202Ehidden",
    "http://example.com",
    "https://127.0.0.1",
    "x".repeat(121),
    "",
    "1234567890",
    "store?email=secret",
  ])
    assert.equal(opportunityLabel(input), null, input);
  assert.equal(
    discoveryFailureSchema.safeParse({
      merchant: "Testing",
      email: "customer@example.com",
    }).success,
    false,
  );
  assert.equal(
    discoveryFailureSchema.safeParse({
      merchant: "Testing",
      itemName: "snowboard",
    }).success,
    false,
  );
  assert.equal(
    discoveryFailureSchema.safeParse({
      merchant: "Testing",
      knownShop: "fake.myshopify.com",
    }).success,
    false,
  );
});

test("opportunity reports have a bounded write budget without retaining visitor identities", async (t) => {
  const replace = (
    target: object,
    name: string,
    fn: (...args: never[]) => unknown,
  ) => {
    const original = Reflect.get(target, name);
    const mock = t.mock.fn(fn);
    Reflect.set(target, name, mock);
    t.after(() => Reflect.set(target, name, original));
    return mock;
  };
  replace(prisma.merchantDirectory, "findMany", async () => []);
  replace(prisma.merchantOpportunity, "deleteMany", async () => ({ count: 0 }));
  const saved = replace(prisma.merchantOpportunity, "upsert", async () => ({}));
  const now = new Date(Date.now() + 120_000);
  for (let i = 0; i < 30; i++)
    await recordMerchantOpportunity(
      "Budget test store",
      "discovery_report",
      now,
    );
  await assert.rejects(
    recordMerchantOpportunity("Budget test store", "discovery_report", now),
    (error: unknown) => error instanceof Response && error.status === 429,
  );
  assert.equal(saved.mock.callCount(), 30);
  await recordMerchantOpportunity(
    "Budget test store",
    "discovery_report",
    new Date(now.getTime() + 60_000),
  );
  assert.equal(saved.mock.callCount(), 31);
});
