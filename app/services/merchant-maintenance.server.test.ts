import assert from "node:assert/strict";
import test from "node:test";

import prisma from "../db.server";
import {
  refreshInstalledMerchants,
  shopUpdateWebhookAction,
} from "./merchant-maintenance.server";

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
