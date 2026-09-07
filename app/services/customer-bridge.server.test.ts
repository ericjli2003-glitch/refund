import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import {
  digest,
  randomToken,
  seal,
  signQuote,
  unseal,
  verifyPortalPost,
} from "./customer-security.server";
import {
  assertConfirmedAmount,
  executeAutomaticReturn,
} from "./automatic-return.server";
import {
  confirmInputSchema,
  createReturnQuote,
  readBoundQuote,
  returnItemsSchema,
  submitReturnQuote,
} from "./return-quote.server";
import {
  finishCustomerLogin,
  getCustomerSession,
  startCustomerLogin,
} from "./customer-session.server";

process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_API_KEY ||= "test-key";
// Production requires HTTPS even when the surrounding CI job uses localhost.
process.env.SHOPIFY_APP_URL = "https://refund.test";

// Prisma delegates are proxies without method descriptors; mock their callable
// properties directly and restore them after each test.
function mockDelegate(
  t: TestContext,
  target: object,
  name: string,
  implementation: (...args: never[]) => unknown,
) {
  const original = Reflect.get(target, name);
  const mock = t.mock.fn(implementation);
  Reflect.set(target, name, mock);
  t.after(() => {
    Reflect.set(target, name, original);
  });
  return mock;
}

test("customer tokens are encrypted and bound to their store and session", () => {
  const token = "private-customer-token";
  const value = seal(token, "session:shop");
  assert.ok(!value.includes(token));
  assert.notEqual(value, seal(token, "session:shop"));
  assert.equal(unseal(value, "session:shop"), token);
  assert.throws(() => unseal(value, "session:other-shop"));
  const parts = value.split(".");
  parts[1] = randomToken();
  assert.throws(() => unseal(parts.join("."), "session:shop"));
});

test("portal writes require same-origin POST, JSON, and the session CSRF token", () => {
  const origin = new URL(process.env.SHOPIFY_APP_URL!).origin;
  const request = (headers: Record<string, string>, method = "POST") =>
    new Request(`${origin}/returns/example.myshopify.com`, { method, headers });
  const valid = {
    Origin: origin,
    "X-Return-CSRF": "session-csrf",
    "Content-Type": "application/json",
  };
  assert.doesNotThrow(() => verifyPortalPost(request(valid), "session-csrf"));
  for (const headers of [
    { ...valid, Origin: "https://evil.test" },
    { ...valid, "X-Return-CSRF": "wrong" },
    { ...valid, "Content-Type": "text/plain" },
  ]) {
    assert.throws(() => verifyPortalPost(request(headers), "session-csrf"));
  }
  assert.throws(() => verifyPortalPost(request(valid, "GET"), "session-csrf"));
});

test("signed quotes reject tampering, expiration, and another customer or store", () => {
  const quote = {
    version: 1,
    id: randomUUID(),
    shop: "example.myshopify.com",
    subject: "customer-a",
    orderId: "gid://shopify/Order/1",
    items: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 1 }],
    expectedRefund: { amount: "14.00", currencyCode: "CAD" },
    expiresAt: Date.now() + 60_000,
  };
  const signed = signQuote(quote);
  assert.equal(readBoundQuote(signed, quote.shop, quote.subject).id, quote.id);
  assert.throws(() =>
    readBoundQuote(signed, "other.myshopify.com", quote.subject),
  );
  assert.throws(() => readBoundQuote(signed, quote.shop, "customer-b"));
  assert.throws(() =>
    readBoundQuote(signed, quote.shop, quote.subject, quote.expiresAt),
  );
  const [body, signature] = signed.split(".");
  const changed = JSON.parse(Buffer.from(body, "base64url").toString());
  changed.expectedRefund.amount = "100.00";
  assert.throws(() =>
    readBoundQuote(
      `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`,
      quote.shop,
      quote.subject,
    ),
  );
});

test("confirmation cannot omit affirmative consent or use unsafe quantities", async () => {
  assert.equal(
    confirmInputSchema.safeParse({ quoteToken: "anything" }).success,
    false,
  );
  assert.equal(
    confirmInputSchema.safeParse({
      quoteToken: "anything",
      customerConfirmed: false,
    }).success,
    false,
  );
  await assert.rejects(
    submitReturnQuote("example.myshopify.com", "unused", {
      quoteToken: "anything",
      customerConfirmed: false,
    }),
  );
  const item = { lineItemId: "gid://shopify/LineItem/1", quantity: 1 };
  for (const items of [
    [],
    [item, item],
    [{ ...item, quantity: 0 }],
    [{ ...item, quantity: 1.5 }],
  ]) {
    assert.equal(returnItemsSchema.safeParse(items).success, false);
  }
});

test("the refund guard requires the confirmed amount and currency", () => {
  const amount = { amount: "14.00", currencyCode: "CAD" };
  assert.doesNotThrow(() =>
    assertConfirmedAmount(amount, { ...amount, amount: "14" }),
  );
  for (const actual of [
    { ...amount, amount: "15" },
    { ...amount, currencyCode: "USD" },
    { ...amount, amount: "NaN" },
    { ...amount, amount: "0" },
  ]) {
    assert.throws(() => assertConfirmedAmount(actual, amount));
  }
});

test("OAuth uses PKCE and opaque cookies; wrong-state, cross-shop and replayed callbacks fail", async (t) => {
  const records = new Map<string, Record<string, unknown>>();
  mockDelegate(t, prisma.session, "findFirst", async () => ({
    id: "offline_example",
  }));
  mockDelegate(
    t,
    prisma.customerReturnSession,
    "findUnique",
    async ({ where }: { where: { id: string } }) =>
      records.get(where.id) || null,
  );
  mockDelegate(t, prisma.customerReturnSession, "deleteMany", async () => ({
    count: 0,
  }));
  mockDelegate(
    t,
    prisma.customerReturnSession,
    "create",
    async ({ data }: { data: Record<string, unknown> }) => {
      records.set(data.id as string, data);
      return data;
    },
  );
  mockDelegate(
    t,
    prisma.customerReturnSession,
    "updateMany",
    async ({ where }: { where: { id: string; stateHash: string } }) => {
      const old = records.get(where.id);
      if (!old || old.stateHash !== where.stateHash) return { count: 0 };
      records.set(where.id, { ...old, stateHash: null, sealedState: null });
      return { count: 1 };
    },
  );
  mockDelegate(t, prisma, "$transaction", async (ops: Promise<unknown>[]) =>
    Promise.all(ops),
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      issuer: "https://shopify.com/authentication/1",
      authorization_endpoint:
        "https://shopify.com/authentication/1/oauth/authorize",
      token_endpoint: "https://shopify.com/authentication/1/oauth/token",
      jwks_uri: "https://shopify.com/authentication/1/.well-known/jwks.json",
    }),
  );
  const started = await startCustomerLogin(
    new Request(
      "https://refund.test/customer/login?shop=example.myshopify.com&orderName=%231001",
    ),
  );
  const auth = new URL(started.headers.get("Location")!);
  const setCookie = started.headers.get("Set-Cookie")!;
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.ok(auth.searchParams.get("nonce"));
  const pending = [...records.values()][0];
  const state = JSON.parse(
    unseal(
      pending.sealedState as string,
      `${pending.id}:example.myshopify.com`,
    ),
  );
  assert.equal(auth.searchParams.get("code_challenge"), digest(state.verifier));
  assert.ok(!setCookie.includes(state.verifier));
  const request = (search: string) =>
    new Request(`https://refund.test/customer/callback?${search}`, {
      headers: { Cookie: setCookie.split(";")[0] },
    });
  await assert.rejects(
    finishCustomerLogin(request("state=wrong&code=unused")),
    (error: unknown) => error instanceof Response && error.status === 400,
  );
  assert.equal(
    await getCustomerSession(request(""), "other.myshopify.com"),
    null,
  );
  const cancelled = `state=${auth.searchParams.get("state")}&error=access_denied`;
  assert.equal((await finishCustomerLogin(request(cancelled))).status, 302);
  await assert.rejects(
    finishCustomerLogin(request(cancelled)),
    (error: unknown) => error instanceof Response && error.status === 400,
  );
});

test("changed quote stops before any return record or Shopify mutation", async (t) => {
  const shop = "guard-test.myshopify.com";
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => ({
    automaticRefundsEnabled: true,
    returnWindowDays: 30,
    currencyCode: "CAD",
    maxAutoRefundAmount: "100.00",
  }));
  mockDelegate(t, prisma.agentReturn, "findUnique", async () => null);
  const write = mockDelegate(t, prisma.agentReturn, "create", async () => {
    throw new Error("Must not write");
  });
  const requests: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      if (!init?.body)
        return Response.json({
          graphql_api: "https://shopify.com/1/customer/api/2026-07/graphql",
        });
      const body = JSON.parse(String(init.body));
      requests.push(body.query);
      if (body.query.includes("CustomerReturnableOrders"))
        return Response.json({
          data: {
            customer: {
              id: "gid://shopify/Customer/1",
              orders: {
                nodes: [
                  {
                    id: "gid://shopify/Order/1",
                    name: "#1001",
                    processedAt: new Date().toISOString(),
                    returnInformation: {
                      returnableLineItems: {
                        nodes: [
                          {
                            lineItem: { id: "gid://shopify/LineItem/1" },
                            quantity: 1,
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        });
      if (body.query.includes("CalculateCustomerReturn"))
        return Response.json({
          data: {
            returnCalculate: {
              financialSummary: {
                returnTotalSet: {
                  presentmentMoney: { amount: "15.00", currencyCode: "CAD" },
                },
              },
            },
          },
        });
      throw new Error("Unexpected request");
    },
  );
  await assert.rejects(
    executeAutomaticReturn({
      shop,
      customerToken: "test-token",
      orderId: "gid://shopify/Order/1",
      items: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 1 }],
      idempotencyKey: randomUUID(),
      expectedRefund: { amount: "14.00", currencyCode: "CAD" },
    }),
    /amount changed/,
  );
  assert.equal(write.mock.callCount(), 0);
  assert.ok(requests.every((query) => !query.includes("mutation")));
});

test("quotes use Shopify shop money for policy limits without changing customer currency", async (t) => {
  const shop = "currency-test.myshopify.com";
  let limit = "100.00";
  let calculatedAmount = "14.00";
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => ({
    automaticRefundsEnabled: true,
    returnWindowDays: 30,
    currencyCode: "USD",
    maxAutoRefundAmount: limit,
  }));
  const input = {
    orderId: "gid://shopify/Order/1",
    items: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 1 }],
  };
  const writes = mockDelegate(t, prisma.agentReturn, "create", async () => {
    throw new Error("Quoting must not write a return");
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      if (!init?.body)
        return Response.json({
          graphql_api: "https://shopify.com/1/customer/api/2026-07/graphql",
        });
      const { query } = JSON.parse(String(init.body));
      assert.ok(!query.includes("mutation"));
      if (query.includes("CustomerReturnableOrders"))
        return Response.json({
          data: {
            customer: {
              id: "gid://shopify/Customer/1",
              orders: {
                nodes: [
                  {
                    id: input.orderId,
                    name: "#1001",
                    processedAt: new Date().toISOString(),
                    returnInformation: {
                      returnableLineItems: {
                        nodes: [
                          {
                            lineItem: {
                              id: input.items[0].lineItemId,
                              presentmentTitle: "Test product",
                            },
                            quantity: 1,
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        });
      return Response.json({
        data: {
          returnCalculate: {
            financialSummary: {
              returnTotalSet: {
                presentmentMoney: {
                  amount: calculatedAmount,
                  currencyCode: "CAD",
                },
                shopMoney: { amount: "10.00", currencyCode: "USD" },
              },
            },
          },
        },
      });
    },
  );
  const quote = await createReturnQuote(shop, "test-token", input);
  assert.deepEqual(quote.expectedRefund, {
    amount: "14.00",
    currencyCode: "CAD",
  });
  limit = "9.00";
  await assert.rejects(
    createReturnQuote(shop, "test-token", input),
    /outside.*limit/,
  );
  limit = "100.00";
  for (const amount of ["0.00", "-14.00"]) {
    calculatedAmount = amount;
    await assert.rejects(
      createReturnQuote(shop, "test-token", input),
      /not a positive refund/,
    );
  }
  calculatedAmount = "invalid";
  await assert.rejects(
    createReturnQuote(shop, "test-token", input),
    /not return a valid refund amount/,
  );
  assert.equal(writes.mock.callCount(), 0);
});
