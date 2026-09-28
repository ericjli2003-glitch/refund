import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { SignJWT, importPKCS8 } from "jose";
import type { ActionFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { action as wixWebhook } from "../app/routes/webhooks.wix";
import { connectionStore } from "../app/services/agent-access.server";
import { connectionEmailContext } from "../app/services/connection-email.server";
import { customerIdentityHash, seal } from "../app/services/customer-security.server";
import { findStore } from "../app/services/merchant-lookup.server";
import { resolveStore } from "../app/services/return-wording.server";
import { resetWixTokenCache } from "../app/services/wix/wix-client.server";

// A Wix site's whole life against the real schema, next to a Shopify store:
// install, directory search, a customer's store link, then uninstall. Only
// Wix's own API is faked.
const dbUrl = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(dbUrl.hostname) &&
    dbUrl.pathname === "/refund_ci",
  "Wix integration tests must use the isolated local refund_ci database",
);
process.env.SHOPIFY_APP_URL = "https://refund.test";
process.env.SHOPIFY_API_SECRET ||= "integration-secret";

const appId = randomUUID();
const instanceId = randomUUID();
const wixShop = `wix-${instanceId}`;
const shopifyShop = `wix-neighbour-${instanceId.slice(0, 8)}.myshopify.com`;
const siteName = `Fern & Frond ${instanceId.slice(0, 6)}`;
const email = `pat-${instanceId.slice(0, 6)}@example.com`;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.WIX_APP_ID = appId;
process.env.WIX_APP_SECRET = "integration-app-secret";
process.env.WIX_WEBHOOK_PUBLIC_KEY = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

async function deliver(eventType: string, data: Record<string, unknown>) {
  const key = await importPKCS8(
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    "RS256",
  );
  const body = await new SignJWT({
    data: JSON.stringify({ eventType, instanceId, data: JSON.stringify(data) }),
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .sign(key);
  return wixWebhook({
    request: new Request("https://refund.test/webhooks/wix", { method: "POST", body }),
  } as ActionFunctionArgs);
}

// Wix's side: a token while the app is installed, then the site's details.
let installed = true;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/oauth2/token"))
    return installed
      ? Response.json({ access_token: "integration-token", expires_in: 14_400 })
      : Response.json({ message: "App instance not found" }, { status: 400 });
  if (url.endsWith("/apps/v1/instance"))
    return Response.json({
      instance: { instanceId, appName: "Gooper.io", permissions: ["SCOPE.DC-STORES-MEGA.READ-STORES"] },
      site: {
        siteDisplayName: siteName,
        url: `https://jane-${instanceId.slice(0, 6)}.wixsite.com/ferns`,
        paymentCurrency: "EUR",
      },
    });
  throw new Error(`Unexpected request in integration test: ${url}`);
}) as typeof fetch;

test.after(async () => {
  globalThis.fetch = realFetch;
  resetWixTokenCache();
  await prisma.$transaction([
    prisma.agentConnection.deleteMany({ where: { clientId: `client-${instanceId}` } }),
    prisma.merchantDirectory.deleteMany({ where: { shop: { in: [wixShop, shopifyShop] } } }),
    prisma.storePolicy.deleteMany({ where: { shop: { in: [wixShop, shopifyShop] } } }),
    prisma.session.deleteMany({ where: { shop: shopifyShop } }),
    prisma.wixInstallation.deleteMany({ where: { shop: wixShop } }),
    prisma.webhookReceipt.deleteMany({ where: { shop: wixShop } }),
  ]);
  await prisma.$disconnect();
});

test("a Wix site installs, is found, links a customer, and is removed without touching Shopify", async () => {
  // A Shopify store that must come through the Wix removal untouched.
  await prisma.session.create({
    data: {
      id: `offline_${shopifyShop}`,
      shop: shopifyShop,
      state: "installed",
      isOnline: false,
      accessToken: "shpat_integration",
      scope: "read_orders",
    },
  });
  await prisma.storePolicy.create({ data: { shop: shopifyShop } });

  // Install.
  const installedResponse = await deliver("AppInstalled", { appId });
  assert.equal(installedResponse.status, 200);
  const install = await prisma.wixInstallation.findUniqueOrThrow({ where: { shop: wixShop } });
  assert.equal(install.instanceId, instanceId);
  assert.equal(install.currencyCode, "EUR");
  const policy = await prisma.storePolicy.findUniqueOrThrow({ where: { shop: wixShop } });
  assert.equal(policy.currencyCode, "EUR");
  assert.equal(policy.automaticRefundsEnabled, false);
  const profile = await prisma.merchantDirectory.findUniqueOrThrow({ where: { shop: wixShop } });
  assert.equal(profile.name, siteName);
  // A free Wix address is shared by the owner's sites, so the site is listed
  // under its own key rather than that host.
  assert.equal(profile.primaryDomain, wixShop);

  // Installing again (a new delivery) keeps the merchant's settings.
  await prisma.storePolicy.update({
    where: { shop: wixShop },
    data: { returnWindowDays: 45 },
  });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.deepEqual(await (await deliver("AppInstalled", { appId })).json(), {
    installed: true,
  });
  assert.equal(
    (await prisma.storePolicy.findUniqueOrThrow({ where: { shop: wixShop } })).returnWindowDays,
    45,
  );

  // Customers find it by name, next to Shopify stores.
  const found = (await findStore(siteName)) as { merchants: Array<{ shop: string }> };
  assert.deepEqual(found.merchants.map((merchant) => merchant.shop), [wixShop]);
  assert.equal(await resolveStore(siteName), wixShop);
  assert.equal(await resolveStore(wixShop.toUpperCase()), wixShop);

  // The merchant confirms return rules; a customer's confirmed email links.
  await prisma.storePolicy.update({
    where: { shop: wixShop },
    data: { returnRulesConfirmedAt: new Date(), verifiedStoreLinks: true },
  });
  const connection = await prisma.agentConnection.create({
    data: {
      clientId: `client-${instanceId}`,
      scopes: ["returns:read"],
      browserHash: "integration",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  await prisma.connectionEmail.create({
    data: {
      connectionId: connection.id,
      sealedEmail: seal(email, connectionEmailContext(connection.id)),
      emailHash: customerIdentityHash(`email:${email}`),
      source: "ONBOARDING",
    },
  });
  const access = await connectionStore(
    connection.id,
    wixShop,
    Date.now(),
    async (shop, address) => shop === wixShop && address === email,
  );
  assert.deepEqual(access.customerToken, { email });
  assert.equal(
    await prisma.agentStoreLink.count({ where: { connectionId: connection.id, shop: wixShop } }),
    1,
  );

  // A replayed removal while the app is still installed deletes nothing.
  assert.deepEqual(await (await deliver("AppRemoved", { appId })).json(), { ignored: true });
  assert.ok(await prisma.wixInstallation.findUnique({ where: { shop: wixShop } }));

  // Real removal: Wix no longer issues tokens, and the site's data goes.
  installed = false;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.deepEqual(await (await deliver("AppRemoved", { appId })).json(), { removed: true });
  for (const count of await Promise.all([
    prisma.wixInstallation.count({ where: { shop: wixShop } }),
    prisma.merchantDirectory.count({ where: { shop: wixShop } }),
    prisma.storePolicy.count({ where: { shop: wixShop } }),
    prisma.agentStoreLink.count({ where: { shop: wixShop } }),
    prisma.webhookReceipt.count({ where: { shop: wixShop } }),
  ]))
    assert.equal(count, 0);
  // The customer's own confirmed email stays with their connection.
  assert.equal(await prisma.connectionEmail.count({ where: { connectionId: connection.id } }), 1);
  // And the Shopify store is untouched.
  assert.equal(await prisma.session.count({ where: { shop: shopifyShop } }), 1);
  assert.equal(await prisma.storePolicy.count({ where: { shop: shopifyShop } }), 1);
  await assert.rejects(resolveStore(siteName), /No store called/);
});
