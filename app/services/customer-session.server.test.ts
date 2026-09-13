import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import { agentFlowCookie } from "./agent-oauth-flow.server";
import { digest, randomToken } from "./customer-security.server";
import {
  finishCustomerLogin,
  startCustomerLogin,
} from "./customer-session.server";

process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_APP_URL = "https://refund.test";

function mockDelegate(
  t: TestContext,
  target: object,
  name: string,
  implementation: (...args: never[]) => unknown,
) {
  const original = Reflect.get(target, name);
  Reflect.set(target, name, t.mock.fn(implementation));
  t.after(() => Reflect.set(target, name, original));
}

test("assistant reconnects try a silent Shopify sign-in and fall back without an error", async (t) => {
  const shop = "example.myshopify.com";
  const records = new Map<string, Record<string, unknown>>();
  const browser = randomToken();
  const requestId = randomToken();
  mockDelegate(t, prisma.session, "findFirst", async () => ({
    id: "offline_example",
  }));
  mockDelegate(t, prisma.agentOAuthRequest, "findUnique", async () => ({
    id: digest(requestId),
    shop,
    status: "PENDING",
    expiresAt: new Date(Date.now() + 60_000),
    browserHash: digest(browser),
  }));
  mockDelegate(
    t,
    prisma.customerReturnSession,
    "findUnique",
    async ({ where }: { where: { id: string } }) => records.get(where.id) || null,
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
      authorization_endpoint: "https://shopify.com/authentication/1/oauth/authorize",
      token_endpoint: "https://shopify.com/authentication/1/oauth/token",
      jwks_uri: "https://shopify.com/authentication/1/.well-known/jwks.json",
    }),
  );
  const flowCookie = (await agentFlowCookie.serialize(browser)).split(";")[0];
  const start = (query: string) =>
    startCustomerLogin(
      new Request(`https://refund.test/customer/login?shop=${shop}&${query}`, {
        headers: { Cookie: flowCookie },
      }),
    );
  const prompt = (started: Response) =>
    new URL(started.headers.get("Location")!).searchParams.get("prompt");

  const silent = await start(`agentRequest=${requestId}&silent=1`);
  const interactive = await start(`agentRequest=${requestId}`);
  const portal = await start("silent=1");
  assert.equal(prompt(silent), "none");
  assert.equal(prompt(interactive), null);
  assert.equal(prompt(portal), null, "Portal sign-in never goes silent");

  const callback = (started: Response, search: string) =>
    finishCustomerLogin(
      new Request(
        `https://refund.test/customer/callback?state=${new URL(started.headers.get("Location")!).searchParams.get("state")}&${search}`,
        { headers: { Cookie: started.headers.get("Set-Cookie")!.split(";")[0] } },
      ),
    );
  assert.equal(
    (await callback(silent, "error=login_required")).headers.get("Location"),
    `/agent/authorize/${requestId}?silentTried=1`,
  );
  assert.equal(
    (await callback(interactive, "error=access_denied")).headers.get("Location"),
    `/agent/authorize/${requestId}?loginError=1`,
  );
});
