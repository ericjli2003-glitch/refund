import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import {
  AgentAccessError,
  StoreLinkRequiredError,
  agentResource,
  allStoresResource,
  authorizeAgent,
  authorizeConnection,
  connectionStore,
  issueApprovedAgentGrant,
  issueConnectionGrant,
  revokeAgentGrant,
  storeLinkAccess,
  storeLinkCustomerContext,
  storeLinkEmailContext,
} from "./agent-access.server";
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
  return { token, grant, find };
}

test("Refund grants keep Shopify tokens server-side and enforce store/resource/customer bindings", async (t) => {
  const { token, grant } = setup(t);
  assert.equal(agentResource(shop), resource);
  assert.deepEqual(
    await authorizeAgent(`Bearer ${token}`, shop, "returns:read", now),
    {
      shop,
      customerToken: "upstream-shopify-secret",
      clientId: "registered-client-a",
      sessionId: "session",
      customerSubjectHash: "customer-a",
      draftId: undefined,
    },
  );
  const invalid = (error: unknown) =>
    error instanceof AgentAccessError && error.code === "invalid_token";
  await assert.rejects(
    authorizeAgent(`Bearer ${token}`, "other.myshopify.com", undefined, now),
    invalid,
  );
  for (const patch of [
    { resource: "https://evil.test/mcp/example.myshopify.com" },
    { resource: `${resource}/` },
    { customerSubjectHash: "customer-b" },
    { revokedAt: new Date(now - 1) },
    { expiresAt: new Date(now) },
    { scopes: [] },
    { scopes: ["unknown:scope"] },
    { clientId: "" },
    { session: { ...session(), shop: "other.myshopify.com" } },
    { session: { ...session(), customerSubjectHash: "customer-b" } },
    { session: { ...session(), accessToken: "tampered" } },
    { session: { ...session(), expiresAt: new Date(now) } },
  ]) {
    const original = { ...grant };
    Object.assign(grant, patch);
    await assert.rejects(
      authorizeAgent(`Bearer ${token}`, shop, undefined, now),
      invalid,
    );
    Object.assign(grant, original);
  }
});

test("browser credentials, Shopify tokens and unknown Refund tokens cannot authorize remote access", async (t) => {
  const { find } = setup(t);
  for (const header of [
    null,
    "Bearer shopify-token",
    "Bearer eyJ.jwt.token",
    "Bearer cookie",
    "Bearer rfa_short",
  ]) {
    await assert.rejects(authorizeAgent(header, shop), AgentAccessError);
  }
  assert.equal(find.mock.callCount(), 0);
  await assert.rejects(
    authorizeAgent(`Bearer rfa_${randomToken()}`, shop),
    AgentAccessError,
  );
  assert.equal(find.mock.callCount(), 1);
});

test("read grants cannot quote or submit and an uninstalled store cannot use a grant", async (t) => {
  const { token } = setup(t);
  for (const scope of ["returns:quote", "returns:submit"] as const) {
    await assert.rejects(
      authorizeAgent(`Bearer ${token}`, shop, scope, now),
      (error: unknown) =>
        error instanceof AgentAccessError &&
        error.code === "insufficient_scope" &&
        error.requiredScope === scope,
    );
  }
  mockDelegate(t, prisma.session, "findFirst", async () => null);
  await assert.rejects(
    authorizeAgent(`Bearer ${token}`, shop, "returns:read", now),
    AgentAccessError,
  );
});

test("grant issuance requires approved exact scopes and stores only an expiring token hash", async (t) => {
  setup(t);
  mockDelegate(t, prisma.customerReturnSession, "findUnique", async () =>
    session(),
  );
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
    sessionId: "session",
    shop,
    resource,
    clientId: "client-a",
    scopes: ["returns:read"],
    customerApproved: true,
  };
  for (const patch of [
    { customerApproved: false },
    { customerApproved: undefined },
    { scopes: [] },
    { scopes: ["returns:read", "returns:read"] },
    { scopes: ["customer-account-api:full"] },
    { clientId: "" },
    { shop: "other.myshopify.com" },
    { resource: "https://evil.test/" },
  ])
    await assert.rejects(issueApprovedAgentGrant({ ...input, ...patch }, now));
  assert.equal(records.length, 0);
  const result = await issueApprovedAgentGrant(input, now);
  assert.match(result.accessToken, /^rfa_[A-Za-z0-9_-]{43}$/);
  assert.equal(records[0].tokenHash, digest(result.accessToken));
  assert.equal(result.expiresAt.getTime(), session().expiresAt.getTime());
  assert.deepEqual(result.scopes, ["returns:read"]);
  assert.ok(!JSON.stringify(records).includes(result.accessToken));
  assert.equal(records[0].refreshTokenHash, null);
  assert.ok(!JSON.stringify(records).includes("upstream-shopify-secret"));
  assert.ok(!JSON.stringify(result).includes("upstream-shopify-secret"));
  const refreshable = await issueApprovedAgentGrant(input, now, prisma, true);
  assert.match(refreshable.refreshToken!, /^rfr_[A-Za-z0-9_-]{43}$/);
  assert.equal(records[1].refreshTokenHash, digest(refreshable.refreshToken!));
  assert.equal(
    (records[1].refreshExpiresAt as Date).getTime(),
    session().expiresAt.getTime(),
  );
  assert.ok(!JSON.stringify(records).includes(refreshable.refreshToken!));
  await assert.rejects(
    issueApprovedAgentGrant(input, now + 120_000),
    AgentAccessError,
  );
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

test("an all-stores grant holds no Shopify credential and never opens a single-store endpoint", async (t) => {
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
    { resource },
    { scopes: ["returns:submit"] },
    { connectionId: "not-a-uuid" },
  ])
    await assert.rejects(issueConnectionGrant({ ...input, ...patch }, now));
  const issued = await issueConnectionGrant(input, now, prisma, true);
  assert.equal(records.length, 1);
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
  await assert.rejects(authorizeAgent(`Bearer ${token}`, shop, undefined, now), AgentAccessError);
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
