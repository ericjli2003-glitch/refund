import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import { startStoreLink } from "./store-link.server";

const shop = "example.myshopify.com";
const connectionId = "0d9b7c1e-5a4f-4e2b-8c3d-1f6a7b8c9d0e";

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

test("one connection can hold only a few unfinished store links at a time", async (t) => {
  process.env.SHOPIFY_APP_URL = "https://refund.test";
  process.env.SHOPIFY_API_SECRET ||= "test-secret";
  mockDelegate(t, prisma.merchantDirectory, "findUnique", async () => ({
    shop,
    name: "Example",
  }));
  mockDelegate(t, prisma.session, "findFirst", async () => ({
    id: "offline_store",
    scope: "read_orders",
  }));
  mockDelegate(t, prisma.agentStoreLink, "findUnique", async () => null);
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => null);
  let pending = 10;
  const count = mockDelegate(
    t,
    prisma.agentStoreLinkRequest,
    "count",
    async () => pending,
  );
  mockDelegate(t, prisma.agentStoreLinkRequest, "deleteMany", async () => ({
    count: 0,
  }));
  const create = mockDelegate(
    t,
    prisma.agentStoreLinkRequest,
    "create",
    async () => ({}),
  );
  const now = Date.now();

  const refused = await startStoreLink(connectionId, shop, now);
  assert.equal(refused.status, "too_many_link_requests");
  assert.equal(refused.linkUrl, null);
  assert.equal(create.mock.callCount(), 0);
  assert.deepEqual(count.mock.calls[0].arguments[0], {
    where: { connectionId, status: "PENDING", expiresAt: { gt: new Date(now) } },
  });

  pending = 9;
  const started = await startStoreLink(connectionId, shop, now);
  assert.equal(started.status, "sign_in_required");
  assert.match(
    started.linkUrl!,
    /^https:\/\/refund\.test\/connect\/stores\/link\/[\w-]{43}$/,
  );
  assert.equal(create.mock.callCount(), 1);
});
