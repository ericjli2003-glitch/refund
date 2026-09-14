import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import {
  AgentAccessError,
  StoreLinkRequiredError,
  allStoresResource,
  authorizeConnection,
  connectionStore,
  isConnectionResource,
  issueConnectionGrant,
  revokeAgentGrant,
  storeLinkAccess,
  storeLinkCustomerContext,
  storeLinkEmailContext,
} from "./agent-access.server";
import { connectionEmailContext } from "./connection-email.server";
import {
  customerIdentityHash,
  digest,
  randomToken,
  refundSecrets,
  seal,
  unsealWithRotation,
} from "./customer-security.server";

const shop = "example.myshopify.com";
const resource = "https://refund.test/mcp/example.myshopify.com";
const now = Date.now();

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

function session() {
  return {
    id: "session",
    shop,
    accessToken: seal("upstream-shopify-secret", `session:${shop}`),
    customerSubjectHash: "customer-a",
    expiresAt: new Date(now + 120_000),
  };
}

function setup(t: TestContext) {
  process.env.SHOPIFY_APP_URL = "https://refund.test";
  process.env.SHOPIFY_API_SECRET ||= "test-secret";
  const token = `rfa_${randomToken()}`;
  const grant = {
    tokenHash: digest(token),
    sessionId: "session",
    shop,
    clientId: "registered-client-a",
    resource,
    customerSubjectHash: "customer-a",
    scopes: ["returns:read"],
    expiresAt: new Date(now + 60_000),
    revokedAt: null as Date | null,
    session: session(),
  };
  const find = mockDelegate(
    t,
    prisma.agentAccessGrant,
    "findUnique",
    async ({ where }: { where: { tokenHash: string } }) =>
      where.tokenHash === grant.tokenHash ? grant : null,
  );
  mockDelegate(t, prisma.session, "findFirst", async () => ({
    id: "offline_store",
  }));
  mockDelegate(t, prisma.connectionEmail, "findMany", async () => []);
  return { token, grant, find };
}

test("every Refund MCP address is the same network-wide connection resource", () => {
  process.env.SHOPIFY_APP_URL = "https://refund.test";
  assert.equal(isConnectionResource(allStoresResource()), true);
  assert.equal(isConnectionResource(resource), true);
  assert.equal(isConnectionResource(new URL(resource)), true);
  for (const value of [
    "https://evil.test/mcp/stores",
    "https://evil.test/mcp/example.myshopify.com",
    `${resource}/`,
    `${resource}?next=evil`,
    "https://refund.test/mcp/EXAMPLE.myshopify.com",
    "https://refund.test/mcp/not-a-store.com",
    "https://refund.test/mcp",
    "https://refund.test/mcp/",
    null,
  ])
    assert.equal(isConnectionResource(value), false, String(value));
});

test("browser credentials, Shopify tokens, unknown tokens and retired single-store grants open nothing", async (t) => {
  const { find, token } = setup(t);
  for (const header of [
    null,
    "Bearer shopify-token",
    "Bearer eyJ.jwt.token",
    "Bearer cookie",
    "Bearer rfa_short",
  ]) {
    await assert.rejects(authorizeConnection(header), AgentAccessError);
  }
  assert.equal(find.mock.callCount(), 0);
  await assert.rejects(
    authorizeConnection(`Bearer rfa_${randomToken()}`),
    AgentAccessError,
  );
  assert.equal(find.mock.callCount(), 1);
  // A grant from a retired single-store connection has no connection.
  await assert.rejects(authorizeConnection(`Bearer ${token}`, undefined, now), AgentAccessError);
});

test("revocation is restricted to the authenticated session's own grant or the customer's store link", async (t) => {
  setup(t);
  const update = mockDelegate(
    t,
    prisma.agentAccessGrant,
    "updateMany",
    async () => ({ count: 0 }),
  );
  mockDelegate(t, prisma.customerReturnSession, "findUnique", async () => ({
    shop,
    customerSubjectHash: "customer-a",
  }));
  const unlink = mockDelegate(
    t,
    prisma.agentStoreLink,
    "deleteMany",
    async () => ({ count: 1 }),
  );
  const publicId = "5b1d6a52-2f0e-4b5e-9c1a-7d8e6f4a3b21";
  assert.deepEqual(await revokeAgentGrant(publicId, "authenticated-session"), {
    count: 1,
  });
  assert.deepEqual(unlink.mock.calls[0].arguments[0], {
    where: { id: publicId, shop, customerSubjectHash: "customer-a" },
  });
  assert.deepEqual(update.mock.calls[0].arguments[0], {
    where: {
      publicId,
      sessionId: "authenticated-session",
      revokedAt: null,
    },
    data: {
      revokedAt: (
        update.mock.calls[0].arguments[0] as { data: { revokedAt: Date } }
      ).data.revokedAt,
    },
  });
});

test("a connection grant holds no Shopify credential, and a store's address opens the same connection", async (t) => {
  const { token, grant } = setup(t);
  const connectionId = "0d9b7c1e-5a4f-4e2b-8c3d-1f6a7b8c9d0e";
  const connection = {
    id: connectionId,
    clientId: "registered-client-a",
    scopes: ["returns:read", "returns:quote"],
    browserHash: "browser",
    expiresAt: new Date(now + 30 * 86_400_000),
    revokedAt: null as Date | null,
  };
  mockDelegate(t, prisma.agentConnection, "findUnique", async () => connection);
  const kept = mockDelegate(t, prisma.agentConnection, "update", async () => connection);
  const records: Record<string, unknown>[] = [];
  mockDelegate(
    t,
    prisma.agentAccessGrant,
    "create",
    async ({ data }: { data: Record<string, unknown> }) => {
      records.push(data);
      return data;
    },
  );
  const input = {
    connectionId,
    clientId: "registered-client-a",
    resource: allStoresResource(),
    scopes: ["returns:read"],
  };
  for (const patch of [
    { clientId: "other-client" },
    { resource: `${resource}/` },
    { resource: "https://evil.test/mcp/stores" },
    { scopes: ["returns:submit"] },
    { connectionId: "not-a-uuid" },
  ])
    await assert.rejects(issueConnectionGrant({ ...input, ...patch }, now));
  const issued = await issueConnectionGrant(input, now, prisma, true);
  assert.equal(records.length, 1);
  // A store's address saved from an older setup page connects the network too.
  await issueConnectionGrant({ ...input, resource }, now);
  assert.equal(records[1].resource, resource);
  assert.equal(records[0].connectionId, connectionId);
  assert.equal(records[0].sessionId, undefined);
  assert.equal(records[0].shop, undefined);
  assert.equal(issued.expiresAt.getTime(), now + 60 * 60_000);
  // Every grant, including a refresh, keeps the connection for another year.
  assert.equal(
    (records[0].refreshExpiresAt as Date).getTime(),
    now + 365 * 86_400_000,
  );
  assert.deepEqual(kept.mock.calls[0].arguments[0], {
    where: { id: connectionId },
    data: { expiresAt: new Date(now + 365 * 86_400_000) },
  });
  connection.revokedAt = new Date(now);
  await assert.rejects(issueConnectionGrant(input, now), AgentAccessError);
  connection.revokedAt = null;

  // The same token lookup, now shaped as a connection grant.
  Object.assign(grant, {
    connectionId,
    connection,
    resource: allStoresResource(),
    shop: null,
    session: null,
  });
  assert.deepEqual(await authorizeConnection(`Bearer ${token}`, "returns:read", now), {
    connectionId,
    clientId: "registered-client-a",
    scopes: ["returns:read"],
  });
  await assert.rejects(
    authorizeConnection(`Bearer ${token}`, "returns:submit", now),
    (error) =>
      error instanceof AgentAccessError && error.code === "insufficient_scope",
  );
  await assert.rejects(
    authorizeConnection(`Bearer ${token}`, "returns:read", connection.expiresAt.getTime()),
    AgentAccessError,
  );
});

test("a store link uses the live sign-in, then the verified customer only where the store allows it", async (t) => {
  setup(t);
  const connectionId = "0d9b7c1e-5a4f-4e2b-8c3d-1f6a7b8c9d0e";
  const customerId = "gid://shopify/Customer/42";
  const subject = customerIdentityHash(customerId);
  let link: unknown = null;
  let policy: unknown = null;
  let scope = "read_orders,read_returns";
  const find = mockDelegate(t, prisma.agentStoreLink, "findUnique", async () => link);
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => policy);
  mockDelegate(t, prisma.session, "findFirst", async () => ({
    id: "offline_store",
    scope,
  }));
  const used = mockDelegate(t, prisma.agentStoreLink, "updateMany", async () => ({
    count: 1,
  }));
  const expired = (error: unknown) =>
    error instanceof StoreLinkRequiredError && error.reason === "expired";

  await assert.rejects(
    connectionStore(connectionId, shop, now),
    (error) =>
      error instanceof StoreLinkRequiredError &&
      error.shop === shop &&
      error.reason === "not_linked",
  );
  assert.deepEqual(find.mock.calls[0].arguments[0], {
    where: { connectionId_shop: { connectionId, shop } },
    include: { session: true },
  });

  const base = {
    id: "link",
    connectionId,
    shop,
    customerSubjectHash: subject,
    sealedCustomerId: seal(customerId, storeLinkCustomerContext(connectionId, shop)),
    lastUsedAt: new Date(now - 2 * 3_600_000),
  };
  link = {
    ...base,
    session: { ...session(), customerSubjectHash: subject, draftId: "draft" },
  };
  assert.deepEqual(await connectionStore(connectionId, shop, now), {
    shop,
    customerToken: "upstream-shopify-secret",
    customerSubjectHash: subject,
    draftId: "draft",
  });
  assert.equal(used.mock.callCount(), 1);

  // The Shopify session ended: only a store that confirmed its return rules
  // keeps the link.
  link = { ...base, session: null };
  await assert.rejects(connectionStore(connectionId, shop, now), expired);
  policy = {
    verifiedStoreLinks: true,
    returnRulesConfirmedAt: new Date(now),
    finalSaleCollectionIds: [],
  };
  assert.deepEqual(await connectionStore(connectionId, shop, now), {
    shop,
    customerToken: { customerId },
    customerSubjectHash: subject,
    draftId: null,
  });
  for (const patch of [
    { returnRulesConfirmedAt: null },
    { verifiedStoreLinks: false },
    // Final-sale collections can't be checked without product access.
    { finalSaleCollectionIds: ["gid://shopify/Collection/1"] },
  ]) {
    policy = {
      verifiedStoreLinks: true,
      returnRulesConfirmedAt: new Date(now),
      finalSaleCollectionIds: [],
      ...patch,
    };
    await assert.rejects(connectionStore(connectionId, shop, now), expired);
  }
  scope = "read_orders,read_products,read_returns";
  assert.deepEqual(
    (await connectionStore(connectionId, shop, now)).customerToken,
    { customerId },
  );

  // A year without use ends the link, and a sealed ID for another customer or
  // connection never opens it.
  for (const patch of [
    { lastUsedAt: new Date(now - 366 * 86_400_000) },
    {
      sealedCustomerId: seal(
        "gid://shopify/Customer/43",
        storeLinkCustomerContext(connectionId, shop),
      ),
    },
    { sealedCustomerId: seal(customerId, storeLinkCustomerContext("other", shop)) },
  ]) {
    link = { ...base, session: null, ...patch };
    await assert.rejects(connectionStore(connectionId, shop, now), expired);
  }
});

test("one confirmed email reaches a store the connection never linked, with nothing for the customer to do", async (t) => {
  setup(t);
  const connectionId = "0d9b7c1e-5a4f-4e2b-8c3d-1f6a7b8c9d0e";
  const email = "pat@example.com";
  mockDelegate(t, prisma.agentStoreLink, "findUnique", async () => null);
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => ({
    verifiedStoreLinks: true,
    returnRulesConfirmedAt: new Date(now),
    finalSaleCollectionIds: [],
  }));
  mockDelegate(t, prisma.connectionEmail, "findMany", async () => [
    {
      id: "email-1",
      connectionId,
      sealedEmail: seal(email, connectionEmailContext(connectionId)),
      emailHash: customerIdentityHash(`email:${email}`),
      source: "ONBOARDING",
      sourceShop: null,
      confirmedAt: new Date(now),
    },
  ]);
  const links: Array<Record<string, unknown>> = [];
  mockDelegate(t, prisma.agentStoreLink, "upsert", async (args: never) => {
    const { create } = args as unknown as { create: Record<string, unknown> };
    links.push(create);
    return { id: "link", ...create, session: null };
  });
  const found = await connectionStore(connectionId, shop, now, async (_shop, address) => address === email);
  assert.deepEqual(found.customerToken, { email });
  assert.equal(links[0].connectionEmailId, "email-1");
  await assert.rejects(
    connectionStore(connectionId, shop, now, async () => false),
    (error) =>
      error instanceof StoreLinkRequiredError && error.reason === "email_not_found",
  );
});

test("an email-confirmed store link opens only for that email, and only where the store allows it", (t) => {
  setup(t);
  const connectionId = "0d9b7c1e-5a4f-4e2b-8c3d-1f6a7b8c9d0e";
  const email = "pat@example.com";
  const policy = {
    verifiedStoreLinks: true,
    returnRulesConfirmedAt: new Date(now),
    finalSaleCollectionIds: [],
  };
  const link = {
    connectionId,
    shop,
    verifiedBy: "EMAIL",
    customerSubjectHash: customerIdentityHash(`email:${email}`),
    sealedCustomerId: null,
    sealedEmail: seal(email, storeLinkEmailContext(connectionId, shop)),
    lastUsedAt: new Date(now),
    session: null,
  };
  assert.deepEqual(storeLinkAccess(link, policy, "read_orders", now), { email });
  assert.equal(storeLinkAccess(link, null, "read_orders", now), null);
  assert.equal(
    storeLinkAccess(
      { ...link, customerSubjectHash: customerIdentityHash("email:other@example.com") },
      policy,
      "read_orders",
      now,
    ),
    null,
  );
  assert.equal(
    storeLinkAccess(
      { ...link, sealedEmail: seal(email, storeLinkEmailContext("other", shop)) },
      policy,
      "read_orders",
      now,
    ),
    null,
  );
});

test("a verified link opened with a retired secret is re-sealed with the current one", async (t) => {
  setup(t);
  const connectionId = "0d9b7c1e-5a4f-4e2b-8c3d-1f6a7b8c9d0e";
  const customerId = "gid://shopify/Customer/42";
  const context = storeLinkCustomerContext(connectionId, shop);
  const original = {
    REFUND_SECRET: process.env.REFUND_SECRET,
    REFUND_PREVIOUS_SECRETS: process.env.REFUND_PREVIOUS_SECRETS,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(original))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const link = {
    id: "link",
    connectionId,
    shop,
    customerSubjectHash: customerIdentityHash(customerId),
    sealedCustomerId: seal(customerId, context),
    lastUsedAt: new Date(now),
    session: null,
  };
  process.env.REFUND_PREVIOUS_SECRETS = refundSecrets()[0];
  process.env.REFUND_SECRET = "rotated-refund-secret";
  mockDelegate(t, prisma.agentStoreLink, "findUnique", async () => link);
  mockDelegate(t, prisma.storePolicy, "findUnique", async () => ({
    verifiedStoreLinks: true,
    returnRulesConfirmedAt: new Date(now),
    finalSaleCollectionIds: [],
  }));
  const update = mockDelegate(t, prisma.agentStoreLink, "updateMany", async () => ({
    count: 1,
  }));
  assert.deepEqual(
    (await connectionStore(connectionId, shop, now)).customerToken,
    { customerId },
  );
  const { data } = update.mock.calls[0].arguments[0] as {
    data: { sealedCustomerId: string };
  };
  assert.deepEqual(unsealWithRotation(data.sealedCustomerId, context), {
    value: customerId,
    current: true,
  });
});

test("protected HTTP rejects cookie/upstream access and does not advertise Shopify as Refund's issuer", async (t) => {
  setup(t);
  const { action } = await import("../routes/mcp.$shop");
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network access");
  });
  for (const auth of [undefined, "Bearer upstream-shopify-token"]) {
    const headers: Record<string, string> = {
      Cookie: "__Host-refund_customer=browser-cookie",
      "Content-Type": "application/json",
    };
    if (auth) headers.Authorization = auth;
    const response = await action({
      request: new Request(resource, { method: "POST", headers, body: "{}" }),
      url: new URL(resource),
      pattern: "/mcp/:shop",
      params: { shop },
      context: {},
    });
    assert.equal(response.status, 401);
    assert.match(
      response.headers.get("WWW-Authenticate")!,
      /resource_metadata=/,
    );
    assert.match(response.headers.get("Cache-Control")!, /no-store/);
    assert.match(
      response.headers.get("Access-Control-Expose-Headers")!,
      /WWW-Authenticate/,
    );
  }
  const { loader } = await import("../routes/oauth.resource.$shop");
  const response = await loader({
    request: new Request("https://refund.test/oauth/resource/" + shop),
    url: new URL("https://refund.test/oauth/resource/" + shop),
    pattern: "/oauth/resource/:shop",
    params: { shop },
    context: {},
  });
  assert.equal(response.status, 503);
  const metadata = await response.json();
  assert.equal(metadata.error, "agent_authorization_not_configured");
  assert.equal(metadata.authorization_servers, undefined);
  assert.equal(upstream.mock.callCount(), 0);
});
