import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import { storeLinkEmailContext } from "./agent-access.server";
import {
  customerIdentityHash,
  digest,
  randomToken,
  seal,
  unseal,
} from "./customer-security.server";
import {
  completeEmailVerification,
  linkStore,
  maskEmail,
  normalizeEmail,
  numberChoices,
  verificationEmailContext,
} from "./email-verification.server";
import type { AdminGraphql } from "./shopify-admin.server";

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

function environment(t: TestContext, configured = true) {
  process.env.SHOPIFY_APP_URL = "https://refund.test";
  process.env.SHOPIFY_API_SECRET ||= "test-secret";
  const saved = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    REFUND_EMAIL_FROM: process.env.REFUND_EMAIL_FROM,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  if (configured) {
    process.env.RESEND_API_KEY = "re_test";
    process.env.REFUND_EMAIL_FROM = "Refund <returns@refund.test>";
  } else {
    delete process.env.RESEND_API_KEY;
    delete process.env.REFUND_EMAIL_FROM;
  }
}

type SentEmail = { to: string[]; subject: string; text: string; html: string };

function storeReady(t: TestContext, orderEmail: string | null) {
  mockDelegate(t, prisma.merchantDirectory, "findUnique", async () => ({
    shop,
    name: "Example & Co",
  }));
  mockDelegate(t, prisma.session, "findFirst", async () => ({
    id: "offline_store",
    scope: "read_orders",
  }));
  mockDelegate(t, prisma.agentStoreLink, "findUnique", async () => null);
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => ({
    verifiedStoreLinks: true,
    returnRulesConfirmedAt: new Date(),
    finalSaleCollectionIds: [],
  }));
  mockDelegate(t, prisma.agentConnection, "findUnique", async () => ({
    clientId: "client",
  }));
  mockDelegate(t, prisma.agentOAuthClient, "findUnique", async () => null);
  const counts = { value: 0 };
  mockDelegate(t, prisma.emailVerification, "count", async () => counts.value);
  const created: Array<Record<string, unknown>> = [];
  mockDelegate(
    t,
    prisma.emailVerification,
    "create",
    async ({ data }: { data: Record<string, unknown> }) => {
      created.push(data);
      return data;
    },
  );
  mockDelegate(t, prisma.agentStoreLinkRequest, "count", async () => 0);
  mockDelegate(t, prisma.agentStoreLinkRequest, "deleteMany", async () => ({
    count: 0,
  }));
  mockDelegate(t, prisma.agentStoreLinkRequest, "create", async () => ({}));
  const sent: SentEmail[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "email-1" });
    },
  );
  const lookups: Array<Record<string, unknown>> = [];
  const admin: AdminGraphql = {
    graphql: async (_query, options) => {
      lookups.push(options?.variables ?? {});
      return Response.json({
        data: {
          orders: {
            nodes: orderEmail
              ? [{ id: "gid://shopify/Order/1", email: orderEmail }]
              : [],
          },
        },
      });
    },
  };
  return { counts, created, sent, admin, lookups };
}

test("emails are normalized and masked, and the number to pick is among three choices", () => {
  assert.equal(normalizeEmail("  Pat@Example.COM "), "pat@example.com");
  for (const value of ["pat", "pat@", 'pat"@example.com', "pat @example.com"])
    assert.throws(() => normalizeEmail(value));
  assert.equal(maskEmail("pat@example.com"), "p••@example.com");
  const choices = numberChoices(42);
  assert.equal(choices.length, 3);
  assert.ok(choices.includes(42));
  assert.deepEqual(
    [...choices].sort((left, right) => left - right),
    choices,
  );
  assert.ok(choices.every((choice) => choice >= 10 && choice < 100));
});

test("an order email gets a one-tap confirmation, and the chat gets only the number to pick", async (t) => {
  environment(t);
  const { created, sent, admin, lookups } = storeReady(t, "Pat@Example.com");
  const result = await linkStore(connectionId, shop, "Pat@Example.com", Date.now(), admin);
  assert.equal(result.status, "email_sent");
  const { matchNumber, sentTo } = result as { matchNumber: number; sentTo: string };
  assert.deepEqual(lookups[0], { query: 'email:"pat@example.com"' });
  assert.equal(sentTo, "p••@example.com");
  assert.equal(created[0].status, "PENDING");
  assert.equal(created[0].matchNumber, matchNumber);
  assert.equal(created[0].emailHash, customerIdentityHash("email:pat@example.com"));
  assert.equal(
    unseal(
      created[0].sealedEmail as string,
      verificationEmailContext(created[0].id as string),
    ),
    "pat@example.com",
  );
  assert.deepEqual(sent[0].to, ["pat@example.com"]);
  assert.equal(sent[0].subject, "Confirm your return with Example & Co");
  assert.match(sent[0].text, /https:\/\/refund\.test\/verify\/email\/[\w-]{43}/);
  assert.match(sent[0].html, /Example &amp; Co/);
  assert.ok(!sent[0].text.includes(`number ${matchNumber}`));
  // The confirmation link stays in the inbox; the chat never sees it.
  assert.doesNotMatch(JSON.stringify(result), /verify\/email/);
});

test("an address with no order hears the same thing in chat and gets a gentle note instead", async (t) => {
  environment(t);
  const { created, sent, admin } = storeReady(t, null);
  const result = await linkStore(connectionId, shop, "someone@example.com", Date.now(), admin);
  assert.equal(result.status, "email_sent");
  assert.equal(created[0].status, "NO_ORDERS");
  assert.equal(sent[0].subject, "About your return with Example & Co");
  assert.doesNotMatch(sent[0].text, /verify\/email/);
});

test("sending stops after a few emails, and nothing is sent without an email address", async (t) => {
  environment(t);
  const { counts, created, sent, admin } = storeReady(t, "pat@example.com");
  counts.value = 3;
  const limited = await linkStore(connectionId, shop, "pat@example.com", Date.now(), admin);
  assert.equal(limited.status, "try_again_later");
  assert.equal(created.length, 0);
  assert.equal(sent.length, 0);

  counts.value = 0;
  const asked = await linkStore(connectionId, shop, undefined, Date.now(), admin);
  assert.equal(asked.status, "email_needed");
  assert.match(
    (asked as { signedInShortcutUrl: string }).signedInShortcutUrl,
    /^https:\/\/refund\.test\/connect\/stores\/link\/[\w-]{43}$/,
  );
  assert.equal(sent.length, 0);
});

test("without email sending, link_store falls back to the Shopify link", async (t) => {
  environment(t, false);
  const { sent, admin } = storeReady(t, "pat@example.com");
  const result = await linkStore(connectionId, shop, "pat@example.com", Date.now(), admin);
  assert.equal(result.status, "sign_in_required");
  assert.equal(sent.length, 0);
});

test("the confirmation page connects the store only when the customer picks the chat's number", async (t) => {
  environment(t);
  const raw = randomToken();
  const id = digest(raw);
  const row = {
    id,
    connectionId,
    shop,
    sealedEmail: seal("pat@example.com", verificationEmailContext(id)),
    emailHash: customerIdentityHash("email:pat@example.com"),
    matchNumber: 42,
    csrfToken: "csrf-token",
    status: "PENDING",
    expiresAt: new Date(Date.now() + 600_000),
    createdAt: new Date(),
    connection: {
      clientId: "client",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  };
  mockDelegate(t, prisma.emailVerification, "findUnique", async () => row);
  const claims: Array<{ data: { status: string } }> = [];
  mockDelegate(t, prisma.emailVerification, "updateMany", async (args: never) => {
    claims.push(args);
    return { count: 1 };
  });
  const upserts: Array<{ create: Record<string, unknown> }> = [];
  mockDelegate(t, prisma.agentStoreLink, "upsert", async (args: never) => {
    upserts.push(args);
    return {};
  });
  mockDelegate(t, prisma, "$transaction", async (run: never) =>
    (run as unknown as (tx: typeof prisma) => Promise<unknown>)(prisma),
  );
  const post = (choice: string, csrf = "csrf-token") =>
    new Request(`https://refund.test/verify/email/${raw}`, {
      method: "POST",
      headers: {
        Origin: "https://refund.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf, choice }),
    });

  await assert.rejects(
    completeEmailVerification(post("42", "wrong"), raw),
    (error) => error instanceof Response && error.status === 403,
  );
  assert.deepEqual(await completeEmailVerification(post("17"), raw), {
    outcome: "mismatch",
    shop,
  });
  assert.equal(claims[0].data.status, "CANCELLED");
  assert.equal(upserts.length, 0);

  assert.deepEqual(await completeEmailVerification(post("42"), raw), {
    outcome: "linked",
    shop,
  });
  assert.equal(claims[1].data.status, "VERIFIED");
  const link = upserts[0].create;
  assert.equal(link.verifiedBy, "EMAIL");
  assert.equal(link.customerSubjectHash, row.emailHash);
  assert.equal(link.sealedCustomerId, null);
  assert.equal(
    unseal(link.sealedEmail as string, storeLinkEmailContext(connectionId, shop)),
    "pat@example.com",
  );
});
