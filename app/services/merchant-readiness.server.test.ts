import assert from "node:assert/strict";
import test from "node:test";
import prisma from "../db.server";
import { merchantReadiness } from "./merchant-readiness.server";

for (const [label, html, expected] of [
  ["password", '<form action="/password">', "password_protected"],
  ["absent", "<html>Store</html>", "embed_not_detected"],
  ["embed", '<script src="refund-site-tools.js"></script><div data-refund-site-tools></div>', "embed_markup_detected"],
]) {
  test(`readiness reports ${label} without promising authenticated readiness`, async (t) => {
    const original = prisma.storePolicy.findUnique;
    Reflect.set(prisma.storePolicy, "findUnique", async () => ({ automaticRefundsEnabled: true, returnWindowDays: 30, currencyCode: "USD" }));
    t.after(() => { Reflect.set(prisma.storePolicy, "findUnique", original); });
    const network = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("openid-configuration")) return Response.json({
        issuer: "https://shopify.com/authentication/1",
        authorization_endpoint: "https://shopify.com/authentication/1/oauth/authorize",
        token_endpoint: "https://shopify.com/authentication/1/oauth/token",
        jwks_uri: "https://shopify.com/authentication/1/.well-known/jwks.json",
      });
      if (url.endsWith("customer-account-api")) return Response.json({ graphql_api: "https://shopify.com/1/customer/api/2026-07/graphql" });
      return new Response(html);
    });
    const result = await merchantReadiness(`readiness-${label}.myshopify.com`);
    assert.equal(result.checks.storefront, expected);
    assert.equal(result.status, "preflight_passed");
    assert.equal(result.storefrontActivationOptional, true);
    assert.equal(result.checks.browserRegistration, "requires_browser_check");
    assert.equal(result.checks.customerAuthorization, "requires_customer_verification");
    const calls = network.mock.callCount();
    assert.deepEqual(await merchantReadiness(`readiness-${label}.myshopify.com`), result);
    assert.equal(network.mock.callCount(), calls);
  });
}
