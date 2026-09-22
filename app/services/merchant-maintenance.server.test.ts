import assert from "node:assert/strict";
import test from "node:test";

import { shopUpdateWebhookAction } from "./merchant-maintenance.server";

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
