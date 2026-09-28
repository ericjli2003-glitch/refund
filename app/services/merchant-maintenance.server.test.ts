import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import prisma from "../db.server";
import {
  refreshInstalledMerchants,
  refreshShop,
  shopUpdateWebhookAction,
} from "./merchant-maintenance.server";
import { resetWixTokenCache, wixAccessToken } from "./wix/wix-client.server";

const SHOP = "pied-piper.myshopify.com";
const request = new Request("https://gooper.io/webhooks/shop/update", {
  method: "POST",
});

const webhook = (shop: string, topic: string) => async () => ({ shop, topic });

test("a shop/update webhook refreshes that shop's directory entry", async () => {
  const refreshed: string[] = [];
  const response = await shopUpdateWebhookAction(
    request,
    webhook(SHOP, "SHOP_UPDATE"),
    async (shop) => {
      refreshed.push(shop);
    },
  );

  // A rename reaches store search now, rather than at the next sweep.
  assert.deepEqual(refreshed, [SHOP]);
  assert.equal(response.status, 200);
});

test("only the shop's own topic triggers a refresh", async () => {
  const refreshed: string[] = [];
  for (const topic of ["SHOP_REDACT", "APP_UNINSTALLED", "ORDERS_UPDATED"]) {
    const response = await shopUpdateWebhookAction(
      request,
      webhook(SHOP, topic),
      async (shop) => {
        refreshed.push(shop);
      },
    );
    assert.equal(response.status, 200);
  }
  assert.deepEqual(refreshed, []);
});

test("a failed refresh is reported, so Shopify retries it", async () => {
  await assert.rejects(
    shopUpdateWebhookAction(request, webhook(SHOP, "SHOP_UPDATE"), async () => {
      throw new Error("Shopify is unreachable.");
    }),
    /Shopify is unreachable/,
  );
});

test("an unverified webhook never reaches the refresh", async () => {
  const refreshed: string[] = [];
  await assert.rejects(
    shopUpdateWebhookAction(
      request,
      async () => {
        throw new Error("Invalid webhook signature.");
      },
      async (shop) => {
        refreshed.push(shop);
      },
    ),
    /Invalid webhook signature/,
  );
  assert.deepEqual(refreshed, []);
});

test("the directory sweep refreshes Shopify stores and Wix sites alike", async (t) => {
  const wixShop = "wix-0f8a7c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
  const pages = {
    shopify: [[{ shop: SHOP }], []],
    wix: [[{ shop: wixShop }], []],
  };
  const replace = (target: object, name: string, value: unknown) => {
    const original = Reflect.get(target, name);
    Reflect.set(target, name, value);
    t.after(() => Reflect.set(target, name, original));
  };
  replace(prisma.session, "groupBy", async () => pages.shopify.shift() ?? []);
  replace(prisma.wixInstallation, "findMany", async () => pages.wix.shift() ?? []);
  const refreshed: string[] = [];
  const result = await refreshInstalledMerchants(async (shop) => {
    refreshed.push(shop);
    // One store's outage never stops the others.
    if (shop === SHOP) throw new Error("Shopify is down");
  });
  assert.deepEqual(refreshed, [SHOP, wixShop]);
  assert.deepEqual(result, { refreshed: 1, failed: 1 });
});

const WIX_INSTANCE = "0f8a7c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const WIX_SHOP = `wix-${WIX_INSTANCE}`;
const OTHER_WIX_INSTANCE = "11111111-2222-4333-8444-555555555555";

function wixSweep(t: TestContext, token: () => Response) {
  const saved = { ...process.env };
  process.env.WIX_APP_ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
  process.env.WIX_APP_SECRET = "app-secret";
  resetWixTokenCache();
  t.after(() => {
    process.env = saved;
    resetWixTokenCache();
  });
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    urls.push(String(input));
    if (String(input).endsWith("/oauth2/token")) return token();
    return Response.json({
      instance: { instanceId: WIX_INSTANCE, permissions: [] },
      site: { siteDisplayName: "Plant Shop", url: "https://jane.wixsite.com/plants", paymentCurrency: "EUR" },
    });
  });
  const mock = (target: object, name: string, implementation: (...args: never[]) => unknown) => {
    const original = Reflect.get(target, name);
    const fn = t.mock.fn(implementation);
    Reflect.set(target, name, fn);
    t.after(() => Reflect.set(target, name, original));
    return fn;
  };
  // Removal's batch is recorded, not run: Prisma's queries are lazy.
  const removal = mock(prisma, "$transaction", async (ops: unknown[]) => ops);
  mock(prisma.wixInstallation, "findUnique", async () => ({ instanceId: WIX_INSTANCE, permissions: [] }));
  const installUpdate = mock(prisma.wixInstallation, "updateMany", async () => ({ count: 1 }));
  mock(prisma.merchantDirectory, "findUnique", async () => null);
  mock(prisma.merchantDirectory, "updateMany", async () => ({ count: 1 }));
  return { urls, removal, installUpdate };
}

test("the sweep removes a Wix site that Wix says no longer has the app", async (t) => {
  for (const status of [400, 404])
    await t.test(String(status), async (st) => {
      let answer = () => Response.json({ access_token: "tok", expires_in: 14_400 });
      const sweep = wixSweep(st, () => answer());
      // Another site's token shows the app's own credentials work.
      await wixAccessToken(OTHER_WIX_INSTANCE);
      answer = () => Response.json({ message: "App instance not found" }, { status });
      await refreshShop(WIX_SHOP);
      assert.equal(sweep.removal.mock.callCount(), 1);
      assert.equal(sweep.installUpdate.mock.callCount(), 0);
    });
});

test("the sweep removes nothing until the app's credentials have worked", async (t) => {
  // With a misconfigured app every site could look gone; none is removed.
  const sweep = wixSweep(t, () => Response.json({ error: "invalid_client" }, { status: 400 }));
  await assert.rejects(refreshShop(WIX_SHOP));
  assert.equal(sweep.removal.mock.callCount(), 0);
});

test("the sweep never removes a Wix site over refused credentials or an outage", async (t) => {
  for (const status of [401, 403, 429, 500])
    await t.test(String(status), async (st) => {
      const sweep = wixSweep(st, () => Response.json({ message: "no" }, { status }));
      await assert.rejects(refreshShop(WIX_SHOP));
      assert.equal(sweep.removal.mock.callCount(), 0);
    });
});

test("the sweep refreshes a Wix site that still has the app", async (t) => {
  const sweep = wixSweep(t, () => Response.json({ access_token: "tok", expires_in: 14_400 }));
  await refreshShop(WIX_SHOP);
  assert.equal(sweep.removal.mock.callCount(), 0);
  assert.equal(sweep.installUpdate.mock.callCount(), 1);
  // One fresh token, reused for the site's details.
  assert.deepEqual(sweep.urls, [
    "https://www.wixapis.com/oauth2/token",
    "https://www.wixapis.com/apps/v1/instance",
  ]);
});
