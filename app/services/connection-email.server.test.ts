import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import {
  connectionEmailContext,
  linkStoreByConnectionEmail,
  listConnectionEmails,
  removeConnectionEmail,
  storeLinkEmailContext,
} from "./connection-email.server";
import {
  customerIdentityHash,
  refundSecrets,
  seal,
  unseal,
  unsealWithRotation,
} from "./customer-security.server";

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

const row = (email: string, id: string) => ({
  id,
  connectionId,
  sealedEmail: seal(email, connectionEmailContext(connectionId)),
  emailHash: customerIdentityHash(`email:${email}`),
  source: "ONBOARDING",
  sourceShop: null,
  confirmedAt: new Date(),
});

type Upsert = {
  where: { connectionId_shop: { shop: string } };
  create: Record<string, unknown>;
};

function setup(t: TestContext, rows: () => Array<ReturnType<typeof row>>) {
  process.env.SHOPIFY_API_SECRET ||= "test-secret";
  mockDelegate(t, prisma.connectionEmail, "findMany", async () => rows());
  const links: Upsert[] = [];
  mockDelegate(t, prisma.agentStoreLink, "upsert", async (args: never) => {
    const value = args as unknown as Upsert;
    links.push(value);
    return { id: `link-${value.where.connectionId_shop.shop}`, ...value.create, session: null };
  });
  return links;
}

test("one confirmed email connects every store that has orders under it", async (t) => {
  const links = setup(t, () => [
    row("pat@example.com", "email-1"),
    row("old@example.com", "email-2"),
  ]);
  const orders: Record<string, string[]> = {
    "a.myshopify.com": ["pat@example.com"],
    "b.myshopify.com": ["pat@example.com"],
    "c.myshopify.com": ["someone@example.com"],
  };
  const lookup = async (shop: string, email: string) => (orders[shop] ?? []).includes(email);
  for (const shop of ["a.myshopify.com", "b.myshopify.com"])
    assert.equal((await linkStoreByConnectionEmail(connectionId, shop, lookup)).status, "linked");
  assert.deepEqual(
    links.map((link) => [
      link.where.connectionId_shop.shop,
      link.create.connectionEmailId,
      link.create.verifiedBy,
    ]),
    [
      ["a.myshopify.com", "email-1", "EMAIL"],
      ["b.myshopify.com", "email-1", "EMAIL"],
    ],
  );
  assert.equal(
    unseal(links[0].create.sealedEmail as string, storeLinkEmailContext(connectionId, "a.myshopify.com")),
    "pat@example.com",
  );
  // No confirmed email has an order there: the assistant asks about another.
  assert.deepEqual(
    await linkStoreByConnectionEmail(connectionId, "c.myshopify.com", lookup),
    { status: "no_match" },
  );
  // Without Shopify's email access the store falls back to Shopify sign-in.
  assert.deepEqual(
    await linkStoreByConnectionEmail(connectionId, "c.myshopify.com", async () => {
      throw new Error("Level 2 access required");
    }),
    { status: "lookup_unavailable" },
  );
  assert.deepEqual(
    await linkStoreByConnectionEmail(connectionId, "a.myshopify.com", lookup, Date.now(), "new@example.com"),
    { status: "no_emails" },
  );
  assert.equal(links.length, 2);
});

test("a connection with no confirmed emails looks nothing up", async (t) => {
  setup(t, () => []);
  let lookups = 0;
  assert.deepEqual(
    await linkStoreByConnectionEmail(connectionId, "a.myshopify.com", async () => {
      lookups++;
      return true;
    }),
    { status: "no_emails" },
  );
  assert.equal(lookups, 0);
});

test("customers can see and remove confirmed emails, which move to the current secret", async (t) => {
  const original = {
    REFUND_SECRET: process.env.REFUND_SECRET,
    REFUND_PREVIOUS_SECRETS: process.env.REFUND_PREVIOUS_SECRETS,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(original))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const retired = row("pat@example.com", "email-1");
  process.env.REFUND_PREVIOUS_SECRETS = refundSecrets()[0];
  process.env.REFUND_SECRET = "rotated-refund-secret";
  const current = row("second@example.com", "email-2");
  setup(t, () => [current, retired]);
  const updates: Array<{ data: { sealedEmail: string } }> = [];
  mockDelegate(t, prisma.connectionEmail, "updateMany", async (args: never) => {
    updates.push(args);
    return { count: 1 };
  });
  assert.deepEqual(
    (await listConnectionEmails(connectionId)).map((entry) => entry.email),
    ["second@example.com", "pat@example.com"],
  );
  assert.equal(updates.length, 1);
  assert.deepEqual(
    unsealWithRotation(updates[0].data.sealedEmail, connectionEmailContext(connectionId)),
    { value: "pat@example.com", current: true },
  );

  const removed = mockDelegate(t, prisma.connectionEmail, "deleteMany", async () => ({
    count: 1,
  }));
  assert.deepEqual(await removeConnectionEmail(connectionId, "email-1"), { removed: true });
  assert.deepEqual(removed.mock.calls[0].arguments[0], {
    where: { id: "email-1", connectionId },
  });
});
