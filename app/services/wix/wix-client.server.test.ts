import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import prisma from "../../db.server";
import { WixApiError } from "./wix-api.server";
import {
  createWixApi,
  resetWixTokenCache,
  wixAccessToken,
  wixApiFor,
  wixConfigured,
  wixInstanceGone,
} from "./wix-client.server";

const instanceId = "1b4f3c2a-9d8e-4f7a-8b6c-5d4e3f2a1b0c";

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

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit, calls: Call[]) => Response) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init, calls);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const tokenResponse = (token: string, expiresIn = 14_400) =>
  Response.json({ access_token: token, expires_in: expiresIn });

function setup(t: TestContext) {
  process.env.WIX_APP_ID = "app-id";
  process.env.WIX_APP_SECRET = "app-secret";
  resetWixTokenCache();
  t.after(resetWixTokenCache);
}

test("wixConfigured needs both the app ID and secret", (t) => {
  setup(t);
  assert.equal(wixConfigured(), true);
  const secret = process.env.WIX_APP_SECRET;
  process.env.WIX_APP_SECRET = " ";
  assert.equal(wixConfigured(), false);
  process.env.WIX_APP_SECRET = secret;
});

test("mints a client-credentials token and caches it until shortly before expiry", async (t) => {
  setup(t);
  let clock = 1_000_000;
  let minted = 0;
  const { fetch, calls } = fakeFetch(() => tokenResponse(`token-${++minted}`));
  const deps = { fetch, now: () => clock };

  assert.equal(await wixAccessToken(instanceId.toUpperCase(), deps), "token-1");
  assert.equal(calls[0].url, "https://www.wixapis.com/oauth2/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    grant_type: "client_credentials",
    client_id: "app-id",
    client_secret: "app-secret",
    instance_id: instanceId,
  });

  clock += 3 * 3_600_000;
  assert.equal(await wixAccessToken(instanceId, deps), "token-1");
  // Within five minutes of the four-hour expiry: renewed.
  clock += 56 * 60_000;
  assert.equal(await wixAccessToken(instanceId, deps), "token-2");
  assert.equal(calls.length, 2);
});

test("concurrent callers share one token request", async (t) => {
  setup(t);
  const { fetch, calls } = fakeFetch(() => tokenResponse("shared"));
  const tokens = await Promise.all([
    wixAccessToken(instanceId, { fetch }),
    wixAccessToken(instanceId, { fetch }),
    wixAccessToken(instanceId, { fetch }),
  ]);
  assert.deepEqual(tokens, ["shared", "shared", "shared"]);
  assert.equal(calls.length, 1);
});

test("refuses malformed instance IDs before calling Wix", async (t) => {
  setup(t);
  const { fetch, calls } = fakeFetch(() => tokenResponse("x"));
  await assert.rejects(wixAccessToken("../evil", { fetch }), /Invalid Wix app instance ID/);
  assert.equal(calls.length, 0);
});

test("token failures are WixApiErrors with Wix's code and no secrets", async (t) => {
  setup(t);
  const { fetch } = fakeFetch(() =>
    Response.json(
      { message: "Instance not found", details: { applicationError: { code: "APP_NOT_INSTALLED", description: "App is not installed" } } },
      { status: 404, headers: { "x-wix-request-id": "req-1" } },
    ),
  );
  const error = await wixAccessToken(instanceId, { fetch }).catch((caught) => caught);
  assert.ok(error instanceof WixApiError);
  assert.equal(error.status, 404);
  assert.equal(error.rejected, true);
  assert.equal(error.code, "APP_NOT_INSTALLED");
  assert.match(error.message, /App is not installed/);
  assert.match(error.message, /req-1/);
  assert.doesNotMatch(error.message, /app-secret/);
});

test("a token without expiry is refused", async (t) => {
  setup(t);
  const { fetch } = fakeFetch(() => Response.json({ access_token: "t" }));
  await assert.rejects(wixAccessToken(instanceId, { fetch }), WixApiError);
});

test("API calls send the raw token and JSON body to www.wixapis.com", async (t) => {
  setup(t);
  const { fetch, calls } = fakeFetch((url) =>
    url.endsWith("/oauth2/token") ? tokenResponse("tok") : Response.json({ ok: 1 }),
  );
  const api = createWixApi(instanceId, { fetch });
  const result = await api<{ ok: number }>("POST", "/ecom/v1/orders/search", { search: {} });
  assert.deepEqual(result, { ok: 1 });
  const call = calls[1];
  assert.equal(call.url, "https://www.wixapis.com/ecom/v1/orders/search");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "tok");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(call.init.body, JSON.stringify({ search: {} }));

  await api("GET", "/apps/v1/instance");
  const get = calls[2];
  assert.equal(get.init.body, undefined);
  assert.equal((get.init.headers as Record<string, string>)["Content-Type"], undefined);
});

test("empty responses resolve to undefined", async (t) => {
  setup(t);
  const { fetch } = fakeFetch((url) =>
    url.endsWith("/oauth2/token") ? tokenResponse("tok") : new Response(null, { status: 204 }),
  );
  assert.equal(await createWixApi(instanceId, { fetch })("DELETE", "/x/v1/thing"), undefined);
});

test("paths can never leave the Wix API host", async (t) => {
  setup(t);
  const { fetch, calls } = fakeFetch(() => tokenResponse("tok"));
  const api = createWixApi(instanceId, { fetch });
  for (const path of ["https://evil.test/x", "//evil.test/x", "x/y", "/a b"])
    await assert.rejects(api("GET", path), /Invalid Wix API path/, path);
  assert.equal(calls.length, 0);
});

test("a 401 retries once with a freshly minted token", async (t) => {
  setup(t);
  let minted = 0;
  const { fetch, calls } = fakeFetch((url, init) => {
    if (url.endsWith("/oauth2/token")) return tokenResponse(`tok-${++minted}`);
    const auth = (init.headers as Record<string, string>).Authorization;
    return auth === "tok-1"
      ? Response.json({ message: "expired" }, { status: 401 })
      : Response.json({ fine: true });
  });
  const api = createWixApi(instanceId, { fetch });
  assert.deepEqual(await api("GET", "/apps/v1/instance"), { fine: true });
  assert.equal(calls.length, 4);
  // The new token is cached for the next call.
  await api("GET", "/apps/v1/instance");
  assert.equal(calls.length, 5);
});

test("a second 401 is a rejected error, not a loop", async (t) => {
  setup(t);
  const { fetch, calls } = fakeFetch((url) =>
    url.endsWith("/oauth2/token")
      ? tokenResponse("tok")
      : Response.json({ message: "no" }, { status: 401 }),
  );
  const error = await createWixApi(instanceId, { fetch })("GET", "/apps/v1/instance").catch(
    (caught) => caught,
  );
  assert.ok(error instanceof WixApiError);
  assert.equal(error.status, 401);
  assert.equal(error.rejected, true);
  assert.equal(calls.length, 4);
});

test("maps Wix errors: 4xx rejected except 409/429; 5xx and timeouts are unknown outcomes", async (t) => {
  setup(t);
  for (const [status, rejected] of [
    [400, true],
    [403, true],
    [404, true],
    [409, false],
    [429, false],
    [500, false],
    [503, false],
  ] as const) {
    const { fetch } = fakeFetch((url) =>
      url.endsWith("/oauth2/token")
        ? tokenResponse("tok")
        : Response.json(
            {
              message: "Bad",
              details: { applicationError: { code: "PAYMENT_NOT_REFUNDABLE", description: "Payment can't be refunded" } },
            },
            { status },
          ),
    );
    const error = await createWixApi(instanceId, { fetch })("POST", "/ecom/v1/order-billing/refund-payments", {}).catch(
      (caught) => caught,
    );
    assert.ok(error instanceof WixApiError, String(status));
    assert.equal(error.status, status);
    assert.equal(error.rejected, rejected, String(status));
    assert.equal(error.code, "PAYMENT_NOT_REFUNDABLE");
    assert.match(error.message, /Payment can't be refunded/);
  }

  const { fetch } = fakeFetch((url) => {
    if (url.endsWith("/oauth2/token")) return tokenResponse("tok");
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  const timeout = await createWixApi(instanceId, { fetch })("POST", "/ecom/v1/order-billing/refund-payments", {}).catch(
    (caught) => caught,
  );
  assert.ok(timeout instanceof WixApiError);
  assert.equal(timeout.rejected, false);
  assert.match(timeout.message, /timed out/);
});

test("wixApiFor only serves installed Wix sites", async (t) => {
  setup(t);
  const find = mockDelegate(t, prisma.wixInstallation, "findUnique", async ({ where }: { where: { shop: string } }) =>
    where.shop === `wix-${instanceId}` ? { instanceId } : null,
  );
  await assert.rejects(wixApiFor("example.myshopify.com"), /Not a Wix store/);
  await assert.rejects(
    wixApiFor("wix-00000000-0000-4000-8000-000000000000"),
    /not installed on this Wix site/,
  );
  assert.equal(typeof (await wixApiFor(`wix-${instanceId}`)), "function");
  assert.equal(find.mock.callCount(), 2);
});

test("only a 400 or 404 token refusal means Wix no longer has the site", () => {
  for (const status of [400, 404])
    assert.equal(wixInstanceGone(new WixApiError("gone", status, true)), true, String(status));
  // Our own credentials refused, rate limits, outages and timeouts say
  // nothing about the site.
  for (const status of [401, 403, 409, 429, 500, 502, 504])
    assert.equal(wixInstanceGone(new WixApiError("x", status, status < 500)), false, String(status));
  assert.equal(wixInstanceGone(new Error("400")), false);
  assert.equal(wixInstanceGone(null), false);
});
