import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import prisma from "../db.server";
import { createIntakeMcpServer } from "../intake-mcp.server";
import {
  merchantHost,
  resolveMerchant,
  syncMerchantDirectory,
} from "./merchant-directory.server";
import {
  intakeSchema,
  makeContinuation,
  readContinuation,
  returnHints,
  startReturnIntake,
} from "./return-intake.server";
import { readIntakeBody } from "./public-intake-http.server";
import { action as publicMcpAction } from "../routes/mcp.public";
import { action as intakeAction } from "../routes/api.return-intake";
import { loader as startPage } from "../routes/start-return";
import { startCustomerLogin } from "./customer-session.server";

const shop = "testing-bl7vdfur.myshopify.com";
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
function installedStore(t: TestContext) {
  mockDelegate(t, prisma.merchantDirectory, "findMany", async () => []);
  mockDelegate(t, prisma.merchantOpportunity, "deleteMany", async () => ({ count: 0 }));
  mockDelegate(t, prisma.merchantOpportunity, "upsert", async () => ({}));
  const drafts = new Map<string, Record<string, unknown>>();
  mockDelegate(t, prisma.returnDraft, "deleteMany", async () => ({ count: 0 }));
  mockDelegate(t, prisma.returnDraft, "upsert", async ({ where, create }: { where: { intakeKeyHash: string }; create: Record<string, unknown> }) => {
    if (!drafts.has(where.intakeKeyHash)) drafts.set(where.intakeKeyHash, create);
    return drafts.get(where.intakeKeyHash);
  });
  mockDelegate(t, prisma.merchantDirectory, "findUnique", async () => null);
  mockDelegate(
    t,
    prisma.session,
    "findFirst",
    async ({ where }: { where: { shop: string; isOnline: boolean } }) => {
      assert.equal(where.isOnline, false);
      return where.shop === shop ? { id: `offline_${shop}` } : null;
    },
  );
}

test("merchant resolution rejects unsafe addresses and never fetches arbitrary hosts", async (t) => {
  installedStore(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request");
  });
  for (const input of [
    "localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "http://store.example.com",
    "https://user@store.example.com",
    "https://store.example.com:8443",
    "store\\evil.com",
    "Store name",
  ]) {
    assert.throws(() => merchantHost(input), Error, input);
  }
  assert.equal(
    merchantHost("https://STORE.example.com/products/snowboard?x=1"),
    "store.example.com",
  );
  assert.equal(await resolveMerchant("unknown.example.com"), null);
  assert.equal(await resolveMerchant("absent.myshopify.com"), null);
  assert.equal((await resolveMerchant(shop))?.shop, shop);
  assert.equal(fetch.mock.callCount(), 0);
});

test("directory updates require Shopify's canonical shop to match the installation", async (t) => {
  const saved = mockDelegate(
    t,
    prisma.merchantDirectory,
    "upsert",
    async ({ create }: { create: unknown }) => create,
  );
  const admin = {
    graphql: async () =>
      Response.json({
        data: {
          shop: {
            myshopifyDomain: shop,
            name: "Testing",
            primaryDomain: { host: "store.example.com" },
          },
        },
      }),
  };
  const result = await syncMerchantDirectory(
    shop,
    admin as Parameters<typeof syncMerchantDirectory>[1],
  );
  assert.equal(result.primaryDomain, "store.example.com");
  await assert.rejects(
    syncMerchantDirectory(
      "other.myshopify.com",
      admin as Parameters<typeof syncMerchantDirectory>[1],
    ),
    /verify/,
  );
  assert.equal(saved.mock.callCount(), 1);
});

test("continuation is encrypted, expiring and store-bound, and never acts as a quote", () => {
  const now = Date.now();
  const token = makeContinuation(
    shop,
    { orderName: "#1001", itemName: "Snowboard" },
    now,
  );
  assert.ok(!token.includes("Snowboard"));
  assert.equal(readContinuation(token, shop, now).itemName, "Snowboard");
  for (const read of [
    () => readContinuation(token, "other.myshopify.com", now),
    () => readContinuation(token, shop, now + 1800_000),
    () => readContinuation(`${token.slice(0, -10)}tampered`, shop, now),
    () => readContinuation("x".repeat(4097), shop, now),
  ])
    assert.throws(
      read,
      (error: unknown) => error instanceof Response && error.status === 400,
    );
  const url = new URL(
    `https://refund.test/customer/login?continuation=${encodeURIComponent(token)}&orderName=changed`,
  );
  assert.equal(returnHints(url, shop).orderName, "#1001");
  assert.equal(
    intakeSchema.safeParse({ merchant: shop, customerConfirmed: true }).success,
    false,
  );
});

test("anonymous intake issues a link without reading customers or creating returns", async (t) => {
  installedStore(t);
  const writes = mockDelegate(t, prisma.agentReturn, "create", async () => {
    throw new Error("Must not submit");
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Must not read purchases");
  });
  const result = await startReturnIntake({
    merchant: shop,
    orderName: "#1001",
    itemName: "Snowboard",
  });
  assert.equal(result.status, "verification_required");
  assert.ok("continueUrl" in result);
  const url = new URL(result.continueUrl);
  assert.equal(url.origin, "https://refund.test");
  assert.equal(url.pathname, `/returns/${shop}`);
  assert.equal(result.returnSubmitted, false);
  assert.equal(result.refundSubmitted, false);
  assert.equal(
    readContinuation(url.searchParams.get("continuation")!, shop).orderName,
    "#1001",
  );
  assert.equal(readContinuation(url.searchParams.get("continuation")!, shop).draftId, result.correlationId);
  const stopped = await startReturnIntake({ merchant: "absent.myshopify.com" });
  assert.equal(stopped.status, "merchant_not_resolved");
  assert.equal("continueUrl" in stopped, false);
  assert.equal(stopped.returnSubmitted, false);
  assert.equal(stopped.refundSubmitted, false);
  assert.match(stopped.nextStep, /Stop here/);
  assert.doesNotMatch(JSON.stringify(stopped), /opportunit|UNREVIEWED|merchantLabel/i);
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test("public MCP lists and executes only anonymous intake, never a refund tool", async (t) => {
  installedStore(t);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createIntakeMcpServer();
  const client = new Client({ name: "intake-test", version: "1" });
  await server.connect(b);
  await client.connect(a);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["find_store", "start_return"],
    );
    for (const tool of tools)
      assert.deepEqual(tool._meta?.securitySchemes, [{ type: "noauth" }]);
    const result = await client.callTool({
      name: "start_return",
      arguments: { merchant: shop, orderName: "#1001" },
    });
    assert.equal(
      (result.structuredContent as { status: string }).status,
      "verification_required",
    );
    const rejected = await client.callTool({
      name: "confirm_return",
      arguments: { customerConfirmed: true },
    });
    assert.equal(rejected.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("public HTTP surfaces enforce JSON limits and return working MCP JSON responses", async (t) => {
  installedStore(t);
  const request = (
    body: unknown,
    headers: Record<string, string> = { "Content-Type": "application/json" },
  ) =>
    new Request("https://refund.test/api/return-intake", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  await assert.rejects(
    readIntakeBody(request({}, { "Content-Type": "text/plain" })),
    (e: unknown) => e instanceof Response && e.status === 415,
  );
  await assert.rejects(
    readIntakeBody(request({ x: "x".repeat(17_000) })),
    (e: unknown) => e instanceof Response && e.status === 413,
  );
  const args = (r: Request) => ({
    request: r,
    params: {},
    context: {},
    url: new URL(r.url),
    pattern: "/api/return-intake",
  });
  const response = await intakeAction(args(request({ merchant: shop })));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store, private");
  assert.equal((await response.json()).status, "verification_required");
  assert.equal(
    (
      await intakeAction(
        args(request({ merchant: shop, quoteToken: "invalid" })),
      )
    ).status,
    400,
  );
  const rpc = await publicMcpAction(
    args(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      } as Record<string, string>),
    ),
  );
  assert.equal(rpc.status, 200);
  assert.deepEqual(
    (await rpc.json()).result.tools.map((tool: { name: string }) => tool.name),
    ["find_store", "start_return"],
  );
});

test("storefront entry carries order and item through OAuth without creating a return", async (t) => {
  installedStore(t);
  const entryUrl = new URL(
    `https://refund.test/start-return?merchant=${shop}&orderName=%231001&itemName=Snowboard`,
  );
  const entry = await startPage({
    request: new Request(entryUrl),
    params: {},
    context: {},
    url: entryUrl,
    pattern: "/start-return",
  });
  assert.ok(entry instanceof Response);
  assert.equal(entry.status, 302);
  const next = new URL(entry.headers.get("Location")!);
  let pending: { orderHint?: string; itemHint?: string } = {};
  mockDelegate(t, prisma.customerReturnSession, "deleteMany", async () => ({
    count: 0,
  }));
  mockDelegate(
    t,
    prisma.customerReturnSession,
    "create",
    async ({ data }: { data: typeof pending }) => {
      pending = data;
      return data;
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
  const login = new URL("https://refund.test/customer/login");
  login.searchParams.set("shop", shop);
  login.searchParams.set(
    "continuation",
    next.searchParams.get("continuation")!,
  );
  const response = await startCustomerLogin(new Request(login));
  assert.equal(response.status, 302);
  const authorization = new URL(response.headers.get("Location")!);
  assert.equal(
    authorization.searchParams.get("scope"),
    "openid customer-account-api:full",
  );
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(pending.orderHint, "#1001");
  assert.equal(pending.itemHint, "Snowboard");
  assert.ok(!response.headers.get("Location")!.includes("Snowboard"));
});
