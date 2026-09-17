import assert from "node:assert/strict";
import test from "node:test";
import {
  fundedReturnsAction,
  fundedReturnsLoader,
  type AuthenticateAdmin,
} from "./funded-returns-admin.server";

// Ordering guarantees that need no database: the sandbox gate precedes Shopify
// authentication, and authentication precedes method, origin and any read.
function withEnv(env: Record<string, string>, run: () => Promise<void>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  return run().finally(() => {
    process.env = saved;
  });
}
const sandbox = {
  NODE_ENV: "test",
  GOOPER_FUNDED_RETURNS_SANDBOX: "1",
  SHOPIFY_APP_URL: "https://app.example.test",
};
function spyAuth(result: AuthenticateAdmin | "fail") {
  const calls: Request[] = [];
  const auth: AuthenticateAdmin = async (request) => {
    calls.push(request);
    if (result === "fail")
      throw new Response(null, { status: 302, headers: { Location: "/auth" } });
    return result(request);
  };
  return { auth, calls };
}
const signedIn: AuthenticateAdmin = async () => ({
  session: { shop: "unit.myshopify.com" },
});
const post = (headers: Record<string, string> = {}, body = "intent=deliver") =>
  new Request("https://app.example.test/app/funded-returns", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
const status = (error: unknown) =>
  error instanceof Response ? error.status : error;

test("funded returns admin: production answers 404 before authenticating", async () => {
  await withEnv(
    { ...sandbox, NODE_ENV: "production" },
    async () => {
      const { auth, calls } = spyAuth(signedIn);
      await assert.rejects(fundedReturnsAction(post(), auth), (e) => status(e) === 404);
      await assert.rejects(
        fundedReturnsLoader(new Request("https://app.example.test/app/funded-returns"), auth),
        (e) => status(e) === 404,
      );
      assert.equal(calls.length, 0);
    },
  );
  await withEnv({ ...sandbox, GOOPER_FUNDED_RETURNS_SANDBOX: "0" }, async () => {
    const { auth, calls } = spyAuth(signedIn);
    await assert.rejects(fundedReturnsAction(post(), auth), (e) => status(e) === 404);
    assert.equal(calls.length, 0);
  });
});

test("funded returns admin: an unauthenticated request stops at Shopify auth", async () => {
  await withEnv(sandbox, async () => {
    const { auth, calls } = spyAuth("fail");
    await assert.rejects(
      fundedReturnsAction(post({ Origin: "https://app.example.test" }), auth),
      (e) => status(e) === 302,
    );
    await assert.rejects(
      fundedReturnsLoader(new Request("https://app.example.test/app/funded-returns"), auth),
      (e) => status(e) === 302,
    );
    assert.equal(calls.length, 2);
  });
});

test("funded returns admin: authenticated requests still need POST and this app's origin", async () => {
  await withEnv(sandbox, async () => {
    const { auth, calls } = spyAuth(signedIn);
    await assert.rejects(
      fundedReturnsAction(
        new Request("https://app.example.test/app/funded-returns", { method: "PUT", body: "" }),
        auth,
      ),
      (e) => status(e) === 405,
    );
    for (const origin of [null, "https://evil.example", "http://app.example.test", "null"]) {
      await assert.rejects(
        fundedReturnsAction(post(origin ? { Origin: origin } : {}), auth),
        (e) => status(e) === 403,
        `origin ${origin}`,
      );
    }
    assert.equal(calls.length, 5, "Authentication ran before each rejection");
  });
});
