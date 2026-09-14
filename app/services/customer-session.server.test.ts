import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import { connectionEmailContext } from "./connection-email.server";
import {
  customerIdentityHash,
  digest,
  randomToken,
  seal,
} from "./customer-security.server";
import {
  finishCustomerLogin,
  startCustomerLogin,
} from "./customer-session.server";
import { connectionBrowserCookie } from "./store-link.server";

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

test("store links try a silent Shopify sign-in pre-filled with the confirmed email, and fall back without an error", async (t) => {
  const shop = "example.myshopify.com";
  const connectionId = "0d9b7c1e-5a4f-4e2b-8c3d-1f6a7b8c9d0e";
  const records = new Map<string, Record<string, unknown>>();
  const browser = randomToken();
  const requestId = randomToken();
  mockDelegate(t, prisma.session, "findFirst", async () => ({
    id: "offline_example",
  }));
  mockDelegate(t, prisma.agentStoreLinkRequest, "findUnique", async () => ({
    id: digest(requestId),
    connectionId,
    shop,
    csrfToken: "csrf",
    status: "PENDING",
    expiresAt: new Date(Date.now() + 60_000),
    connection: {
      clientId: "client",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      browserHash: digest(browser),
    },
  }));
  mockDelegate(t, prisma.connectionEmail, "findMany", async () => [
    {
      id: "email-1",
      connectionId,
      sealedEmail: seal("pat@example.com", connectionEmailContext(connectionId)),
      emailHash: customerIdentityHash("email:pat@example.com"),
      source: "ONBOARDING",
      sourceShop: null,
      confirmedAt: new Date(),
    },
  ]);
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
  const browserCookie = (await connectionBrowserCookie.serialize(browser)).split(";")[0];
  const start = (query: string) =>
    startCustomerLogin(
      new Request(`https://refund.test/customer/login?shop=${shop}&${query}`, {
        headers: { Cookie: browserCookie },
      }),
    );
  const params = (started: Response) =>
    new URL(started.headers.get("Location")!).searchParams;

  const silent = await start(`linkRequest=${requestId}&silent=1`);
  const interactive = await start(`linkRequest=${requestId}`);
  const portal = await start("silent=1");
  assert.equal(params(silent).get("prompt"), "none");
  assert.equal(params(interactive).get("prompt"), null);
  assert.equal(params(portal).get("prompt"), null, "Portal sign-in never goes silent");
  assert.equal(params(interactive).get("login_hint"), "pat@example.com");
  assert.equal(params(portal).get("login_hint"), null);

  const callback = (started: Response, search: string) =>
    finishCustomerLogin(
      new Request(
        `https://refund.test/customer/callback?state=${params(started).get("state")}&${search}`,
        { headers: { Cookie: started.headers.get("Set-Cookie")!.split(";")[0] } },
      ),
    );
  assert.equal(
    (await callback(silent, "error=login_required")).headers.get("Location"),
    `/connect/stores/link/${requestId}?silentTried=1`,
  );
  assert.equal(
    (await callback(interactive, "error=access_denied")).headers.get("Location"),
    `/connect/stores/link/${requestId}?loginError=1`,
  );
});
