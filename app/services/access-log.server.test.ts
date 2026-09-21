import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import prisma from "../db.server";
import {
  ACCESS_LOG_RETENTION_DAYS,
  accessLogExpiry,
  accessSubjectHash,
  pruneAccessLog,
  recordAccess,
  redactAccessSubjects,
} from "./access-log.server";
import { customerIdentityHash } from "./customer-security.server";

const replaceOn = (
  t: TestContext,
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

const withSecret = (t: TestContext) => {
  const original = process.env.REFUND_SECRET;
  process.env.REFUND_SECRET = "test-secret-for-access-log";
  t.after(() => {
    if (original === undefined) delete process.env.REFUND_SECRET;
    else process.env.REFUND_SECRET = original;
  });
};

test("a subject is stored as the same keyed hash used everywhere else", (t) => {
  withSecret(t);
  const customer = "gid://shopify/Customer/12345";
  assert.equal(accessSubjectHash(customer), customerIdentityHash(customer));
  // Matching hashes is what lets a redaction request reach these rows.
  assert.notEqual(accessSubjectHash(customer), customer);
});

test("a missing subject is recorded as no subject rather than an empty hash", (t) => {
  withSecret(t);
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(accessSubjectHash(value), null);
  }
});

test("an access is still recorded when the identity cannot be hashed", async (t) => {
  const secret = process.env.REFUND_SECRET;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  delete process.env.REFUND_SECRET;
  delete process.env.SHOPIFY_API_SECRET;
  t.after(() => {
    if (secret !== undefined) process.env.REFUND_SECRET = secret;
    if (apiSecret !== undefined) process.env.SHOPIFY_API_SECRET = apiSecret;
  });

  const created = replaceOn(t, prisma.personalDataAccess, "create", async () => ({}));
  await recordAccess({
    shop: "shop.myshopify.com",
    actor: "CUSTOMER",
    source: "PORTAL",
    action: "READ_CUSTOMER_ORDERS",
    subject: "gid://shopify/Customer/1",
  });

  assert.equal(created.mock.callCount(), 1);
  const [call] = created.mock.calls;
  const { data } = call.arguments[0] as { data: Record<string, unknown> };
  assert.equal(data.customerSubjectHash, null);
  assert.equal(data.action, "READ_CUSTOMER_ORDERS");
});

test("a pre-hashed subject is stored as given", async (t) => {
  const created = replaceOn(t, prisma.personalDataAccess, "create", async () => ({}));
  await recordAccess({
    shop: "shop.myshopify.com",
    actor: "MERCHANT",
    source: "ADMIN",
    action: "EXPORT_PRIVACY_REQUEST",
    subjectHash: "already-hashed",
    resource: "request-1",
    recordCount: 1,
  });

  const { data } = created.mock.calls[0].arguments[0] as {
    data: Record<string, unknown>;
  };
  assert.equal(data.customerSubjectHash, "already-hashed");
  assert.equal(data.resource, "request-1");
  assert.equal(data.recordCount, 1);
  assert.equal(data.actor, "MERCHANT");
  assert.equal(data.source, "ADMIN");
});

test("a failed write never breaks the request it was logging", async (t) => {
  replaceOn(t, prisma.personalDataAccess, "create", async () => {
    throw new Error("database unavailable");
  });
  const errors = replaceOn(t, console, "error", () => {});

  await assert.doesNotReject(
    recordAccess({
      shop: "shop.myshopify.com",
      actor: "CUSTOMER",
      source: "ASSISTANT",
      action: "READ_CUSTOMER_ORDERS",
    }),
  );
  // The gap is at least visible in the server log.
  assert.equal(errors.mock.callCount(), 1);
});

test("redaction clears the identifier and keeps the row", async (t) => {
  const updated = replaceOn(
    t,
    prisma.personalDataAccess,
    "updateMany",
    async () => ({ count: 3 }),
  );

  assert.equal(await redactAccessSubjects(["hash-a", "hash-b"]), 3);
  const argument = updated.mock.calls[0].arguments[0] as {
    where: { customerSubjectHash: { in: string[] } };
    data: Record<string, unknown>;
  };
  assert.deepEqual(argument.where.customerSubjectHash.in, ["hash-a", "hash-b"]);
  assert.deepEqual(argument.data, { customerSubjectHash: null });
  // Nothing is deleted, so the timeline of access survives the redaction.
  assert.equal("deleteMany" in argument, false);
});

test("redaction with no identities touches nothing", async (t) => {
  const updated = replaceOn(
    t,
    prisma.personalDataAccess,
    "updateMany",
    async () => ({ count: 0 }),
  );
  assert.equal(await redactAccessSubjects([]), 0);
  assert.equal(updated.mock.callCount(), 0);
});

test("entries expire a year after they are written", () => {
  assert.equal(ACCESS_LOG_RETENTION_DAYS, 365);
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(
    accessLogExpiry(now).toISOString(),
    "2027-01-01T00:00:00.000Z",
  );
});

test("the sweep removes only entries past their expiry", async (t) => {
  const deleted = replaceOn(
    t,
    prisma.personalDataAccess,
    "deleteMany",
    async () => ({ count: 7 }),
  );
  const now = new Date("2026-06-01T00:00:00.000Z");

  assert.equal(await pruneAccessLog(now), 7);
  assert.deepEqual(deleted.mock.calls[0].arguments[0], {
    where: { expiresAt: { lte: now } },
  });
});
