import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import {
  AgentAccessError,
  agentResource,
  authorizeAgent,
  issueApprovedAgentGrant,
  revokeAgentGrant,
} from "./agent-access.server";
import { digest, randomToken, seal } from "./customer-security.server";

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
  assert.ok(!JSON.stringify(records).includes("upstream-shopify-secret"));
  assert.ok(!JSON.stringify(result).includes("upstream-shopify-secret"));
  await assert.rejects(
    issueApprovedAgentGrant(input, now + 120_000),
    AgentAccessError,
  );
});

test("revocation is restricted to the authenticated session's own grant", async (t) => {
  setup(t);
  const update = mockDelegate(
    t,
    prisma.agentAccessGrant,
    "updateMany",
    async () => ({ count: 0 }),
  );
  await revokeAgentGrant("token-hash", "authenticated-session");
  assert.deepEqual(update.mock.calls[0].arguments[0], {
    where: {
      tokenHash: "token-hash",
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
